package isl.snudursopi.fridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import isl.snudursopi.shared.Watchdog

/**
 * Receives the watchdog tick alarm. Manifest-registered, so Android starts a fresh
 * process to deliver it even if the app had died — exactly when a relaunch is needed.
 * Stays in this package under this name: the alarm set by the previous build is an
 * explicit Intent for it (see shared Kiosk.kt). All logic lives in [Watchdog.onTick].
 */
class WatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Watchdog.onTick(context)
    }
}
