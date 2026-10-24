package isl.snudursopi.vending.data.backend

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.complaintQueueStore by preferencesDataStore(name = "complaint_queue")

/**
 * Queued complaint awaiting retry. Wraps a [ComplaintPayload] with the
 * timestamp of the first attempt (used to enforce
 * [AdminBackendConfig.COMPLAINT_QUEUE_TTL_MS]).
 */
data class QueuedComplaint(
    val firstAttemptMs: Long,
    val payload: ComplaintPayload,
)

/**
 * Persistent FIFO queue for complaints that failed to submit on the first
 * try. The queue survives app restarts and is replayed by
 * [ComplaintRepository.flushQueue] whenever the backend is reachable
 * again.
 *
 * Cap: [AdminBackendConfig.COMPLAINT_QUEUE_MAX_SIZE]. If exceeded (very
 * unlikely outside sustained outages), the oldest entries are dropped.
 *
 * TTL: [AdminBackendConfig.COMPLAINT_QUEUE_TTL_MS]. Entries older than
 * this are dropped without further retries — the operator already knows
 * something is wrong by then.
 *
 * Storage format: a single JSON array string. Simple, atomic, and
 * read/write costs are negligible at the expected queue sizes.
 */
class ComplaintQueueStore(private val context: Context) {
    private val queueKey = stringPreferencesKey("queue_json")
    private val mapper = jacksonObjectMapper()

    suspend fun load(): List<QueuedComplaint> {
        val json = context.complaintQueueStore.data
            .map { it[queueKey] }
            .first()
            ?: return emptyList()
        return try {
            mapper.readTree(json)
                .filter { it.isObject }
                .mapNotNull { node -> node.toQueuedComplaint() }
        } catch (e: Exception) {
            // Corrupt queue — drop everything. Better than crashing on
            // every app start with garbage in DataStore.
            emptyList()
        }
    }

    suspend fun save(items: List<QueuedComplaint>) {
        val capped = if (items.size <= AdminBackendConfig.COMPLAINT_QUEUE_MAX_SIZE) items
        else items.takeLast(AdminBackendConfig.COMPLAINT_QUEUE_MAX_SIZE)
        val json = mapper.writeValueAsString(capped.map { it.toMap() })
        context.complaintQueueStore.edit { it[queueKey] = json }
    }

    suspend fun clear() {
        context.complaintQueueStore.edit { it.remove(queueKey) }
    }

    // ---- (de)serialization ----

    private fun QueuedComplaint.toMap(): Map<String, Any?> = mapOf(
        "firstAttemptMs" to firstAttemptMs,
        "payload" to mapOf(
            "tradeNo" to payload.tradeNo,
            "items" to payload.items.map {
                mapOf("goodsId" to it.goodsId, "name" to it.name, "priceIsk" to it.priceIsk)
            },
            "note" to payload.note,
            "customerEmail" to payload.customerEmail,
            "timestampMs" to payload.timestampMs,
            "kioskAppVersion" to payload.kioskAppVersion,
            "kioskOsLocale" to payload.kioskOsLocale,
        ),
    )

    private fun JsonNode.toQueuedComplaint(): QueuedComplaint? {
        val firstAttemptMs = path("firstAttemptMs").asLong(-1L).takeIf { it > 0 }
            ?: return null
        val p = path("payload").takeIf { it.isObject } ?: return null
        val items = p.path("items").mapNotNull { item ->
            val goodsId = item.path("goodsId").asText().takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val name = item.path("name").asText()
            val priceIsk = item.path("priceIsk").asInt(0)
            ComplaintItem(goodsId = goodsId, name = name, priceIsk = priceIsk)
        }
        if (items.isEmpty()) return null
        val payload = ComplaintPayload(
            tradeNo = p.path("tradeNo").asText().takeIf { it.isNotBlank() } ?: return null,
            items = items,
            note = p.path("note").takeIf { !it.isMissingNode && !it.isNull }?.asText(),
            customerEmail = p.path("customerEmail").asText().takeIf { it.isNotBlank() } ?: return null,
            timestampMs = p.path("timestampMs").asLong(0L),
            kioskAppVersion = p.path("kioskAppVersion").takeIf { !it.isMissingNode && !it.isNull }?.asText(),
            kioskOsLocale = p.path("kioskOsLocale").takeIf { !it.isMissingNode && !it.isNull }?.asText(),
        )
        return QueuedComplaint(firstAttemptMs = firstAttemptMs, payload = payload)
    }
}
