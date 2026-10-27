package isl.snudursopi.shared

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import java.io.File

/** The updater's log tag, kept as "AppUpdater" so the log relay filter still catches it. */
const val UPDATE_LOG_TAG = "AppUpdater"

/**
 * Install an APK over this app through PackageInstaller. Silent (no prompt) only when
 * the app is Device Owner; the process is replaced on success. The outcome goes to the
 * app's UpdateResultReceiver ([Kiosk.updateResultReceiver]), handled by
 * [UpdateResultHandler].
 */
object ApkInstaller {
    /**
     * [allowDowngrade] is for auto-revert, i.e. installing an OLDER known-good build over
     * a crash-looping one. Set through the hidden install flag; a debuggable build permits
     * the downgrade even when the flag cannot be set.
     */
    fun installApkFile(context: Context, apk: File, allowDowngrade: Boolean = false) {
        val pi = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        if (allowDowngrade) {
            try {
                val f = PackageInstaller.SessionParams::class.java.getDeclaredField("installFlags")
                f.isAccessible = true
                f.setInt(params, f.getInt(params) or 0x00000080) // INSTALL_ALLOW_DOWNGRADE
            } catch (e: Exception) {
                Log.w(UPDATE_LOG_TAG, "allow-downgrade flag not set (debuggable build still permits it)", e)
            }
        }
        val sessionId = pi.createSession(params)
        pi.openSession(sessionId).use { s ->
            s.openWrite("base.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                s.fsync(out)
            }
            val intent = Intent(context, Kiosk.updateResultReceiver).setAction(Kiosk.updateResultAction)
            val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
            val pending = PendingIntent.getBroadcast(context, sessionId, intent, flags)
            s.commit(pending.intentSender)
        }
        Log.i(UPDATE_LOG_TAG, "commit() called (session $sessionId, downgrade=$allowDowngrade) — silent if Device Owner")
    }
}

/**
 * What the app's UpdateResultReceiver does with the PackageInstaller commit result.
 *
 * On a true Device Owner install this goes straight to [PackageInstaller.STATUS_SUCCESS]
 * with no prompt, and the process is then replaced. [PackageInstaller.STATUS_PENDING_USER_ACTION]
 * is the tell-tale that the SILENT PATH IS NOT IN EFFECT — the app isn't really acting
 * as Device Owner — so Android wants a human to confirm. We log that loudly and, purely
 * as a test convenience, launch the confirm dialog so the install can still finish.
 */
object UpdateResultHandler {
    fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)
        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> {
                Log.i(UPDATE_LOG_TAG, "install SUCCESS (silent) — re-arming watchdog + relaunching")
                // A silent install kills our process and does NOT restart it, and the
                // package replacement clears our pending watchdog alarm. So re-arm the
                // watchdog and schedule a relaunch here, or the freshly-installed build
                // never comes up on its own unless we happen to be the Home app.
                Watchdog.schedule(context)
                scheduleAppRelaunch(context, 4000L, requestCode = 11)
            }
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                Log.w(UPDATE_LOG_TAG, "install needs USER ACTION → NOT silent (Device Owner not effective)")
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
            else -> Log.e(UPDATE_LOG_TAG, "install FAILED status=$status msg=$msg")
        }
    }
}
