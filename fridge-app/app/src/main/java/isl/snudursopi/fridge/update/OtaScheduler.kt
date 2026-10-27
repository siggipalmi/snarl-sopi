package isl.snudursopi.fridge.update

import android.content.Context
import android.util.Log
import isl.snudursopi.fridge.RecoveryGuard
import isl.snudursopi.fridge.data.FridgeIdentityStore
import isl.snudursopi.fridge.data.backend.FridgeBackendConfig
import isl.snudursopi.fridge.data.backend.FridgeBackendHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Drives the periodic self-update check.
 *
 * Deliberately conservative, because the thing being replaced is the software on a
 * machine that takes people's money:
 *  - nothing before [FIRST_CHECK_DELAY_MS], which is comfortably after
 *    RecoveryGuard's healthy-confirmation window — we must not install a new build
 *    before the current one has proved itself, or a rollback has nothing to fall
 *    back to
 *  - never while a customer is mid-purchase
 *  - un-metered networks only, so we don't pull megabytes over a machine's SIM
 *  - unprovisioned machines don't check at all (no deviceCode, no manifest)
 *
 * All the real rollout safety — kill-switch, allowlist, sha256, per-build backoff,
 * auto-revert — lives in [AppUpdater] and [RecoveryGuard]. This class only decides
 * *when* to ask.
 */
class OtaScheduler(
    private val appContext: Context,
    private val identity: FridgeIdentityStore = FridgeIdentityStore(appContext),
    /** True while a customer is mid-purchase. */
    private val isSessionActive: () -> Boolean,
) {
    private val updater = AppUpdater(appContext)

    fun start(scope: CoroutineScope) {
        scope.launch {
            // Report a previous auto-revert before anything else — a silently
            // reverted machine among 46 is exactly what goes unnoticed.
            runCatching { reportRevertIfPending() }
                .onFailure { Log.w(TAG, "revert report failed: ${it.message}") }

            delay(FIRST_CHECK_DELAY_MS)
            while (isActive) {
                runCatching { checkOnce(manual = false) }
                    .onFailure { Log.w(TAG, "update check threw: ${it.message}") }
                // Retried every cycle, not just at startup: a machine that reverted
                // while offline would otherwise sit unreported until someone
                // restarted it.
                runCatching { reportRevertIfPending() }
                    .onFailure { Log.w(TAG, "revert report failed: ${it.message}") }
                delay(CHECK_INTERVAL_MS)
            }
        }
    }

    /**
     * Tell the backend this machine rejected a build, if it has one pending.
     *
     * The pending flag is persisted by [RecoveryGuard] at the moment of the
     * revert and only cleared once the backend accepts the report, so this
     * survives reboots and offline spells. The endpoint is idempotent per
     * rejected build, so re-sending is harmless.
     */
    private suspend fun reportRevertIfPending() {
        val rejected = RecoveryGuard.pendingRevertReport(appContext)
        if (rejected == 0) return

        val revertedTo = RecoveryGuard.revertedToCode(appContext)
        val at = RecoveryGuard.revertAtMs(appContext).takeIf { it > 0 }
            ?: System.currentTimeMillis()
        Log.e(
            TAG,
            "this machine AUTO-REVERTED build $rejected and is running $revertedTo — reporting it",
        )

        val deviceCode = identity.deviceCode()?.takeIf { it.isNotBlank() } ?: return
        val machineKey = identity.machineKey()?.takeIf { it.isNotBlank() } ?: return
        val http = FridgeBackendHttp(FridgeBackendConfig.BASE_URL, machineKey)
        http.postJson(
            "/api/v1/machines/$deviceCode/revert-report",
            mapOf(
                "rejectedVersionCode" to rejected,
                "revertedVersionCode" to revertedTo,
                "at" to at,
            ),
        )
        RecoveryGuard.markRevertReported(appContext, rejected)
        Log.i(TAG, "revert report accepted for build $rejected")
    }

    /**
     * One check. [manual] skips the network and idle gates (but never the
     * kill-switch, allowlist, checksum or block-list inside [AppUpdater]).
     */
    suspend fun checkOnce(manual: Boolean): UpdateResult {
        val deviceCode = identity.deviceCode()?.takeIf { it.isNotBlank() }
            ?: return UpdateResult.Halted.also {
                Log.i(TAG, "not provisioned — skipping update check")
            }
        val machineKey = identity.machineKey()?.takeIf { it.isNotBlank() }

        if (!manual) {
            if (isSessionActive()) {
                Log.i(TAG, "customer session in progress — deferring update check")
                return UpdateResult.UpToDate
            }
            if (!updater.isUnmetered()) {
                Log.i(TAG, "metered network — deferring update check")
                return UpdateResult.UpToDate
            }
        }

        val url = AppUpdater.manifestUrl(FridgeBackendConfig.BASE_URL, deviceCode)
        val result = updater.checkAndUpdate(url, machineKey, deviceCode, manual)
        Log.i(TAG, "update check: $result")
        return result
    }

    private companion object {
        const val TAG = "OtaScheduler"

        /**
         * Long enough that the current build has already been confirmed healthy by
         * RecoveryGuard before we consider replacing it.
         */
        const val FIRST_CHECK_DELAY_MS = 2L * 60L * 1000L

        /**
         * 30 minutes. Six hours was a bad first guess: publish a fix and a
         * machine could take most of a day to notice. The check is a few bytes
         * when there's nothing new, and the backend confirmed its last-seen
         * write is an upsert, so frequency costs no storage.
         */
        const val CHECK_INTERVAL_MS = 30L * 60L * 1000L
    }
}
