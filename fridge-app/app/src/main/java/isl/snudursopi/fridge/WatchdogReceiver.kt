package isl.snudursopi.fridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Receives the watchdog tick alarm. Because it's a manifest-registered receiver,
 * Android starts a fresh process to deliver this even if the app had died —
 * which is exactly when we need to relaunch. All logic lives in [Watchdog.onTick].
 */
class WatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Watchdog.onTick(context)
    }
}
