package isl.snudursopi.fridge

import android.app.Application
import java.io.File

/**
 * Application entry.
 *
 * Order matters here. [RecoveryGuard.check] runs FIRST and does as little as
 * possible: it's what rolls a crash-looping build back to the last known-good
 * APK, so anything that could itself crash must come after it. Crash recovery
 * is installed next, so a fault during the rest of startup still schedules a
 * relaunch.
 *
 * Note this runs in EVERY process, including the motor SDK's separate
 * :motor_serial process. Crash recovery SHOULD run in both — a crash in the
 * serial process deserves recovering from too. But [RecoveryGuard.check] must
 * NOT: it counts boots of an unconfirmed build, and running once per process
 * would count two boots per launch, tripping the auto-revert at about 1.5 real
 * restarts instead of three.
 */
class FridgeApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (isMainProcess()) RecoveryGuard.check(this)
        CrashRecovery.install(this)
    }

    /**
     * True in the main app process. Read from /proc rather than
     * Application.getProcessName(), which is API 28+; the child process is named
     * "<package>:motor_serial", so an exact match identifies the main one.
     */
    private fun isMainProcess(): Boolean =
        try {
            val name = File("/proc/self/cmdline").readText().trim().trimEnd('\u0000')
            name == packageName
        } catch (t: Throwable) {
            // If we can't tell, assume main: skipping the check entirely would
            // disable auto-revert, which is worse than counting a boot twice.
            true
        }
}
