package isl.snudursopi.fridge.data.backend

import android.util.Log
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private const val TAG = "FridgeTelemetry"

/**
 * Posts the cabinet temperature to
 * `POST /api/v1/machines/{deviceCode}/telemetry`.
 *
 * *** GAPS, NEVER NULLS. If there is no real reading we send NOTHING — not a
 * null, and emphatically not a 0. The backend infers a problem from the ABSENCE
 * of samples, and a fake 0 reads as a perfectly healthy 0 C on a food-safety
 * panel while defeating the staleness detection that would otherwise have
 * caught it. Same reasoning as the implausible-value guard in the decoder.
 *
 * *** FIRE AND FORGET. No queue, no retry. Freshness is the whole value of a
 * temperature; a replayed 20-minute-old reading is worse than a gap, because it
 * looks current. This is the opposite of the settlement queue, and deliberately
 * so — a settlement is money already taken and must survive, a temperature is
 * only worth anything now.
 *
 * `at` is omitted on purpose: java.time.Instant needs API 26 or core library
 * desugaring, this module has neither and minSdk is 24, so Instant.now() would
 * throw at runtime. The backend stamps receipt time, which is within seconds.
 */
class TelemetryClient(
    private val http: FridgeBackendHttp,
    private val deviceCode: String,
) {
    private val mapper = jacksonObjectMapper()

    suspend fun report(cabinetTempC: Double, setpointC: Int?) {
        val body = mapper.writeValueAsString(
            buildMap<String, Any?> {
                put("cabinetTempC", cabinetTempC)
                setpointC?.let { put("setpointC", it) }
            },
        )
        http.postRawJson("/api/v1/machines/$deviceCode/telemetry", body)
    }
}

/**
 * Reads the board every five minutes and reports what it finds.
 *
 * The read is asynchronous — [readNow] fires a serial command and the reply
 * arrives on the callback thread, updating [currentTemp] — so the loop asks,
 * waits briefly, then reports whatever the decoder last saw.
 */
class TelemetryLoop(
    private val client: TelemetryClient,
    private val readNow: () -> Unit,
    private val currentTemp: () -> Double?,
    private val currentSetpoint: () -> Int?,
    private val isSessionActive: () -> Boolean,
) {
    fun start(scope: CoroutineScope) {
        scope.launch {
            delay(60_000)
            while (isActive) {
                if (!isSessionActive()) runCatching { sampleOnce() }
                delay(INTERVAL_MS)
            }
        }
    }

    private suspend fun sampleOnce() {
        val before = currentTemp()
        readNow()
        // The reply lands on the serial callback thread; give it time.
        delay(2_000)
        val temp = currentTemp()
        if (temp == null) {
            Log.w(TAG, "no reading available — skipping sample (gap, not a null)")
            return
        }
        if (temp == before) {
            // Not necessarily stale: a stable cabinet genuinely repeats. Worth
            // one line so a board that has stopped answering is visible.
            Log.i(TAG, "reading unchanged at $temp C")
        }
        runCatching { client.report(temp, currentSetpoint()) }
            .onSuccess { Log.i(TAG, "telemetry posted $temp C") }
            .onFailure { Log.w(TAG, "telemetry post failed, dropping: ${it.message}") }
    }

    private companion object {
        const val INTERVAL_MS = 5L * 60L * 1000L
    }
}
