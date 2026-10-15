package isl.snudursopi.fridge.data.backend

import android.util.Log
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val TAG = "FridgeStock"

/** One basket as the scales see it right now. [units] is null for a per-kg basket. */
data class BasketStock(val cabinet: String, val basket: Int, val grams: Int, val units: Int?)

/**
 * Tells the backend what is in each basket:
 * `POST /api/v1/machines/{code}/fridge/stock` with `{ reason, cabinet?, baskets[] }`.
 *
 * The backend has no scales of its own — without this the operator dashboard
 * cannot show stock per basket, empty baskets, or when a cabinet was last
 * restocked. Reported at startup, after every sale and after every restock.
 *
 * *** ONLY THE LATEST IS KEPT. Stock is a current state, not a ledger: if a
 * report can't be sent, the next one supersedes it. A RESTOCK report is the
 * exception that matters (it dates the restock), so a failed one is held until
 * a flush gets it through, unless a newer restock replaces it.
 */
class StockClient(
    private val http: FridgeBackendHttp,
    private val deviceCode: String,
) {
    private data class Report(val reason: String, val cabinet: Int?, val baskets: List<BasketStock>)

    private val path get() = "/api/v1/machines/$deviceCode/fridge/stock"
    private val lock = Mutex()
    private var pendingRestock: Report? = null

    suspend fun report(reason: String, cabinet: Int?, baskets: List<BasketStock>) {
        val r = Report(reason, cabinet, baskets)
        if (!send(r) && reason == "restock") lock.withLock { pendingRestock = r }
    }

    /** Retry a held restock report. Called from the backend loop. */
    suspend fun flush() {
        val r = lock.withLock { pendingRestock } ?: return
        if (send(r)) lock.withLock { if (pendingRestock === r) pendingRestock = null }
    }

    private suspend fun send(r: Report): Boolean =
        try {
            http.postJson(
                path,
                buildMap {
                    put("reason", r.reason)
                    r.cabinet?.let { put("cabinet", if (it == 2) "B" else "A") }
                    put(
                        "baskets",
                        r.baskets.map { b ->
                            mapOf("cabinet" to b.cabinet, "basket" to b.basket, "grams" to b.grams, "units" to b.units)
                        },
                    )
                },
            )
            Log.i(TAG, "stock reported (${r.reason}, ${r.baskets.size} baskets)")
            true
        } catch (e: Exception) {
            Log.w(TAG, "stock report (${r.reason}) not sent: ${e.message}")
            false
        }
}
