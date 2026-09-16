package isl.snudursopi.fridge.data.backend

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.settlementQueueStore by preferencesDataStore(name = "fridge_settlement_queue")

/**
 * A settlement awaiting (re)delivery. The body is kept as the exact JSON string
 * we first tried to send, so a replay is byte-identical and the backend's
 * orderId idempotency does its job.
 */
data class QueuedSettlement(
    val firstAttemptMs: Long,
    val orderId: String,
    val bodyJson: String,
)

/**
 * Persistent FIFO queue for settlements that couldn't be delivered.
 *
 * This is the safety net that matters most in this app: by the time we settle,
 * the customer has ALREADY taken the goods and the card has ALREADY been
 * charged. If the report doesn't reach the backend, stock and revenue silently
 * drift. So we persist across restarts and retry for days.
 *
 * Storage: one JSON array string in DataStore, same shape as the coil app's
 * sales queue.
 */
class SettlementQueueStore(private val context: Context) {
    private val queueKey = stringPreferencesKey("queue_json")
    private val mapper = jacksonObjectMapper()

    suspend fun load(): List<QueuedSettlement> {
        val json = context.settlementQueueStore.data
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

    suspend fun save(items: List<QueuedSettlement>) {
        val capped = if (items.size <= FridgeBackendConfig.SETTLEMENT_QUEUE_MAX_SIZE) items
        else items.takeLast(FridgeBackendConfig.SETTLEMENT_QUEUE_MAX_SIZE)
        val json = mapper.writeValueAsString(
            capped.map {
                mapOf(
                    "firstAttemptMs" to it.firstAttemptMs,
                    "orderId" to it.orderId,
                    "bodyJson" to it.bodyJson,
                )
            }
        )
        context.settlementQueueStore.edit { it[queueKey] = json }
    }

    suspend fun clear() {
        context.settlementQueueStore.edit { it.remove(queueKey) }
    }

    private fun JsonNode.toQueued(): QueuedSettlement? {
        val first = path("firstAttemptMs").asLong(-1L).takeIf { it > 0 } ?: return null
        val orderId = path("orderId").asText().takeIf { it.isNotBlank() } ?: return null
        val body = path("bodyJson").asText().takeIf { it.isNotBlank() } ?: return null
        return QueuedSettlement(firstAttemptMs = first, orderId = orderId, bodyJson = body)
    }
}
