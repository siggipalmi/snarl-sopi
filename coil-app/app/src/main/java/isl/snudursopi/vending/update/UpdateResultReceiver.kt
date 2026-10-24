package isl.snudursopi.vending.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log

/**
 * Receives the PackageInstaller commit result.
 *
 * On a true Device Owner install this goes straight to [STATUS_SUCCESS] with no
 * prompt (and the process is then replaced). [STATUS_PENDING_USER_ACTION] is the
 * tell-tale that the **silent path is not in effect** — i.e. the app isn't really
 * acting as Device Owner — in which case Android wants a human to confirm. We log
 * that loudly and, only as a test convenience, launch the confirm dialog so the
 * install can still complete.
 */
class UpdateResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)
        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> {
                Log.i(AppUpdater.TAG, "install SUCCESS (silent) — re-arming watchdog + relaunching")
                // A silent install kills our process and does NOT restart it, and the
                // package replacement clears our pending watchdog alarm. So re-arm the
                // watchdog and schedule a relaunch here — otherwise the freshly-installed
                // version never comes up on its own (unless we happen to be the Home app).
                isl.snudursopi.vending.Watchdog.schedule(context)
                isl.snudursopi.vending.scheduleAppRelaunch(context, 4000L, requestCode = 11)
            }
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                Log.w(AppUpdater.TAG, "install needs USER ACTION → NOT silent (Device Owner not effective)")
                val confirm = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION") intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                }
                confirm?.let {
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { context.startActivity(it) }
                }
            }
            else ->
                Log.e(AppUpdater.TAG, "install FAILED status=$status msg=$msg")
        }
    }

    companion object {
        const val ACTION = "isl.snudursopi.vending.UPDATE_RESULT"
    }
}
