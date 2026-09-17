package isl.snudursopi.fridge

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log

/**
 * True kiosk lockdown via Android Lock Task Mode.
 *
 * Lock Task Mode is escape-proof (no home, no recents, no status bar, no
 * back-out gesture) — but ONLY when this app is **Device Owner**, set once per
 * machine over ADB:
 *
 *   adb shell dpm set-device-owner isl.snudursopi.fridge/.KioskAdminReceiver
 *
 * Every method no-ops gracefully when not Device Owner, so the same build runs
 * on a dev tablet and an un-provisioned machine exactly as before — immersive
 * bars only, fully escapable. Lockdown "switches on" the moment a machine is
 * provisioned; there is no separate build to manage.
 *
 * The provisioning gate on our test unit is already clear (no device owner, no
 * accounts), so this can be enabled without a factory reset.
 */
object KioskManager {
    private const val TAG = "KioskManager"

    private fun dpm(context: Context): DevicePolicyManager =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    private fun adminComponent(context: Context): ComponentName =
        ComponentName(context, KioskAdminReceiver::class.java)

    fun isDeviceOwner(context: Context): Boolean =
        try {
            dpm(context).isDeviceOwnerApp(context.packageName)
        } catch (e: Exception) {
            false
        }

    /**
     * Enter lockdown: allowlist this app for lock task, hide all system UI, pin
     * us as the persistent Home app (so a power-cycle boots straight in and Home
     * does nothing), then start Lock Task Mode. No-op when not Device Owner;
     * safe to call repeatedly.
     */
    fun enableLockTask(activity: Activity) {
        val context = activity.applicationContext
        if (!isDeviceOwner(context)) return
        try {
            val dpm = dpm(context)
            val admin = adminComponent(context)
            dpm.setLockTaskPackages(admin, arrayOf(context.packageName))

            // System-UI suppression in lock task is API 28+. WM55 is API 30;
            // guard so the same build is safe on older dev devices (the call
            // would otherwise NoSuchMethodError, which try/catch won't catch).
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
            }

            // Become the default Home app. Clear any prior entry first so this
            // doesn't accumulate across launches.
            dpm.clearPackagePersistentPreferredActivities(admin, context.packageName)
            val homeFilter = IntentFilter(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                addCategory(Intent.CATEGORY_DEFAULT)
            }
            dpm.addPersistentPreferredActivity(
                admin,
                homeFilter,
                ComponentName(context, MainActivity::class.java),
            )

            activity.startLockTask()
            Log.i(TAG, "Lock task enabled (device owner)")
        } catch (e: Exception) {
            Log.w(TAG, "enableLockTask failed: ${e.message}")
        }
    }

    /**
     * Drop Lock Task Mode for maintenance. Safe to call when not in lock task or
     * not Device Owner (logged, no crash).
     */
    /**
     * Set when an operator deliberately leaves kiosk mode from the admin sheet.
     *
     * MainActivity re-asserts Lock Task on every resume, which is right for
     * customers — anything that surfaces over the app gets pulled back. But it
     * would also re-lock the moment a technician returned from Settings, making
     * the escape hatch pointless. This flag holds the door open until the app is
     * restarted, which is the natural end of a service visit.
     */
    @Volatile
    var suspendedByOperator: Boolean = false
        private set

    /**
     * *** SURRENDER DEVICE OWNER. THE ONLY THING THAT CAN DO THIS IS US.
     *
     * Android protects a Device Owner package completely: it cannot be
     * force-stopped, cleared, or uninstalled, from Settings or from adb. Every
     * route returns a SecurityException:
     *
     *   dpm remove-active-admin -> "Attempt to remove non-test admin"
     *   pm uninstall            -> DELETE_FAILED_DEVICE_POLICY_MANAGER
     *   pm clear                -> "Cannot clear data for a protected package"
     *
     * Without this call the only way to remove the app from a provisioned
     * machine is a factory reset — which on a placed fridge destroys Tailscale,
     * TeamViewer, wifi and every remote channel at once.
     *
     * *** THIS ALSO GIVES UP SILENT OTA. A machine that is no longer Device
     * Owner cannot install updates by itself; check_update returns
     * NotDeviceOwner and every future build needs someone on site. So this is
     * deliberately not on the admin sheet — it is reachable only through a
     * backend command, typed on purpose, by someone who knows what they are
     * giving up.
     */
    fun clearDeviceOwner(context: Context): String {
        if (!isDeviceOwner(context)) return "not Device Owner — nothing to clear"
        return try {
            dpm(context).clearDeviceOwnerApp(context.packageName)
            Log.w(TAG, "Device Owner CLEARED — silent OTA is gone until it is set again")
            "Device Owner cleared. The app can now be uninstalled by adb. " +
                "Silent OTA will NOT work until dpm set-device-owner is run again."
        } catch (e: Exception) {
            Log.w(TAG, "clearDeviceOwnerApp failed: ${e.message}")
            "failed: ${e.message}"
        }
    }

    /**
     * Reboot the board, for the dashboard's `restart_machine`.
     *
     * Device Owner only. `DevicePolicyManager.reboot` is the sanctioned route
     * and the only one we have: a Device Owner app cannot be force-stopped, and
     * nothing external can restart it either, which is why `restart_app` exists
     * at all. This is the heavier sibling — the whole board, not the process.
     *
     * It throws rather than returning false when a call is in progress. There
     * is no telephony on these boards, so that should never fire, but it is
     * caught with everything else rather than assumed away.
     *
     * The caller does NOT get a success path: if the reboot takes, this process
     * dies before it can report anything. The command result therefore has to
     * be sent BEFORE calling this, which is the opposite of every other command
     * and the reason it is not just another hardware call.
     */
    fun rebootDevice(context: Context): String {
        if (!isDeviceOwner(context)) {
            return "not Device Owner — cannot reboot the board from here"
        }
        return try {
            Log.w(TAG, "restart_machine — rebooting the board now")
            dpm(context).reboot(adminComponent(context))
            "reboot requested"
        } catch (e: Exception) {
            Log.w(TAG, "reboot failed: ${e.message}")
            "failed: ${e.message}"
        }
    }

    fun disableLockTask(activity: Activity) {
        suspendedByOperator = true
        try {
            activity.stopLockTask()
            Log.i(TAG, "Lock task stopped")
        } catch (e: Exception) {
            Log.w(TAG, "stopLockTask (likely not in lock task): ${e.message}")
        }
    }
}
