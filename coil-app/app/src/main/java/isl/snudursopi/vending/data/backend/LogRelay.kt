package isl.snudursopi.vending.data.backend

import android.util.Log
import isl.snudursopi.vending.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.InputStreamReader
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import isl.snudursopi.shared.backend.LogCursor
import kotlin.coroutines.coroutineContext

private const val TAG = "LogRelay"

/**
 * Ships the app's own log to the backend every few minutes, so a fault can be read
 * from the dashboard instead of over adb.
 *
 * Copied from the fridge app, which has had this since September. Why the coil app
 * needs it: on 2026-10-27 both Grótta machines had been dark since Sunday. The
 * process was alive and answering commands, so nothing on the backend showed a
 * fault, and by the time someone was at the machines with adb, the on-device log
 * buffer had kept two days of system chatter and dropped every line the app itself
 * had written. The cause went unrecorded. With this, the app's lines land in the
 * backend's 7-day store as they are written.
 *
 * Reads the app's OWN logcat with `logcat -d` (an app may read its own output), so
 * nothing has to be rewritten to become visible. Outbound only.
 */
class LogRelay(
    private val http: AdminBackendHttp,
    private val deviceCode: String,
) {
    /**
     * The last line shipped. logcat has no cursor, so each flush re-reads from just
     * before it and drops what was already sent ([LogCursor]).
     */
    private var lastSeen: String = ""

    /** Runs for the life of the calling coroutine. */
    suspend fun run() {
        delay(30_000) // let the app finish booting; the interesting lines come after
        while (coroutineContext.isActive) {
            try {
                flushOnce()
            } catch (e: Exception) {
                Log.w(TAG, "relay failed: ${e.message}")
            }
            delay(INTERVAL_MS)
        }
    }

    private suspend fun flushOnce() {
        val lines = withContext(Dispatchers.IO) { freshLines() }
        // Posted in chunks the backend accepts (it keeps 400 per post), oldest first, and the
        // cursor moves after each one: a failed post leaves the rest for the next flush.
        for (chunk in lines.chunked(MAX_LINES)) {
            http.postJson(
                "/api/v1/machines/$deviceCode/logs",
                mapOf(
                    "kioskAppVersion" to BuildConfig.VERSION_NAME,
                    // The code too, so the header never pairs a new name with the old build's code.
                    "kioskAppVersionCode" to BuildConfig.VERSION_CODE,
                    "at" to System.currentTimeMillis(),
                    "lines" to chunk,
                ),
            )
            lastSeen = chunk.last()
        }
    }

    /**
     * Everything logged since [lastSeen], read so that nothing in between can be skipped.
     *
     * *** NOT `-t 400` (fridge, Blue Hotel, 2026-11-01; fixed there in 0.70.8). logd counts
     * `-t N` over all of the app's output before the tag filter, so the silenced motor
     * protocol and SDK lines used up the window, it stopped reaching the last shipped line,
     * and the lines in between were never read — about one per batch, with
     * `--------- beginning of main` in every batch as the sign. See [LogCursor]. The read is
     * by time now, from a minute before the last shipped line; a deep count read is the
     * fallback, and a gap that cannot be closed is said out loud.
     */
    private fun freshLines(): List<String> {
        if (lastSeen.isBlank()) {
            // First flush since start: the recent history, whatever it holds.
            return LogCursor.cap(LogCursor.after(readOwnLog(FIRST_READ.toString()), "").orEmpty(), MAX_PER_FLUSH, ::note)
        }
        LogCursor.sinceArg(lastSeen)?.let { since ->
            LogCursor.after(readOwnLog(since), lastSeen)?.let { return LogCursor.cap(it, MAX_PER_FLUSH, ::note) }
        }
        val deep = readOwnLog(DEEP_READ.toString())
        val fresh = LogCursor.after(deep, lastSeen) ?: run {
            // Gone even from the deep read: the ring buffer wrapped past it. Ship what is
            // there and mark the gap, rather than hiding it. Never a note on its own: the
            // cursor must always end on a real logcat line.
            val all = LogCursor.after(deep, "").orEmpty()
            if (all.isEmpty()) return emptyList()
            Log.w(TAG, "last shipped line not found; the buffer moved on")
            listOf(note("the last relayed line is no longer in the device log; lines before this may be missing")) + all
        }
        return LogCursor.cap(fresh, MAX_PER_FLUSH, ::note)
    }

    /** A line in `-v time` format, so the dashboard shows it as a warning in place. */
    private fun note(msg: String): String =
        SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.ROOT).format(Date()) +
            " W/$TAG(${android.os.Process.myPid()}): $msg"

    /**
     * Our own tags only, at the levels that carry diagnosis. The hardware tag is
     * WARN-only: its INFO traffic is the motor protocol, which would fill the
     * backend's window with bytes and push out the lines that matter.
     * [tail] is logcat's `-t`: a line count, or a time ("MM-DD hh:mm:ss.mmm").
     */
    private fun readOwnLog(tail: String): List<String> {
        val proc = ProcessBuilder(
            listOf(
                "logcat", "-d", "-v", "time", "-t", tail,
                "VendingViewModel:I", "ProxyClient:I", "AppUpdater:I", "SelfHealing:I",
                "ClockGuard:I", "ScreenWatchdog:I", "AdCache:I", "AdRegion:W", "Nav:I",
                "KioskManager:I", "RecoveryGuard:I", "RestartManager:I",
                "MarshallPay:I", "MarshallSerial:I", "WeimiHardware:W",
                "LogRelay:W", "AndroidRuntime:E", "*:S",
            ),
        ).redirectErrorStream(true).start()
        val all = BufferedReader(InputStreamReader(proc.inputStream)).use { it.readLines() }
        proc.waitFor()
        return all
    }

    private companion object {
        /** Five minutes: a fault is visible while it is happening, at a cost the SIM won't notice. */
        const val INTERVAL_MS = 5L * 60L * 1000L
        /** Lines per post — the backend keeps the same number from one request. */
        const val MAX_LINES = 400
        /** Cap per flush, so a log storm cannot mail the whole buffer over the SIM. */
        const val MAX_PER_FLUSH = 2000
        /** The first read after start: recent history, counted before the tag filter. */
        const val FIRST_READ = 2000
        /** Fallback when the time read misses the last shipped line; counted before the filter. */
        const val DEEP_READ = 20000
    }
}
