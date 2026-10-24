package isl.snudursopi.vending.data.backend

/**
 * One temperature/telemetry sample reported to the backend.
 *
 * Field shape matches the kiosk telemetry proposal (kiosk → backend memo):
 * [cabinetTempC] is the decoded cabinet temperature (°C); [humidity],
 * [evaporator] and [statusOk] are bonus diagnostics. [at] is an ISO-8601 UTC
 * timestamp (kiosk clock).
 */
data class TelemetryPayload(
    val at: String,
    val cabinetTempC: Double?,
    val humidity: Int?,
    val evaporator: Int?,
    val statusOk: Boolean?,
    /** Live set of aisle codes the kiosk is currently hiding from customers,
     *  so the dashboard can show authoritative local state (config-intended vs
     *  what the kiosk is really doing). Friendly codes, e.g. ["A3","B1"]. */
    val disabledAisles: List<String>? = null,
)

/**
 * Thin wrapper around [AdminBackendHttp] for the `/telemetry` endpoint.
 *
 * Fire-and-forget: telemetry is best-effort and never queued — a thrown
 * [BackendException] (offline / 5xx) just means "skip this sample". Freshness
 * matters; a missed reading does not. The backend owns thresholds and alerting
 * (including stale-telemetry alerts); the kiosk only reports raw readings.
 */
class TelemetryClient(
    private val http: AdminBackendHttp,
    private val deviceCode: String,
) {
    /** Post one sample. Returns on 2xx; throws [BackendException] on failure
     *  (caller drops it — no retry). */
    suspend fun report(payload: TelemetryPayload) {
        val body = mapOf(
            "at" to payload.at,
            "cabinetTempC" to payload.cabinetTempC,
            "humidity" to payload.humidity,
            "evaporator" to payload.evaporator,
            "statusOk" to payload.statusOk,
            "disabledAisles" to payload.disabledAisles,
        )
        http.postJson("/api/v1/machines/$deviceCode/telemetry", body)
    }
}
