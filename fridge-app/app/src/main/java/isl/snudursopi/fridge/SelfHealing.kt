package isl.snudursopi.fridge

import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

private const val TAG = "SelfHealing"
private const val PREFS = "self_healing"

/**
 * Self-healing, ported from the coil kiosk where it's proven in production. The
 * whole point: an unattended fridge must come back on its own from a crash, a
 * wedge, or a power cut, because nobody is watching it.
 *
 * Three overlapping nets, deliberately redundant:
 *  - [CrashRecovery] — fast path, ~2s after an uncaught exception
 *  - [Watchdog]      — slow net, catches a wedged (not crashed) app
 *  - [BootReceiver]  — power-cut recovery
 *
 * Both automatic paths have loop guards, so a build that crashes on startup
 * stays DOWN AND STABLE rather than spinning — which keeps it reachable for an
 * OTA fix instead of thrashing the machine.
 */

/**
 * Relaunch the app via an AlarmManager activity PendingIntent. Going through an
 * alarm sidesteps Android's background-activity-start restrictions — a plain
 * startActivity() from a receiver is silently blocked on API 29+, which is the
 * kind of failure that looks like "the watchdog just doesn't work".
 */
internal fun scheduleAppRelaunch(ctx: Context, delayMs: Long, requestCode: Int) {
    val am = ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
    var flags = PendingIntent.FLAG_CANCEL_CURRENT
    if (Build.VERSION.SDK_INT >= 23) flags = flags or PendingIntent.FLAG_IMMUTABLE
    val pi = PendingIntent.getActivity(
        ctx,
        requestCode,
        Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        flags,
    )
    runCatching {
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + delayMs, pi)
    }.onFailure { Log.e(TAG, "relaunch schedule failed", it) }
}

/**
 * App liveness heartbeat. [MainActivity] stamps [markAlive] on resume and
 * periodically while foreground; the watchdog treats a stale stamp as
 * "app dead or wedged".
 */
object Liveness {
    private const val KEY_ALIVE = "lastAliveMs"

    fun markAlive(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putLong(KEY_ALIVE, System.currentTimeMillis()).apply()
    }

    fun isStale(ctx: Context, thresholdMs: Long): Boolean {
        val last = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_ALIVE, 0L)
        return last == 0L || System.currentTimeMillis() - last > thresholdMs
    }
}

/**
 * A self-rescheduling alarm that relaunches the app when its heartbeat goes
 * stale. Delivered to a manifest-registered receiver, so Android starts a fresh
 * process to handle it even if the app is completely dead — which is precisely
 * when it's needed.
 */
object Watchdog {
    const val ACTION = "isl.snudursopi.fridge.WATCHDOG_TICK"
    private const val INTERVAL_MS = 2L * 60L * 1000L     // tick ~every 2 min
    private const val STALE_MS = 3L * 60L * 1000L        // dead if no heartbeat in 3 min

    private const val KEY_WINDOW_START = "relaunchWindowStart"
    private const val KEY_COUNT = "relaunchCount"
    private const val WINDOW_MS = 10L * 60L * 1000L      // loop-guard window
    private const val MAX_RELAUNCHES = 5                 // per window

    fun schedule(ctx: Context) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        runCatching {
            am.setAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP,
                System.currentTimeMillis() + INTERVAL_MS,
                tickIntent(ctx),
            )
        }.onFailure { Log.e(TAG, "watchdog schedule failed", it) }
    }

    /** Called by [WatchdogReceiver] each tick: reschedule, then relaunch if stale. */
    fun onTick(ctx: Context) {
        schedule(ctx) // keep the chain going FIRST, before anything can throw
        if (!Liveness.isStale(ctx, STALE_MS)) return
        if (!allowRelaunch(ctx)) {
            Log.w(TAG, "app stale but relaunch backoff active — leaving down (reachable for OTA)")
            return
        }
        Log.w(TAG, "app stale → scheduling relaunch")
        scheduleAppRelaunch(ctx, 1_000L, requestCode = 7)
    }

    private fun allowRelaunch(ctx: Context): Boolean {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (now - p.getLong(KEY_WINDOW_START, 0L) > WINDOW_MS) {
            p.edit().putLong(KEY_WINDOW_START, now).putInt(KEY_COUNT, 1).apply()
            return true
        }
        val count = p.getInt(KEY_COUNT, 0) + 1
        p.edit().putInt(KEY_COUNT, count).apply()
        return count <= MAX_RELAUNCHES
    }

    private fun tickIntent(ctx: Context): PendingIntent {
        val i = Intent(ctx, WatchdogReceiver::class.java).setAction(ACTION)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= 23) flags = flags or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(ctx, 8, i, flags)
    }
}

/**
 * Crash recovery: an uncaught-exception handler relaunches in ~2s (fast path,
 * vs the watchdog's slower net). Rapid repeats grow the delay so a crash loop
 * can't spin. Installed once from [FridgeApp.onCreate].
 */
object CrashRecovery {
    private const val KEY_LAST_CRASH = "lastCrashMs"
    private const val KEY_STREAK = "crashStreak"
    private const val FAST_DELAY_MS = 2_000L
    private const val LOOP_DELAY_MS = 60_000L
    private const val LOOP_WINDOW_MS = 90_000L  // crashes closer than this count as a loop

    fun install(app: Application) {
        Thread.setDefaultUncaughtExceptionHandler { thread, err ->
            try {
                Log.e(TAG, "uncaught on ${thread.name}", err)
                scheduleRelaunch(app)
            } catch (t: Throwable) {
                Log.e(TAG, "crash-recovery failed", t)
            } finally {
                // Don't chain to the default handler — it would pop the system
                // crash dialog on a screen no one is watching. Kill cleanly so
                // the scheduled relaunch starts a fresh process.
                android.os.Process.killProcess(android.os.Process.myPid())
                kotlin.system.exitProcess(10)
            }
        }
    }

    private fun scheduleRelaunch(ctx: Context) {
        val now = System.currentTimeMillis()
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val streak = if (now - p.getLong(KEY_LAST_CRASH, 0L) < LOOP_WINDOW_MS)
            p.getInt(KEY_STREAK, 1) + 1 else 1
        p.edit().putLong(KEY_LAST_CRASH, now).putInt(KEY_STREAK, streak).apply()
        val delay = if (streak >= 3) LOOP_DELAY_MS else FAST_DELAY_MS
        Log.w(TAG, "scheduling relaunch in ${delay}ms (crash streak=$streak)")
        scheduleAppRelaunch(ctx, delay, requestCode = 9)
    }
}
