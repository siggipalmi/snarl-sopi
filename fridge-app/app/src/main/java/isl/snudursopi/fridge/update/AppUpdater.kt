package isl.snudursopi.fridge.update

import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.util.Log
import isl.snudursopi.fridge.BuildConfig
import isl.snudursopi.fridge.RecoveryGuard
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Outcome of a self-update check, surfaced in logs. */
sealed class UpdateResult {
    // toString is overridden because these land in logcat, and a bare `object`
    // prints as "UpdateResult$UpToDate@ca96045" — an identity hash tells an
    // operator nothing.
    object UpToDate : UpdateResult() { override fun toString() = "up to date" }
    object Halted : UpdateResult() { override fun toString() = "halted (no release for this machine)" }
    object NotTargeted : UpdateResult() { override fun toString() = "not in this rollout" }
    data class Installing(val versionName: String) : UpdateResult()
    data class NotDeviceOwner(val detail: String) : UpdateResult()
    data class Error(val detail: String) : UpdateResult()
}

/**
 * Self-update over the network, with rollout safety. Ported from the coil kiosk,
 * where it's proven across a live fleet.
 *
 * Manifest (all gate fields optional — an older manifest means "enabled, all machines"):
 * ```
 * { "targetVersionCode": 60, "versionName": "0.13.0",
 *   "apkUrl": "https://.../app-debug.apk", "sha256": "<hex, optional>",
 *   "rolloutEnabled": true,                  // KILL-SWITCH: false → nobody installs
 *   "deviceAllowlist": ["8626020618"] }      // STAGING: empty/absent → all machines
 * ```
 *
 * Silent install requires Device Owner. The automatic path additionally runs only on
 * an un-metered network and only when the caller says the machine is idle, and won't
 * re-attempt the same target build within one process lifetime — so a bad APK can't
 * hammer the fleet. A manual check bypasses the network/idle/backoff guards.
 */
class AppUpdater(private val context: Context) {

    // Targets already attempted this process — cleared on restart, so a reboot
    // retries once. Manual checks ignore this.
    private val attempted = mutableSetOf<Int>()

    fun isDeviceOwner(): Boolean =
        try {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            dpm.isDeviceOwnerApp(context.packageName)
        } catch (e: Exception) {
            false
        }

    /**
     * True on an un-metered network (typically WiFi). Automatic updates only run on
     * these, so we never pull a multi-megabyte APK over a metered SIM — these
     * machines sit on mobile data in some locations.
     */
    fun isUnmetered(): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    suspend fun checkAndUpdate(
        manifestUrl: String,
        machineKey: String?,
        deviceCode: String?,
        manual: Boolean,
    ): UpdateResult = withContext(Dispatchers.IO) {
        // The manifest fetch, the APK download and the sha256 are all BLOCKING.
        // Enforcing the dispatcher HERE rather than at the call site is
        // deliberate: OtaScheduler runs on lifecycleScope, which is Main, and
        // that produced NetworkOnMainThreadException on the very first real
        // check. A caller shouldn't have to know this is blocking.
        try {
            val raw = JSONObject(httpGetText(manifestUrl, machineKey))
            // The backend wraps responses as {"ok":true,"data":{...}}; a bare file
            // wouldn't. Accept either.
            val m = raw.optJSONObject("data") ?: raw

            // The backend returns rolloutEnabled:false when there's no release for
            // this machine, so treat it as "nothing to do" BEFORE validating the
            // target — a no-release reply isn't an error.
            if (!m.optBoolean("rolloutEnabled", true)) return@withContext UpdateResult.Halted

            val target = m.optInt("targetVersionCode", m.optInt("versionCode", -1))
            val name = m.optString("versionName", target.toString())
            val apkUrl = m.optString("apkUrl", "")
            val sha256 = m.optString("sha256", "").ifBlank { null }
            val allow = mutableListOf<String>()
            m.optJSONArray("deviceAllowlist")?.let {
                for (i in 0 until it.length()) allow.add(it.getString(i))
            }
            // Spell out which version belongs to whom. The old wording put a
            // version NAME next to a version CODE with nothing saying which was
            // the offer and which was the machine, and it was read backwards.
            Log.i(
                TAG,
                "backend offers $name (code $target) — this machine has code " +
                    "${BuildConfig.VERSION_CODE}${if (manual) " [manual check]" else ""}",
            )

            if (target < 0 || apkUrl.isBlank()) {
                return@withContext UpdateResult.Error("manifest missing targetVersionCode/apkUrl")
            }
            // *** RESOLVE THE APK URL AGAINST THE ORIGIN WE JUST AUTHENTICATED
            // AGAINST. This is the fix for the class of failure that sealed a
            // machine: the manifest used to hand back an APK on a DIFFERENT
            // hostname (admin.agvending.is), with its own certificate chain, and
            // the download failed on a trust store that was perfectly happy with
            // the API host. Anything a kiosk must fetch should come from the
            // origin it is already on.
            val downloadUrl = resolveApkUrl(apkUrl, manifestUrl)
            if (downloadUrl != apkUrl) Log.i(TAG, "apkUrl resolved to $downloadUrl")
            if (target <= BuildConfig.VERSION_CODE) return@withContext UpdateResult.UpToDate
            if (RecoveryGuard.isBlocked(context, target)) {
                Log.w(TAG, "target $target is blocked (previously auto-reverted) — refusing")
                return@withContext UpdateResult.Halted
            }
            if (allow.isNotEmpty() && deviceCode != null && deviceCode !in allow) {
                return@withContext UpdateResult.NotTargeted
            }
            if (!isDeviceOwner()) {
                return@withContext UpdateResult.NotDeviceOwner("not Device Owner; cannot install silently")
            }
            if (!manual && target in attempted) {
                Log.i(TAG, "target $target already attempted this run — skipping")
                return@withContext UpdateResult.UpToDate
            }

            attempted.add(target)
            val apk = File(context.getExternalFilesDir(null), "update-$target.apk")
            downloadTo(downloadUrl, apk)
            if (sha256 != null) {
                val actual = sha256Of(apk)
                if (!actual.equals(sha256, ignoreCase = true)) {
                    apk.delete()
                    return@withContext UpdateResult.Error("sha256 mismatch (want $sha256, got $actual)")
                }
            }
            RecoveryGuard.markPending(context, target)
            installApkFile(context, apk)
            UpdateResult.Installing(name)
        } catch (e: Exception) {
            Log.e(TAG, "update failed", e)
            UpdateResult.Error(e.message ?: e.toString())
        }
    }

    private fun httpGetText(urlStr: String, machineKey: String?): String {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 15000
            requestMethod = "GET"
            instanceFollowRedirects = true
            if (machineKey != null) setRequestProperty("X-Machine-Key", machineKey)
            // Doubles as a heartbeat: lets the backend record this machine's
            // installed version and last check time.
            setRequestProperty("X-App-Version-Code", BuildConfig.VERSION_CODE.toString())
        }
        try {
            if (conn.responseCode !in 200..299) {
                throw RuntimeException("manifest GET ${conn.responseCode}")
            }
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun downloadTo(urlStr: String, dest: File) {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20000
            readTimeout = 60000
            requestMethod = "GET"
            instanceFollowRedirects = true
        }
        try {
            if (conn.responseCode !in 200..299) throw RuntimeException("apk GET ${conn.responseCode}")
            dest.outputStream().use { out -> conn.inputStream.use { it.copyTo(out) } }
            Log.i(TAG, "downloaded ${dest.length()} bytes -> ${dest.path}")
        } finally {
            conn.disconnect()
        }
    }

    private fun sha256Of(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { ins ->
            val buf = ByteArray(8192)
            var n = ins.read(buf)
            while (n >= 0) {
                md.update(buf, 0, n)
                n = ins.read(buf)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val TAG = "AppUpdater"

        /**
         * Hand an APK to PackageInstaller. As Device Owner this installs silently and
         * the process is replaced on success; the outcome goes to [UpdateResultReceiver].
         *
         * [allowDowngrade] is for auto-revert, i.e. installing an OLDER known-good
         * build. Android blocks downgrades by default; debuggable builds permit them,
         * and we also set INSTALL_ALLOW_DOWNGRADE by reflection as belt and braces.
         */
        fun installApkFile(context: Context, apk: File, allowDowngrade: Boolean = false) {
            val pi = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(
                PackageInstaller.SessionParams.MODE_FULL_INSTALL,
            )
            params.setAppPackageName(context.packageName)
            if (allowDowngrade) {
                try {
                    val f = PackageInstaller.SessionParams::class.java
                        .getDeclaredField("installFlags")
                    f.isAccessible = true
                    f.setInt(params, f.getInt(params) or 0x00000080) // INSTALL_ALLOW_DOWNGRADE
                } catch (e: Exception) {
                    Log.w(TAG, "allow-downgrade flag not set (debuggable build still permits it)", e)
                }
            }
            val sessionId = pi.createSession(params)
            pi.openSession(sessionId).use { s ->
                s.openWrite("base.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out) }
                    s.fsync(out)
                }
                val intent = Intent(context, UpdateResultReceiver::class.java)
                    .setAction(UpdateResultReceiver.ACTION)
                val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                val pending = PendingIntent.getBroadcast(context, sessionId, intent, flags)
                s.commit(pending.intentSender)
            }
            Log.i(TAG, "commit() called (session $sessionId, downgrade=$allowDowngrade)")
        }

        /**
         * Per-machine update manifest endpoint. The backend resolves rollout and
         * targeting for this device and returns the manifest.
         */
        /**
         * *** ?apkUrl=relative ASKS THE BACKEND FOR A BARE PATH.
         *
         * The backend defaults to an absolute URL rebuilt on whatever origin the
         * request arrived on, which is already correct — but a relative path we
         * resolve ourselves means the two can never drift apart again, whatever
         * hostname a future machine is pointed at. [resolveApkUrl] handles either
         * form, so this build is correct against an older backend too.
         */
        fun manifestUrl(baseUrl: String, deviceCode: String): String =
            "$baseUrl/api/v1/machines/$deviceCode/app-update?apkUrl=relative"

        /**
         * A relative apkUrl resolves against the MANIFEST's origin — not a
         * constant — because the manifest is what we just authenticated against.
         * An absolute URL is returned untouched, so both backend modes work.
         */
        internal fun resolveApkUrl(apkUrl: String, manifestUrl: String): String {
            if (!apkUrl.startsWith("/")) return apkUrl
            val u = runCatching { URL(manifestUrl) }.getOrNull() ?: return apkUrl
            val port = if (u.port == -1) "" else ":${u.port}"
            return "${u.protocol}://${u.host}$port$apkUrl"
        }
    }
}
