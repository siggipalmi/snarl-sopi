package isl.snudursopi.fridge.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import isl.snudursopi.fridge.Watchdog
import isl.snudursopi.fridge.scheduleAppRelaunch

/**
 * Receives the PackageInstaller commit result.
 *
 * On a true Device Owner install this goes straight to [PackageInstaller.STATUS_SUCCESS]
 * with no prompt, and the process is then replaced. [PackageInstaller.STATUS_PENDING_USER_ACTION]
 * is the tell-tale that the SILENT PATH IS NOT IN EFFECT — the app isn't really acting
 * as Device Owner — so Android wants a human to confirm. We log that loudly and, purely
 * as a test convenience, launch the confirm dialog so the install can still finish.
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
                // watchdog and schedule a relaunch here, or the freshly-installed build
                // never comes up on its own unless we happen to be the Home app.
                Watchdog.schedule(context)
                scheduleAppRelaunch(context, 4000L, requestCode = 11)
            }

            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                Log.w(
                    AppUpdater.TAG,
                    "install needs USER ACTION → NOT silent (Device Owner not effective)",
                )
                val confirm = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                }
                confirm?.let {
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { context.startActivity(it) }
                }
            }

            else -> Log.e(AppUpdater.TAG, "install FAILED status=$status msg=$msg")
        }
    }

    companion object {
        const val ACTION = "isl.snudursopi.fridge.UPDATE_RESULT"
    }
}
