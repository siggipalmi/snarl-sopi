package isl.snudursopi.fridge

import android.app.Application
import android.content.Context
import android.util.Log
import isl.snudursopi.fridge.update.AppUpdater
import java.io.File

/**
 * Auto-revert safety net. A freshly-installed build must prove itself healthy —
 * UI up and stable for ~25s, see [confirmHealthy] — within a few boots, or the
 * machine rolls itself back to the last known-good APK. No operator, no network.
 *
 * Flow:
 *  1. Before an OTA install commits, [markPending] records the incoming versionCode.
 *  2. On every start, [check] (the first thing in Application.onCreate) counts boots
 *     of the pending build. Reaching [MAX_BOOTS] without a healthy confirmation means
 *     it's crash-looping ⇒ reinstall the saved known-good APK and block the bad
 *     versionCode so the backend can't immediately re-push it.
 *  3. When a build runs cleanly for ~25s, [confirmHealthy] clears pending, marks this
 *     version known-good, and saves its APK as the rollback target.
 *
 * A fix is always a HIGHER versionCode (forward-only), so it's never blocked and
 * installs normally over a blocked bad build.
 *
 * Limits (honest): this catches crash-on-launch / crash-loops / fails-to-start — the
 * catastrophic cases. It cannot tell a build that runs fine but is subtly broken
 * (loads, sells nothing, never crashes) from a healthy one; that stays the job of
 * canary staging + operator eyes + the kill-switch. A crash in Application.onCreate
 * *before* [check] runs is also out of reach — hence check() is first and minimal.
 */
object RecoveryGuard {
    private const val TAG = "RecoveryGuard"
    private const val PREFS = "recovery"
    private const val KEY_KNOWN_GOOD = "knownGoodCode"
    private const val KEY_PENDING = "pendingCode"
    private const val KEY_BOOTS = "pendingBootCount"
    private const val KEY_BLOCKED = "blockedCodes"          // comma-separated versionCodes
    private const val KEY_REVERT_ATTEMPTS = "revertAttempts"
    private const val KEY_UNREPORTED = "unreportedRevert"   // rejected code awaiting a backend report
    private const val KEY_UNREPORTED_AT = "unreportedRevertAt" // when that revert happened (epoch ms)
    private const val MAX_BOOTS = 3
    private const val MAX_REVERT_ATTEMPTS = 5               // stop retrying a revert that won't take
    private const val KNOWN_GOOD_APK = "known_good.apk"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun knownGoodFile(ctx: Context) = File(ctx.filesDir, KNOWN_GOOD_APK)

    /**
     * First thing in Application.onCreate. Counts boots of an unconfirmed build and
     * reverts if it's looping. Fully guarded — never throws into app startup.
     */
    fun check(app: Application) {
        try {
            val p = prefs(app)
            val cur = BuildConfig.VERSION_CODE
            val pending = p.getInt(KEY_PENDING, 0)

            // Running something other than the pending build (known-good after a revert,
            // or a newer fix) — the pending state is moot, clear it.
            if (pending != 0 && cur != pending) {
                p.edit().putInt(KEY_PENDING, 0).putInt(KEY_BOOTS, 0).putInt(KEY_REVERT_ATTEMPTS, 0).apply()
                return
            }
            if (pending == 0) return

            // cur == pending: this is the freshly-installed, not-yet-confirmed build.
            val boots = p.getInt(KEY_BOOTS, 0) + 1
            p.edit().putInt(KEY_BOOTS, boots).apply()
            Log.w(TAG, "unconfirmed build $pending boot #$boots (revert at $MAX_BOOTS)")
            if (boots < MAX_BOOTS) return

            val kg = p.getInt(KEY_KNOWN_GOOD, 0)
            val apk = knownGoodFile(app)
            if (kg == 0 || !apk.exists()) {
                Log.e(TAG, "crash-loop but no known-good APK to revert to — kill-switch/operator must handle")
                return
            }
            val attempts = p.getInt(KEY_REVERT_ATTEMPTS, 0) + 1
            if (attempts > MAX_REVERT_ATTEMPTS) {
                p.edit().putInt(KEY_REVERT_ATTEMPTS, attempts).apply()
                Log.e(TAG, "revert to $kg failed $MAX_REVERT_ATTEMPTS× — giving up (operator must handle)")
                return
            }
            Log.e(TAG, "crash-loop confirmed — reverting $pending → known-good $kg (attempt $attempts)")
            // Persist SYNCHRONOUSLY (.commit, not .apply): installApkFile kills this
            // process within a second, and an async write would be lost — which is
            // exactly why the revert-report note went missing before. Block the bad
            // build, record it as awaiting a report, and bump the attempt counter, all
            // to disk, before we hand off to the installer.
            p.edit()
                .putString(KEY_BLOCKED, (blockedSet(app) + pending).joinToString(","))
                .putInt(KEY_UNREPORTED, pending)
                // Stamp WHEN the revert happened, not when it gets reported: the
                // report may sit for hours if the machine is offline, and a
                // dashboard alert wants the moment of failure.
                .putLong(KEY_UNREPORTED_AT, System.currentTimeMillis())
                .putInt(KEY_REVERT_ATTEMPTS, attempts)
                .commit()
            try {
                AppUpdater.installApkFile(app, apk, allowDowngrade = true)
            } catch (e: Exception) {
                Log.e(TAG, "revert install failed", e)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "recovery check failed (swallowed)", t)
        }
    }

    /**
     * Called once the app has run cleanly for ~25s. Confirms the current build
     * healthy, clears the pending flag, and saves this APK as the rollback target.
     * Idempotent and safe to call repeatedly.
     */
    fun confirmHealthy(app: Application) {
        try {
            val p = prefs(app)
            val cur = BuildConfig.VERSION_CODE
            val alreadyGood = p.getInt(KEY_KNOWN_GOOD, 0) == cur && knownGoodFile(app).exists()
            p.edit()
                .putInt(KEY_PENDING, 0)
                .putInt(KEY_BOOTS, 0)
                .putInt(KEY_REVERT_ATTEMPTS, 0)
                .putInt(KEY_KNOWN_GOOD, cur)
                .apply()
            if (alreadyGood) return
            // Save this version's own APK as the known-good rollback target, off-thread.
            Thread {
                try {
                    val src = File(app.applicationInfo.sourceDir)
                    val dst = knownGoodFile(app)
                    val tmp = File(app.filesDir, "$KNOWN_GOOD_APK.tmp")
                    src.inputStream().use { i -> tmp.outputStream().use { o -> i.copyTo(o) } }
                    if (dst.exists()) dst.delete()
                    tmp.renameTo(dst)
                    Log.i(TAG, "saved known-good APK for $cur (${dst.length()} bytes)")
                } catch (e: Exception) {
                    Log.e(TAG, "failed to save known-good APK", e)
                }
            }.start()
        } catch (t: Throwable) {
            Log.e(TAG, "confirmHealthy failed (swallowed)", t)
        }
    }

    /** Record the incoming build as pending/unconfirmed, just before its install commits.
     *  Synchronous (.commit): if the new build crashes on launch, the crash handler can
     *  kill the process fast — the pending flag must be on disk first or boots won't count. */
    fun markPending(ctx: Context, code: Int) {
        prefs(ctx).edit().putInt(KEY_PENDING, code).putInt(KEY_BOOTS, 0).commit()
        Log.i(TAG, "marked pending: $code")
    }

    fun isBlocked(ctx: Context, code: Int): Boolean = blockedSet(ctx).contains(code)

    /** Rejected versionCode awaiting a backend revert-report (0 if none). */
    fun pendingRevertReport(ctx: Context): Int = prefs(ctx).getInt(KEY_UNREPORTED, 0)

    /** The known-good versionCode a revert fell back to. */
    fun revertedToCode(ctx: Context): Int = prefs(ctx).getInt(KEY_KNOWN_GOOD, 0)

    /** When the pending revert happened (epoch ms), or 0 if unknown. */
    fun revertAtMs(ctx: Context): Long = prefs(ctx).getLong(KEY_UNREPORTED_AT, 0L)

    /** Clear the pending report once the backend has accepted it. */
    fun markRevertReported(ctx: Context, code: Int) {
        if (prefs(ctx).getInt(KEY_UNREPORTED, 0) == code) {
            prefs(ctx).edit().putInt(KEY_UNREPORTED, 0).putLong(KEY_UNREPORTED_AT, 0L).apply()
        }
    }

    private fun blockedSet(ctx: Context): Set<Int> =
        prefs(ctx).getString(KEY_BLOCKED, "").orEmpty()
            .split(",").mapNotNull { it.trim().toIntOrNull() }.toSet()
}
