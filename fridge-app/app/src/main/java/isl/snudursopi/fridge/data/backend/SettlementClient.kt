package isl.snudursopi.fridge.data.backend

/**
 * Posts a settlement to
 * `POST /api/v1/machines/{deviceCode}/fridge/settlement`.
 *
 * The body is built by [SettlementReport] and passed through as a raw JSON
 * string so a queued settlement can be replayed byte-for-byte. The backend is
 * idempotent on orderId and recomputes quantities/prices itself, so replays
 * are safe and a 409 counts as delivered (handled in [FridgeBackendHttp]).
 */
class SettlementClient(
    private val http: FridgeBackendHttp,
    private val deviceCode: String,
) {
    suspend fun post(bodyJson: String) {
        http.postRawJson("/api/v1/machines/$deviceCode/fridge/settlement", bodyJson)
    }
}
