package isl.snudursopi.fridge.data.backend

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.complaintQueueStore by preferencesDataStore(name = "fridge_complaint_queue")

/**
 * A complaint awaiting (re)delivery. As with settlements the body is kept as the
 * exact JSON string we first tried to send, so a replay is byte-identical.
 */
data class QueuedComplaint(
    val firstAttemptMs: Long,
    val localId: String,
    val bodyJson: String,
)

/**
 * Persistent FIFO queue for complaints that couldn't be delivered.
 *
 * Deliberately the same shape as [SettlementQueueStore] — same DataStore
 * pattern, same corrupt-queue behaviour, same replay semantics — because a
 * second mechanism doing the same job differently is how the two drift apart.
 *
 * *** ONE REAL DIFFERENCE FROM SETTLEMENTS, AND IT IS NOT COSMETIC.
 *
 * A settlement carries an orderId the backend dedupes on, so replaying is free.
 * A complaint has no such key: the backend mints the complaintId on receipt, so
 * a replayed complaint arrives as a NEW one. We therefore only ever queue after
 * a genuine network failure — never after a response we simply failed to parse —
 * and we drop the item as soon as one POST succeeds. [localId] exists so we can
 * identify an entry in the queue without pretending it means anything to the
 * server; it is never sent.
 *
 * The consequence worth knowing: a duplicate complaint is possible if the POST
 * lands and the reply is lost. Two identical reports of the same fault are a
 * far better failure than none, so that is the right way round — but it is why
 * cooling_fault alerts are deduped per device per 6h on the backend.
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
                .mapNotNull { it.toQueued() }
        } catch (e: Exception) {
            // Corrupt queue — drop rather than crash on every start.
            emptyList()
        }
    }

    suspend fun save(items: List<QueuedComplaint>) {
        val capped = if (items.size <= FridgeBackendConfig.COMPLAINT_QUEUE_MAX_SIZE) items
        else items.takeLast(FridgeBackendConfig.COMPLAINT_QUEUE_MAX_SIZE)
        val json = mapper.writeValueAsString(
            capped.map {
                mapOf(
                    "firstAttemptMs" to it.firstAttemptMs,
                    "localId" to it.localId,
                    "bodyJson" to it.bodyJson,
                )
            }
        )
        context.complaintQueueStore.edit { it[queueKey] = json }
    }

    suspend fun clear() {
        context.complaintQueueStore.edit { it.remove(queueKey) }
    }

    private fun JsonNode.toQueued(): QueuedComplaint? {
        val first = path("firstAttemptMs").asLong(-1L).takeIf { it > 0 } ?: return null
        val localId = path("localId").asText().takeIf { it.isNotBlank() } ?: return null
        val body = path("bodyJson").asText().takeIf { it.isNotBlank() } ?: return null
        return QueuedComplaint(firstAttemptMs = first, localId = localId, bodyJson = body)
    }
}
