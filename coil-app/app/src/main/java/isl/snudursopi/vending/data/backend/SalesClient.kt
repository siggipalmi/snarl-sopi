package isl.snudursopi.vending.data.backend

/**
 * One sold line in a sale. Mirrors the stock-ownership contract's
 * `lines[]` shape. [amountIsk] is what was actually charged for the line
 * (realised deal price — revenue + the recorded deal price). [aisle] is the
 * coil the line was vended from ("A35"), shown per purchase on the dashboard;
 * null for a sale queued by a build older than 0.80.16. [aisleCode] is the same
 * coil in the backend's layout code ("0-D00", from 0.80.17), so the backend
 * decrements that bay rather than the product's first one.
 */
data class SaleLine(
    val goodsId: String,
    val qty: Int,
    val amountIsk: Int,
    val aisle: String? = null,
    val aisleCode: String? = null,
)

/**
 * A completed sale (one checkout) reported to the backend so it can
 * decrement stock and record revenue.
 *
 * Field names match the stock-ownership decision (backend v5.23). Do not
 * rename without bumping the contract on both sides.
 *
 * [saleId] is the idempotency key — the backend ignores a re-sent saleId,
 * so offline-queue flushes and retries never double-count.
 * [at] is an ISO-8601 UTC timestamp (kiosk clock); it drives the backend's
 * restock-vs-vend timestamp rule.
 */
data class SalePayload(
    val saleId: String,
    val at: String,
    val totalIsk: Int,
    val lines: List<SaleLine>,
)

/**
 * Thin typed wrapper around [AdminBackendHttp] for the `/sales` endpoint.
 *
 * The backend returns `accepted` for a new sale and `duplicate` for a
 * saleId it already has — BOTH mean "the backend has it", so a 2xx is
 * success either way and the caller should not retry. Only a thrown
 * [BackendException] (network/5xx/etc.) means "try again later".
 */
class SalesClient(
    private val http: AdminBackendHttp,
    private val deviceCode: String,
) {
    /** Report a sale. Returns normally on success (accepted or duplicate);
     *  throws [BackendException] on failure — caller decides retry policy. */
    suspend fun report(payload: SalePayload) {
        val body = mapOf(
            "saleId" to payload.saleId,
            "at" to payload.at,
            "totalIsk" to payload.totalIsk,
            "lines" to payload.lines.map {
                mapOf(
                    "goodsId" to it.goodsId,
                    "qty" to it.qty,
                    "amountIsk" to it.amountIsk,
                    "aisle" to it.aisle,
                    "aisleCode" to it.aisleCode,
                )
            },
        )
        // A 2xx (accepted OR duplicate) returns without throwing; postJson
        // throws BackendException on any non-2xx.
        http.postJson("/api/v1/machines/$deviceCode/sales", body)
    }
}
