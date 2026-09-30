package isl.snudursopi.fridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
/**
 * Power-cut recovery: bring the fridge back up on its own after a reboot.
 *
 * Deliberately thin. Broadcast receivers run on the MAIN thread, so the serial
 * port grant does NOT belong here — it happens in MainActivity.onCreate, right
 * before anything touches the hardware. Launching the activity is enough to get
 * that ordering for free.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        Watchdog.schedule(context) // arm the self-healing net early

        val launch = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        context.startActivity(launch)
    }
}
