package isl.snudursopi.fridge.data.backend

import isl.snudursopi.fridge.domain.Planogram
import isl.snudursopi.fridge.domain.Settlement
import org.json.JSONArray
import org.json.JSONObject

/**
 * Builds the body for `POST /api/v1/machines/:deviceCode/fridge/settlement`
 * (backend contract v5.67). The backend RECOMPUTES quantities/prices from the
 * planogram and flags mismatches — we still send our computed values; both are
 * kept. Idempotent on orderId, so this same body is safe to re-post from the
 * offline queue.
 *
 * NOTE: no deviceCode in the body — the machine path + X-Machine-Key are
 * authoritative.
 */
object SettlementReport {

    fun body(
        orderId: String,
        startedAtIso: String,
        closedAtIso: String,
        planogram: Planogram,
        cabinetsOpened: List<String>,
        outcome: String,               // charged | partially_paid | unpaid | nothing_taken | declined | sensor_fault
        nayaxRef: String?,
        result: Settlement.Result,
        paidIsk: Int? = null,
        final: Boolean = true,
        paymentRefs: List<String> = emptyList(),
    ): JSONObject {
        val lines = JSONArray()
        result.lines.forEach { l ->
            lines.put(
                JSONObject()
                    .put("cabinet", l.basket.cabinet.name)
                    .put("basket", l.basket.basket)
                    .put("productId", l.basket.productId)
                    .put("startWeightG", l.startWeightG)
                    .put("endWeightG", l.endWeightG)
                    .put("deltaG", l.deltaG)
                    .put("unitWeightG", l.basket.unitWeightG)
                    .put("quantity", l.quantity)
                    .put("priceIsk", l.basket.priceIsk)
                    .put("lineIsk", l.lineIsk)
                    // Per kg: priceIsk is the kilo price and deltaG the grams charged.
                    .put("soldByWeight", l.basket.soldByWeight)
            )
        }

        val anomalies = JSONArray()
        result.anomalies.forEach { a ->
            anomalies.put(
                JSONObject()
                    .put("cabinet", a.cabinet.name)
                    .put("basket", a.basketNumber)
                    .put("deltaG", a.deltaG)
                    .put("reason", a.reason)
            )
        }

        // Wrong-basket moves (fridge 0.70.11), as anomalies so the backend stores them with the
        // rest without a schema change. The charge is not affected by them.
        result.misplaced.forEach { m ->
            anomalies.put(
                JSONObject()
                    .put("cabinet", m.into.cabinet.name)
                    .put("basket", m.into.basket)
                    .put("deltaG", -m.gainG)
                    .put("reason", if (m.from != null) "misplaced" else "weight_added")
                    .put("gainG", m.gainG)
                    .put("productId", m.into.productId ?: JSONObject.NULL)
                    .put("fromCabinet", m.from?.cabinet?.name ?: JSONObject.NULL)
                    .put("fromBasket", m.from?.basket ?: JSONObject.NULL)
                    .put("fromProductId", m.from?.productId ?: JSONObject.NULL)
                    .put("quantity", m.quantity)
                    .put("warnedMs", result.misplacedWarnedMs)
            )
        }

        return JSONObject()
            .put("orderId", orderId)
            .put("startedAt", startedAtIso)
            .put("closedAt", closedAtIso)
            .put("cabinetsOpened", JSONArray(cabinetsOpened))
            .put("outcome", outcome)
            .put("totalIsk", result.totalIsk)
            .put("nayaxRef", nayaxRef ?: JSONObject.NULL)
            .put("lines", lines)
            .put("anomalies", anomalies)
            // A basket over the card's limit is paid in several taps (0.70.13): what was collected,
            // whether the customer is still being asked for the rest, and every Nayax reference.
            .put("paidIsk", paidIsk ?: JSONObject.NULL)
            .put("final", final)
            .put("paymentRefs", JSONArray(paymentRefs))
    }
}
