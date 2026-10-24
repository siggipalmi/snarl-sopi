package isl.snudursopi.vending

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
 * back-out gesture) — but ONLY when this app is **Device Owner**, set once
 * per machine over ADB:
 *
 *   adb shell dpm set-device-owner isl.snudursopi.vending/.KioskAdminReceiver
 *
 * Every method here no-ops gracefully when the app is not Device Owner, so
 * the same build runs on dev phones and un-provisioned machines exactly as
 * before — immersive bars only, fully escapable. Lockdown "switches on" the
 * moment a machine is provisioned; no separate build.
 *
 * Maintenance exit is PIN-gated: the existing admin flow calls
 * [disableLockTask] when the technician reveals the system bars and
 * [enableLockTask] again on the way out.
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
     * Enter lockdown. Allowlists this app for lock task, hides all system UI,
     * pins us as the persistent Home app (so a power-cycle boots straight in
     * and Home does nothing), then starts Lock Task Mode. No-op when not
     * Device Owner. Safe to call repeatedly (already-locked = no-op).
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

            // Make us the default Home app. Clear any prior entry first so this
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
     * Drop Lock Task Mode for PIN-gated maintenance. Safe to call when not in
     * lock task or not Device Owner (logged, no crash).
     */
    fun disableLockTask(activity: Activity) {
        try {
            activity.stopLockTask()
            Log.i(TAG, "Lock task stopped")
        } catch (e: Exception) {
            Log.w(TAG, "stopLockTask (likely not in lock task): ${e.message}")
        }
    }
}
