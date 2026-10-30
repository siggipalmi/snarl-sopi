package isl.snudursopi.vending.data.backend

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.salesQueueStore by preferencesDataStore(name = "sales_queue")

/**
 * A sale awaiting (re)delivery, wrapping a [SalePayload] with the time of
 * its first attempt (for TTL).
 */
data class QueuedSale(
    val firstAttemptMs: Long,
    val payload: SalePayload,
)

/**
 * Persistent FIFO queue for sales that couldn't be reported on the first
 * try. Survives app restarts; replayed by [SalesRepository.flushQueue]
 * whenever the backend is reachable. Losing a sale means losing a stock
 * decrement and revenue, so the cap and TTL are generous — and replays are
 * safe because the backend dedupes by saleId.
 *
 * Storage: a single JSON array string in DataStore. Same shape as the
 * complaint queue.
 */
class SalesQueueStore(private val context: Context) {
    private val queueKey = stringPreferencesKey("queue_json")
    private val mapper = jacksonObjectMapper()

    suspend fun load(): List<QueuedSale> {
        val json = context.salesQueueStore.data
            .map { it[queueKey] }
            .first()
            ?: return emptyList()
        return try {
            mapper.readTree(json)
                .filter { it.isObject }
                .mapNotNull { node -> node.toQueuedSale() }
        } catch (e: Exception) {
            // Corrupt queue — drop rather than crash on every start.
            emptyList()
        }
    }

    suspend fun save(items: List<QueuedSale>) {
        val capped = if (items.size <= AdminBackendConfig.SALES_QUEUE_MAX_SIZE) items
        else items.takeLast(AdminBackendConfig.SALES_QUEUE_MAX_SIZE)
        val json = mapper.writeValueAsString(capped.map { it.toMap() })
        context.salesQueueStore.edit { it[queueKey] = json }
    }

    suspend fun clear() {
        context.salesQueueStore.edit { it.remove(queueKey) }
    }

    // ---- (de)serialization ----

    private fun QueuedSale.toMap(): Map<String, Any?> = mapOf(
        "firstAttemptMs" to firstAttemptMs,
        "payload" to mapOf(
            "saleId" to payload.saleId,
            "at" to payload.at,
            "totalIsk" to payload.totalIsk,
            "lines" to payload.lines.map {
                mapOf("goodsId" to it.goodsId, "qty" to it.qty, "amountIsk" to it.amountIsk, "aisle" to it.aisle)
            },
        ),
    )

    private fun JsonNode.toQueuedSale(): QueuedSale? {
        val firstAttemptMs = path("firstAttemptMs").asLong(-1L).takeIf { it > 0 } ?: return null
        val p = path("payload").takeIf { it.isObject } ?: return null
        val lines = p.path("lines").mapNotNull { ln ->
            val goodsId = ln.path("goodsId").asText().takeIf { it.isNotBlank() } ?: return@mapNotNull null
            SaleLine(
                goodsId = goodsId,
                qty = ln.path("qty").asInt(0),
                amountIsk = ln.path("amountIsk").asInt(0),
                aisle = ln.path("aisle").takeIf { it.isTextual }?.asText()?.takeIf { it.isNotBlank() },
            )
        }
        if (lines.isEmpty()) return null
        val payload = SalePayload(
            saleId = p.path("saleId").asText().takeIf { it.isNotBlank() } ?: return null,
            at = p.path("at").asText().takeIf { it.isNotBlank() } ?: return null,
            totalIsk = p.path("totalIsk").asInt(0),
            lines = lines,
        )
        return QueuedSale(firstAttemptMs = firstAttemptMs, payload = payload)
    }
}
