package isl.snudursopi.vending

import android.app.Application

class VendingApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // FIRST, before any of the app's real init: if the just-installed build is
        // crash-looping, roll back to the last known-good APK before we run its code.
        RecoveryGuard.check(this)
        // Self-healing: catch crashes and relaunch fast, and arm the watchdog that
        // brings the app back if it dies/wedges with nobody at the machine.
        CrashRecovery.install(this)
        Watchdog.schedule(this)
    }
}
