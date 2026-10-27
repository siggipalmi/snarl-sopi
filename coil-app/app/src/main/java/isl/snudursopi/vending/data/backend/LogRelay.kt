package isl.snudursopi.vending.data.backend

import android.util.Log
import isl.snudursopi.vending.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.InputStreamReader
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
    /** logcat has no cursor: re-read and drop everything up to the last line shipped. */
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
        val lines = withContext(Dispatchers.IO) { readOwnLog() }
        if (lines.isEmpty()) return
        http.postJson(
            "/api/v1/machines/$deviceCode/logs",
            mapOf(
                "kioskAppVersion" to BuildConfig.VERSION_NAME,
                "at" to System.currentTimeMillis(),
                "lines" to lines,
            ),
        )
        lastSeen = lines.last()
    }

    /**
     * Our own tags only, at the levels that carry diagnosis. The hardware tag is
     * WARN-only: its INFO traffic is the motor protocol, which would fill the
     * backend's window with bytes and push out the lines that matter.
     */
    private fun readOwnLog(): List<String> {
        val proc = ProcessBuilder(
            listOf(
                "logcat", "-d", "-v", "time", "-t", MAX_LINES.toString(),
                "VendingViewModel:I", "ProxyClient:I", "AppUpdater:I", "SelfHealing:I",
                "ClockGuard:I", "ScreenWatchdog:I", "AdCache:I", "AdRegion:W",
                "KioskManager:I", "RecoveryGuard:I", "RestartManager:I",
                "MarshallPay:I", "MarshallSerial:I", "WeimiHardware:W",
                "LogRelay:W", "AndroidRuntime:E", "*:S",
            ),
        ).redirectErrorStream(true).start()
        val all = BufferedReader(InputStreamReader(proc.inputStream)).use { it.readLines() }
        proc.waitFor()
        val cut = if (lastSeen.isBlank()) -1 else all.indexOf(lastSeen)
        val fresh = if (cut >= 0) all.drop(cut + 1) else all
        return fresh.filter { it.isNotBlank() }.takeLast(MAX_LINES)
    }

    private companion object {
        /** Five minutes: a fault is visible while it is happening, at a cost the SIM won't notice. */
        const val INTERVAL_MS = 5L * 60L * 1000L
        /** Cap per post — the backend enforces the same number. */
        const val MAX_LINES = 400
    }
}
