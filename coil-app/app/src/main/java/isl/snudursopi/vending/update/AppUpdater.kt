package isl.snudursopi.vending.update

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import isl.snudursopi.vending.BuildConfig
import isl.snudursopi.shared.RecoveryGuard
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Outcome of a self-update check, surfaced in Diagnostics / logs. */
sealed class UpdateResult {
    object UpToDate : UpdateResult()
    object Halted : UpdateResult()              // rollout disabled in the manifest
    object NotTargeted : UpdateResult()         // this machine isn't in the allowlist
    data class Installing(val versionName: String) : UpdateResult()
    data class NotDeviceOwner(val detail: String) : UpdateResult()
    data class Error(val detail: String) : UpdateResult()
}

/**
 * Self-update over the network with rollout safety.
 *
 * Manifest (all gate fields optional — an older manifest = "enabled, all machines"):
 * ```
 * { "targetVersionCode": 113, "versionName": "0.69.0",
 *   "apkUrl": "https://.../app-debug.apk", "sha256": "<hex, optional>",
 *   "rolloutEnabled": true,                 // KILL-SWITCH: false → nobody installs
 *   "deviceAllowlist": ["62160492"] }       // STAGING: empty/absent → all machines
 * ```
 *
 * Silent install needs Device Owner. The automatic path additionally only runs on
 * an un-metered (WiFi) network and only when the caller says the machine is idle,
 * and won't re-attempt the same target build within one process lifetime (so a bad
 * APK can't hammer). A manual check bypasses the WiFi/idle/backoff guards.
 */
class AppUpdater(private val context: Context) {

    // Targets already attempted this process — cleared on restart (a reboot retries
    // once). Manual checks ignore this.
    private val attempted = mutableSetOf<Int>()

    fun isDeviceOwner(): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return dpm.isDeviceOwnerApp(context.packageName)
    }

    /** True on an un-metered network (typically WiFi). Auto-update only runs on
     *  these so we never pull a multi-MB APK over metered cellular. */
    fun isUnmetered(): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    suspend fun checkAndUpdate(manifestUrl: String, machineKey: String?, deviceCode: String?, manual: Boolean): UpdateResult {
        return try {
            val raw = JSONObject(httpGetText(manifestUrl, machineKey))
            // The backend wraps the manifest as {"ok":true,"data":{...}}; the GitHub
            // file served it bare. Accept either — if there's a nested "data" object,
            // read the manifest from it, otherwise read the top level.
            val m = raw.optJSONObject("data") ?: raw
            val rolloutEnabled = m.optBoolean("rolloutEnabled", true)
            // The backend returns {"rolloutEnabled": false} when there's no release for
            // this machine (or rollout is halted). Treat that as "nothing to do" before
            // any target/apkUrl validation, so a no-release reply isn't an error.
            if (!rolloutEnabled) return UpdateResult.Halted

            val target = m.optInt("targetVersionCode", m.optInt("versionCode", -1))
            val name = m.optString("versionName", target.toString())
            val apkUrl = m.optString("apkUrl", "")
            val sha256 = m.optString("sha256", "").ifBlank { null }
            // Legacy GitHub manifests may carry an allowlist; the backend endpoint resolves
            // targeting server-side and omits it (absent/empty = this machine is included).
            val allow = mutableListOf<String>()
            m.optJSONArray("deviceAllowlist")?.let { for (i in 0 until it.length()) allow.add(it.getString(i)) }
            Log.i(TAG, "manifest target=$target name=$name installed=${BuildConfig.VERSION_CODE} manual=$manual")

            if (target < 0 || apkUrl.isBlank()) return UpdateResult.Error("manifest missing targetVersionCode/apkUrl")
            if (target <= BuildConfig.VERSION_CODE) return UpdateResult.UpToDate
            if (RecoveryGuard.isBlocked(context, target)) {
                Log.w(TAG, "target $target is blocked (previously auto-reverted bad build) — refusing")
                return UpdateResult.Halted
            }
            if (allow.isNotEmpty() && deviceCode != null && deviceCode !in allow) return UpdateResult.NotTargeted
            if (!isDeviceOwner()) return UpdateResult.NotDeviceOwner("not Device Owner; cannot install silently")
            if (!manual && target in attempted) {
                Log.i(TAG, "target $target already attempted this run — skipping")
                return UpdateResult.UpToDate
            }

            attempted.add(target)
            val apk = File(context.getExternalFilesDir(null), "update-$target.apk")
            downloadTo(apkUrl, apk)
            if (sha256 != null) {
                val actual = sha256Of(apk)
                if (!actual.equals(sha256, ignoreCase = true)) {
                    apk.delete()
                    return UpdateResult.Error("sha256 mismatch (want $sha256, got $actual)")
                }
            }
            RecoveryGuard.markPending(context, target)
            installApk(apk)
            UpdateResult.Installing(name)
        } catch (e: Exception) {
            Log.e(TAG, "update failed", e)
            UpdateResult.Error(e.message ?: e.toString())
        }
    }

    /** Hand the APK to PackageInstaller (see [installApkFile]). */
    private fun installApk(apk: File) = installApkFile(context, apk)

    private fun httpGetText(urlStr: String, machineKey: String?): String {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000; readTimeout = 15000; requestMethod = "GET"; instanceFollowRedirects = true
            if (machineKey != null) setRequestProperty("X-Machine-Key", machineKey)
            // Heartbeat: lets the backend record this machine's installed version + last check.
            setRequestProperty("X-App-Version-Code", BuildConfig.VERSION_CODE.toString())
        }
        try {
            if (conn.responseCode !in 200..299) throw RuntimeException("manifest GET ${conn.responseCode}")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally { conn.disconnect() }
    }

    private fun downloadTo(urlStr: String, dest: File) {
        val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20000; readTimeout = 60000; requestMethod = "GET"; instanceFollowRedirects = true
        }
        try {
            if (conn.responseCode !in 200..299) throw RuntimeException("apk GET ${conn.responseCode}")
            dest.outputStream().use { out -> conn.inputStream.use { it.copyTo(out) } }
            Log.i(TAG, "downloaded ${dest.length()} bytes -> ${dest.path}")
        } finally { conn.disconnect() }
    }

    private fun sha256Of(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { ins ->
            val buf = ByteArray(8192)
            var n = ins.read(buf)
            while (n >= 0) { md.update(buf, 0, n); n = ins.read(buf) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val TAG = "AppUpdater"

        /** One copy for both apps now: see shared ApkInstaller. */
        fun installApkFile(context: Context, apk: File, allowDowngrade: Boolean = false) =
            isl.snudursopi.shared.ApkInstaller.installApkFile(context, apk, allowDowngrade)

        /** Per-machine update manifest endpoint (backend, X-Machine-Key auth). The
         *  backend resolves rollout/targeting for this device and returns the manifest. */
        fun manifestUrl(baseUrl: String, deviceCode: String): String =
            "$baseUrl/api/v1/machines/$deviceCode/app-update"
    }
}
