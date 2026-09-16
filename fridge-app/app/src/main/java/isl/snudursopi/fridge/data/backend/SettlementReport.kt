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
        outcome: String,               // charged | nothing_taken | declined | sensor_fault | pending_offline
        nayaxRef: String?,
        result: Settlement.Result,
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
    }
}
