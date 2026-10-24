package isl.snudursopi.vending

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Executes operator-issued restart commands delivered on the backend command
 * pull-queue (Channel B): types "restart_app" / "restart_machine", acknowledged
 * via POST .../commands/:id/result so the operator sees the outcome in the
 * dashboard.
 *
 * The only state this needs is a loop guard for restart_app, which kills the
 * process: we record the command id we acted on in prefs *before* restarting.
 * If the process dies before the ack lands, the backend re-delivers the same
 * id; on relaunch we recognise it, re-ack, and do NOT restart again.
 *
 * Persistence uses commit() (synchronous) deliberately — the id MUST be on disk
 * before System.exit, or the relaunched process would loop.
 *
 * (Config-payload restart timestamps — Channel A — are intentionally ignored;
 * we use the pull-queue only, to avoid a double restart.)
 */
class RestartManager(private val context: Context) {

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Record that we're about to act on this restart_app command and report
     * whether it's the first time we've seen it. true → caller should restart
     * now; false → already handled (a re-delivery after the process died before
     * the ack landed), so just re-ack and skip the restart.
     */
    fun shouldRestartForCommand(commandId: String): Boolean {
        if (prefs.getString(KEY_HANDLED_CMD, null) == commandId) return false
        prefs.edit().putString(KEY_HANDLED_CMD, commandId).commit()
        return true
    }

    /**
     * Full process restart — the cold-start path, which clears a wedged
     * process, a stuck board connection, a dead poll, or leaked memory. Does
     * not return.
     */
    fun performProcessRestart() {
        try {
            val launch = context.packageManager
                .getLaunchIntentForPackage(context.packageName)
                ?.apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK) }
            if (launch != null) {
                val pending = PendingIntent.getActivity(
                    context,
                    RESTART_REQUEST_CODE,
                    launch,
                    PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                // Relaunch shortly after we exit. Belt-and-suspenders: the app is
                // also the device Home, so it relaunches on process death anyway.
                am.set(AlarmManager.RTC, System.currentTimeMillis() + RELAUNCH_DELAY_MS, pending)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Relaunch scheduling failed: ${e.message} (Home will relaunch anyway)")
        }
        Runtime.getRuntime().exit(0)
    }

    companion object {
        private const val TAG = "RestartManager"
        private const val PREFS = "kiosk_restart"
        private const val KEY_HANDLED_CMD = "handled_restart_cmd_id"
        private const val RESTART_REQUEST_CODE = 90155
        private const val RELAUNCH_DELAY_MS = 300L
    }
}
