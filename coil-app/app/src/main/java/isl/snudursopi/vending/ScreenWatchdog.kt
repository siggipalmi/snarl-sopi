package isl.snudursopi.vending

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import android.view.PixelCopy

/**
 * Notices when the screen has died while the process lives, and restarts the app.
 *
 * The existing watchdog ([Watchdog] in SelfHealing.kt) watches a heartbeat posted from
 * the main thread. On 2026-10-27 both Grótta machines had been black and deaf since
 * Sunday: the heartbeat kept beating, the backend saw the machines online and got
 * answers to commands, and the glass showed nothing. Nothing checked what was on it.
 * This does, two ways, every [PERIOD_MS]:
 *
 *  1. A frame callback. If the one posted last period never ran, the main thread is
 *     not drawing. [FRAME_STRIKES] in a row → restart.
 *  2. A low-resolution copy of the window ([PixelCopy], so it includes any surface
 *     drawn on top of the UI, which is where a video player lives). Near-black and
 *     near-uniform [BLACK_STRIKES] times in a row → restart. Every screen this app
 *     has is cream or carries content, so a flat black window is never right.
 *
 * Restarts are rate-limited to one per [MIN_RESTART_GAP_MS]: if a future screen were
 * legitimately black, this logs and waits instead of looping. The restart itself is
 * the same process restart the dashboard's "restart app" command performs, which is
 * what brought both machines back.
 */
class ScreenWatchdog(
    private val activity: Activity,
    private val onDead: (reason: String) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var startedAt = 0L
    private var framePending = false
    private var frameStrikes = 0
    private var blackStrikes = 0

    fun start() {
        startedAt = System.currentTimeMillis()
        framePending = false; frameStrikes = 0; blackStrikes = 0
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, PERIOD_MS)
    }

    fun stop() {
        handler.removeCallbacks(tick)
    }

    private val tick = object : Runnable {
        override fun run() {
            // 1. Did last period's frame callback run?
            if (framePending) frameStrikes++ else frameStrikes = 0
            framePending = true
            Choreographer.getInstance().postFrameCallback { framePending = false }
            if (frameStrikes >= FRAME_STRIKES) {
                fire("no frame drawn for ${PERIOD_MS * FRAME_STRIKES / 1000}s")
                return
            }
            // 2. What does the window look like? (PixelCopy of a Window needs API 26.)
            val settled = System.currentTimeMillis() - startedAt > GRACE_MS
            if (settled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) sample()
            handler.postDelayed(this, PERIOD_MS)
        }
    }

    private fun sample() {
        val bmp = Bitmap.createBitmap(SAMPLE_W, SAMPLE_H, Bitmap.Config.ARGB_8888)
        try {
            PixelCopy.request(activity.window, bmp, { result ->
                if (result == PixelCopy.SUCCESS) judge(bmp) else bmp.recycle()
            }, handler)
        } catch (e: Exception) {
            // A window mid-teardown throws; that's not a dead screen.
            bmp.recycle()
        }
    }

    private fun judge(bmp: Bitmap) {
        val px = IntArray(bmp.width * bmp.height)
        bmp.getPixels(px, 0, bmp.width, 0, 0, bmp.width, bmp.height)
        bmp.recycle()
        var sum = 0L; var min = 255; var max = 0
        for (p in px) {
            val l = (Color.red(p) * 299 + Color.green(p) * 587 + Color.blue(p) * 114) / 1000
            sum += l; if (l < min) min = l; if (l > max) max = l
        }
        val mean = (sum / px.size).toInt()
        val black = mean < BLACK_MEAN_MAX && (max - min) < BLACK_SPREAD_MAX
        if (!black) {
            if (blackStrikes > 0) Log.i(TAG, "screen drawing again (mean luma $mean) after $blackStrikes black sample(s)")
            blackStrikes = 0
            return
        }
        blackStrikes++
        Log.w(TAG, "window is black (mean luma $mean, spread ${max - min}) — sample $blackStrikes/$BLACK_STRIKES")
        if (blackStrikes >= BLACK_STRIKES) fire("window black for ~${PERIOD_MS * BLACK_STRIKES / 1000}s")
    }

    private fun fire(reason: String) {
        stop()
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val last = prefs.getLong(KEY_LAST_RESTART, 0L)
        val now = System.currentTimeMillis()
        if (now - last < MIN_RESTART_GAP_MS) {
            Log.w(TAG, "$reason — but restarted ${(now - last) / 60_000} min ago; waiting rather than looping")
            frameStrikes = 0; blackStrikes = 0; framePending = false
            handler.postDelayed(tick, MIN_RESTART_GAP_MS - (now - last))
            return
        }
        prefs.edit().putLong(KEY_LAST_RESTART, now).apply()
        Log.e(TAG, "$reason — restarting the app")
        onDead(reason)
    }

    private companion object {
        const val TAG = "ScreenWatchdog"
        const val PREFS = "screen_watchdog"
        const val KEY_LAST_RESTART = "lastRestartMs"
        const val PERIOD_MS = 20_000L
        /** Don't judge the first minute after resume: the catalog is still loading. */
        const val GRACE_MS = 60_000L
        const val FRAME_STRIKES = 3          // 60 s without a frame
        const val BLACK_STRIKES = 4          // ~80 s of black
        const val BLACK_MEAN_MAX = 20        // of 255
        const val BLACK_SPREAD_MAX = 12      // near-uniform, not merely dark
        const val SAMPLE_W = 48
        const val SAMPLE_H = 80
        const val MIN_RESTART_GAP_MS = 30L * 60L * 1000L
    }
}
