package isl.snudursopi.vending.data.backend

/**
 * Item the customer says didn't vend. Mirrors the contract's
 * `items[]` shape.
 */
data class ComplaintItem(
    val goodsId: String,
    val name: String,
    val priceIsk: Int,
)

/**
 * Full complaint payload sent to the backend.
 *
 * Field names match the API contract addendum v0.4 exactly. Do not
 * rename without bumping the contract version on both sides.
 */
data class ComplaintPayload(
    val tradeNo: String,
    val items: List<ComplaintItem>,
    val note: String?,
    val customerEmail: String,
    val timestampMs: Long,
    /** App version, included so backend can correlate complaint patterns to releases. Optional per addendum. */
    val kioskAppVersion: String?,
    /** Locale string from [java.util.Locale.toString], e.g. "is_IS". Optional per addendum. */
    val kioskOsLocale: String?,
)

/**
 * Successful complaint submission response. The backend always returns
 * a complaintId, including on 409 Conflict (existing complaint).
 */
data class ComplaintResponse(
    val complaintId: String,
)

/**
 * Thin typed wrapper around [AdminBackendHttp] for the `/complaints`
 * endpoint. Other endpoints will get their own wrappers as we add them.
 */
class ComplaintClient(
    private val http: AdminBackendHttp,
    private val deviceCode: String,
) {
    /**
     * Submit a complaint. Returns the backend's complaintId on success.
     * Throws [BackendException] on failure — caller decides retry policy.
     */
    suspend fun submit(payload: ComplaintPayload): ComplaintResponse {
        val body = mapOf(
            "tradeNo" to payload.tradeNo,
            "items" to payload.items.map {
                mapOf(
                    "goodsId" to it.goodsId,
                    "name" to it.name,
                    "priceIsk" to it.priceIsk,
                )
            },
            "note" to payload.note,
            "customerEmail" to payload.customerEmail,
            "timestampMs" to payload.timestampMs,
            "kioskAppVersion" to payload.kioskAppVersion,
            "kioskOsLocale" to payload.kioskOsLocale,
        )
        val response = http.postJson("/api/v1/machines/$deviceCode/complaints", body)
        val id = response.path("complaintId").asText()
        if (id.isBlank()) {
            throw BackendException(
                kind = BackendException.Kind.ServerError,
                message = "backend response missing complaintId",
            )
        }
        return ComplaintResponse(complaintId = id)
    }
}
