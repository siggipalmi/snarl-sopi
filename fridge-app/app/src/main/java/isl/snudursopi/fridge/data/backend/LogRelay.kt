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
     * The last timestamp we shipped. logcat has no cursor, so we re-read the
     * buffer and drop anything we have already sent. Crude, and reliable —
     * the alternative is a persistent read process that dies with the app.
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
        val lines = readOwnLog()
        if (lines.isEmpty()) return
        val body = mapper.writeValueAsString(
            mapOf(
                "kioskAppVersion" to BuildConfig.VERSION_NAME,
                "at" to System.currentTimeMillis(),
                "lines" to lines,
            ),
        )
        http.postRawJson("/api/v1/machines/$deviceCode/logs", body)
        lastSeen = lines.last()
    }

    /**
     * Our own tags only. Deliberately not the whole buffer: the system is noisy,
     * and a fridge's log has no business carrying other apps' output to a server.
     */
    private fun readOwnLog(): List<String> {
        val proc = ProcessBuilder(
            listOf(
                "logcat", "-d", "-v", "time", "-t", MAX_LINES.toString(),
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
                "PriceTagSync:I", "AppUpdater:I", "RecoveryGuard:I",
                "AdminClock:I", "SelfHealing:I", "CommandRunner:I",
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

        // Drop everything up to and including the last line we shipped.
        val cut = if (lastSeen.isBlank()) -1 else all.indexOf(lastSeen)
        val fresh = if (cut >= 0) all.drop(cut + 1) else all
        return fresh.filter { it.isNotBlank() }.takeLast(MAX_LINES)
    }

    private companion object {
        /**
         * Five minutes. Frequent enough that a fault is visible while it is
         * still happening, infrequent enough to be invisible against the
         * per-minute config poll.
         */
        const val INTERVAL_MS = 5L * 60L * 1000L

        /** Cap per post, so a log storm cannot mail the whole buffer. */
        const val MAX_LINES = 400
    }
}
