package isl.snudursopi.vending

import android.app.Application
import isl.snudursopi.shared.CrashRecovery
import isl.snudursopi.shared.Kiosk
import isl.snudursopi.shared.RecoveryGuard
import isl.snudursopi.shared.Watchdog
import isl.snudursopi.vending.update.UpdateResultReceiver

class VendingApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Tell the shared code which classes are this app's receivers — they keep their
        // names so alarms and installer callbacks from the previous build still resolve.
        Kiosk.init(
            this,
            Kiosk.Config(
                watchdogReceiver = WatchdogReceiver::class.java,
                updateResultReceiver = UpdateResultReceiver::class.java,
                updateResultAction = UpdateResultReceiver.ACTION,
                adminReceiver = KioskAdminReceiver::class.java,
            ),
        )
        // FIRST, before any of the app's real init: if the just-installed build is
        // crash-looping, roll back to the last known-good APK before we run its code.
        RecoveryGuard.check(this)
        // Self-healing: catch crashes and relaunch fast, and arm the watchdog that
        // brings the app back if it dies/wedges with nobody at the machine.
        CrashRecovery.install(this)
        Watchdog.schedule(this)
    }
}
