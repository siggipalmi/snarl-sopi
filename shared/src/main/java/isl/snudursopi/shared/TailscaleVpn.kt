package isl.snudursopi.shared

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import android.util.Log

/**
 * Tailscale as the tablet's always-on VPN, so remote adb survives a restart.
 *
 * 8626020606 (Gym800, Selfoss) was set up over Tailscale on 2026-10-30 and by the
 * next evening had no Tailscale address: the app was installed and signed in but
 * not running, so "adb on" answered with the local Wi-Fi address only and the
 * machine was out of reach until someone could stand at it. Android starts an
 * always-on VPN at boot and restarts it when it dies; nothing else does.
 *
 * Not lockdown: with lockdown, traffic stops whenever Tailscale is down, and the
 * machine would stop selling to keep a remote-support link. The backend never
 * goes through Tailscale.
 *
 * Called from MainActivity.onCreate, after [ClockGuard.enforceAutoTime]:
 *  1. Device Owner: setAlwaysOnVpnPackage. Takes effect at once — Android starts
 *     Tailscale now, which brings a signed-in machine back without a visit.
 *  2. Not Device Owner, WRITE_SECURE_SETTINGS granted: write the setting, which
 *     Android reads at the next boot.
 *  3. Neither, or Tailscale not installed: nothing; logged.
 * Never replaces a different always-on VPN someone chose on purpose.
 */
object TailscaleVpn {
    private const val TAG = "TailscaleVpn"
    const val PACKAGE = "com.tailscale.ipn"
    private const val SETTING_APP = "always_on_vpn_app"
    private const val SETTING_LOCKDOWN = "always_on_vpn_lockdown"

    fun installed(context: Context): Boolean =
        try {
            context.packageManager.getPackageInfo(PACKAGE, 0); true
        } catch (e: PackageManager.NameNotFoundException) {
            false
        }

    /**
     * The always-on VPN package, or null. Device Owner asks the policy service; otherwise the
     * setting, which apps can read up to Android 11 (the WM55) and not from 12.
     */
    fun current(context: Context): String? =
        try {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            if (dpm.isDeviceOwnerApp(context.packageName)) dpm.getAlwaysOnVpnPackage(Kiosk.adminComponent(context))
            else Settings.Secure.getString(context.contentResolver, SETTING_APP)
        } catch (e: Exception) {
            null
        }?.takeIf { it.isNotBlank() }

    fun ensureAlwaysOn(context: Context): String {
        val result = run {
            if (!installed(context)) return@run "Tailscale not installed — nothing to do"
            val now = current(context)
            if (now == PACKAGE) return@run "already always-on"
            if (now != null) return@run "left alone: always-on VPN is $now"
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            when {
                dpm.isDeviceOwnerApp(context.packageName) -> try {
                    dpm.setAlwaysOnVpnPackage(Kiosk.adminComponent(context), PACKAGE, false)
                    "set as device owner (starts now)"
                } catch (e: Exception) {
                    "device owner call failed: ${e.message}"
                }
                context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) ==
                    PackageManager.PERMISSION_GRANTED -> try {
                    Settings.Secure.putString(context.contentResolver, SETTING_APP, PACKAGE)
                    Settings.Secure.putInt(context.contentResolver, SETTING_LOCKDOWN, 0)
                    "set via WRITE_SECURE_SETTINGS (from the next boot)"
                } catch (e: Exception) {
                    "settings write failed: ${e.message}"
                }
                else -> "cannot set: not device owner, WRITE_SECURE_SETTINGS not granted"
            }
        }
        Log.i(TAG, "always-on VPN: $result · now ${current(context) ?: "none"}")
        return result
    }
}
