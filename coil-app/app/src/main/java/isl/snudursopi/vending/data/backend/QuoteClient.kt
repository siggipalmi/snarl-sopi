package isl.snudursopi.vending.data.backend

import com.fasterxml.jackson.databind.JsonNode
import isl.snudursopi.vending.domain.AppliedDeal
import isl.snudursopi.vending.domain.CartQuote
import isl.snudursopi.vending.domain.QuoteLine

/**
 * Prices a cart against the backend deal engine.
 *
 * Endpoint: `POST /api/v1/machines/{deviceCode}/quote` (machine-key auth).
 * Read-only — no inventory hold, no side effects. The kiosk sends the cart and
 * charges the returned [CartQuote.totalIsk]; the backend did all the discount
 * math. Backend v5.21.
 */
class QuoteClient(
    private val http: AdminBackendHttp,
) {
    /** [items] = (goodsId, qty) pairs. Throws [BackendException] on failure. */
    suspend fun quote(deviceCode: String, items: List<Pair<String, Int>>): CartQuote {
        val path = "/api/v1/machines/$deviceCode/quote"
        val body = mapOf(
            "items" to items.map { mapOf("goodsId" to it.first, "qty" to it.second) },
        )
        return parse(http.postJson(path, body))
    }

    private fun parse(root: JsonNode): CartQuote {
        val data = root.get("data")?.takeIf { it.isObject } ?: root
        val lines = data.get("lines")?.takeIf { it.isArray }?.mapNotNull { node ->
            val goodsId = node.get("goodsId")?.asText()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            QuoteLine(
                goodsId = goodsId,
                name = node.get("name")?.asText().orEmpty(),
                qty = node.get("qty")?.asInt() ?: 0,
                unitPriceIsk = node.get("unitPriceIsk")?.asInt() ?: 0,
                lineBaseIsk = node.get("lineBaseIsk")?.asInt() ?: 0,
                lineDiscountIsk = node.get("lineDiscountIsk")?.asInt() ?: 0,
                lineTotalIsk = node.get("lineTotalIsk")?.asInt() ?: 0,
                appliedDealId = node.get("appliedDealId")?.asText()?.takeIf { it.isNotBlank() },
                appliedDealName = node.get("appliedDealName")?.asText()?.takeIf { it.isNotBlank() },
            )
        } ?: emptyList()
        val deals = data.get("appliedDeals")?.takeIf { it.isArray }?.mapNotNull { node ->
            val dealId = node.get("dealId")?.asText()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            AppliedDeal(
                dealId = dealId,
                dealName = node.get("dealName")?.asText().orEmpty(),
                type = node.get("type")?.asText().orEmpty(),
                amountIsk = node.get("amountIsk")?.asInt() ?: 0,
            )
        } ?: emptyList()
        val subtotal = data.get("subtotalIsk")?.asInt() ?: lines.sumOf { it.lineBaseIsk }
        val total = data.get("totalIsk")?.asInt() ?: subtotal
        val discount = data.get("discountIsk")?.asInt() ?: (subtotal - total)
        // comboNearMiss: additive, absent when there's nothing to nudge (v5.60).
        val nearMiss = data.get("comboNearMiss")?.takeIf { it.isArray }?.mapNotNull { node ->
            val comboId = node.get("comboId")?.asText()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val candidates = node.get("candidates")?.takeIf { it.isArray }
                ?.mapNotNull { it.get("goodsId")?.asText()?.takeIf { g -> g.isNotBlank() } }
                ?: emptyList()
            isl.snudursopi.vending.domain.ComboNearMiss(
                comboId = comboId,
                label = node.get("label")?.asText().orEmpty(),
                missingGroupLabel = node.get("missingGroupLabel")?.asText()?.takeIf { it.isNotBlank() },
                addOnPriceIsk = node.get("addOnPriceIsk")?.asInt() ?: return@mapNotNull null,
                kind = node.get("kind")?.asText()?.takeIf { it.isNotBlank() } ?: "combo",
                candidateGoodsIds = candidates,
            )
        } ?: emptyList()
        return CartQuote(
            lines = lines,
            subtotalIsk = subtotal,
            discountIsk = discount,
            totalIsk = total,
            appliedDeals = deals,
            nearMiss = nearMiss,
        )
    }
}
