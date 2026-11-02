package isl.snudursopi.fridge.data.backend

import android.util.Log
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import isl.snudursopi.fridge.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.BufferedReader
import java.io.InputStreamReader
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import isl.snudursopi.shared.backend.LogCursor

private const val TAG = "LogRelay"

/**
 * Ships the machine's own log to the backend so a fault can be diagnosed from a
 * desk instead of a garage.
 *
 * *** WHY THIS EXISTS. The machine is in a hostel lobby. adb needs the local
 * network, `adb tcpip` does not survive a reboot on this board, and Android 11's
 * wireless debugging uses a port that changes every restart — so there is no
 * durable shell. Every fault so far has been diagnosed from logcat, and without
 * this the answer to "why is the price tag not updating" is a drive across town.
 *
 * *** HOW, AND WHY NOT AN INTERCEPTOR. Rather than routing every call site
 * through a wrapper, this reads the app's OWN logcat with `logcat -d`. An app is
 * permitted to read its own output, and it means nothing has to be rewritten to
 * be visible — including the SDK's frames and anything added in future. The
 * alternative would have touched hundreds of lines and still missed whatever
 * nobody remembered to wrap.
 *
 * Outbound only. No listening port, nothing to secure, works through the
 * hostel's NAT like any other request.
 */
class LogRelay(
    private val http: FridgeBackendHttp,
    private val deviceCode: String,
) {
    private val mapper = jacksonObjectMapper()

    /**
     * The last line we shipped. logcat has no cursor, so we re-read the buffer
     * from just before it and drop anything we have already sent ([LogCursor]).
     * The alternative is a persistent read process that dies with the app.
     */
    private var lastSeen: String = ""

    fun start(scope: CoroutineScope) {
        scope.launch(Dispatchers.IO) {
            // Let the app finish booting; the interesting lines come after.
            delay(30_000)
            while (isActive) {
                runCatching { flushOnce() }
                    .onFailure { Log.w(TAG, "relay failed: ${it.message}") }
                delay(INTERVAL_MS)
            }
        }
    }

    private suspend fun flushOnce() {
        val lines = freshLines()
        // Posted in chunks the backend accepts (it keeps 400 per post), oldest first, and the
        // cursor moves after each one: a failed post leaves the rest for the next flush.
        for (chunk in lines.chunked(MAX_LINES)) {
            val body = mapper.writeValueAsString(
                mapOf(
                    "kioskAppVersion" to isl.snudursopi.shared.AppVersion.name,
                    // The code too, so the header never pairs a new name with the old build's code.
                    "kioskAppVersionCode" to isl.snudursopi.shared.AppVersion.code,
                    "at" to System.currentTimeMillis(),
                    "lines" to chunk,
                ),
            )
            http.postRawJson("/api/v1/machines/$deviceCode/logs", body)
            lastSeen = chunk.last()
        }
    }

    /**
     * Everything logged since [lastSeen], read so that nothing in between can be skipped.
     *
     * *** NOT `-t 400` (lost a line per batch on Blue Hotel, 2026-11-01). logd counts `-t N`
     * over all of the app's output before the tag filter, so the silenced tray-weight and
     * poll lines used up the window and it no longer reached back to the last shipped line.
     * See [LogCursor] for the whole story. The read is by time now, from a minute before the
     * last shipped line; a deep count read is the fallback when that misses it (clock moved
     * back, first minute of the day), and a gap that cannot be closed is said out loud.
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
            // there and mark the gap, rather than hiding it.
            // Never a note on its own: the cursor must always end on a real logcat line.
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
     * Our own tags only. Deliberately not the whole buffer: the system is noisy,
     * and a fridge's log has no business carrying other apps' output to a server.
     * [tail] is logcat's `-t`: a line count, or a time ("MM-DD hh:mm:ss.mmm").
     */
    private fun readOwnLog(tail: String): List<String> {
        val proc = ProcessBuilder(
            listOf(
                "logcat", "-d", "-v", "time", "-t", tail,
                // *** MotorFridgeHW AT WARN, NOT INFO, AND FridgePoll SILENCED.
                //
                // The tray-weight line fires every 7-10 seconds and carries 16
                // values. At INFO it was ~90% of every batch, which meant the
                // backend's 4000-line window held under an hour of history and a
                // fault from the evening was already gone by morning. The
                // interesting hardware lines — board handshake, timeouts, price
                // tag writes, the decoded cabinet temperature — are all W or E,
                // or logged by other tags, so nothing diagnostic is lost.
                //
                // Tray weights remain in the on-device buffer at full rate for
                // anyone with adb; this only changes what we ship.
                "FridgeBoot:I", "FridgeBackend:I", "FridgeFlow:I", "FridgeDoor:I",
                "FridgeSettlement:I", "FridgeComplaint:I",
                // OtaScheduler carries each update check's outcome. Without it the
                // relay showed the backend's offer but not what the machine did
                // with it (2026-10-01: "NotDeviceOwner" was visible only over adb).
                "PriceTagSync:I", "AppUpdater:I", "OtaScheduler:I", "RecoveryGuard:I",
                "AdminClock:I", "SelfHealing:I", "CommandRunner:I", "PaymentWatch:I", "FridgeLights:I", "FridgeReceipt:I",
                // *** THE PAYMENT LINK MUST BE VISIBLE HERE.
                //
                // These were missing until 2026-09-04, when the Blue Hotel
                // machine's Nayax reported V00 (no host) and the relayed log
                // could not say whether our app had opened ttyS4 at all — the
                // one question that mattered, invisible on the only channel we
                // had to that machine. A payment link that cannot be diagnosed
                // remotely is a machine that cannot sell and cannot be fixed.
                "MarshallPay:I", "MarshallSerial:I",
                "MotorFridgeHW:W", "FridgePoll:W", "LogRelay:W",
                "AndroidRuntime:E", "*:S",
            ),
        ).redirectErrorStream(true).start()

        val all = BufferedReader(InputStreamReader(proc.inputStream)).use { it.readLines() }
        proc.waitFor()

        return all
    }

    private companion object {
        /**
         * Five minutes. Frequent enough that a fault is visible while it is
         * still happening, infrequent enough to be invisible against the
         * per-minute config poll.
         */
        const val INTERVAL_MS = 5L * 60L * 1000L

        /** Lines per post: what the backend keeps from one request. */
        const val MAX_LINES = 400

        /** Cap per flush, so a log storm cannot mail the whole buffer. */
        const val MAX_PER_FLUSH = 2000

        /** The first read after start: recent history, counted before the tag filter. */
        const val FIRST_READ = 2000

        /**
         * The fallback read when the time read misses the last shipped line. Counted before
         * the tag filter, so it has to be deep; it only runs when something moved.
         */
        const val DEEP_READ = 20000
    }
}
