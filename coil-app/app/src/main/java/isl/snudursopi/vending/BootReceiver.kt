package isl.snudursopi.vending

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Auto-launch the vending app when the tablet finishes booting. The
 * physical machine boots into our app rather than the Android launcher.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Watchdog.schedule(context) // arm the self-healing watchdog early
            val launch = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            context.startActivity(launch)
        }
    }
}
