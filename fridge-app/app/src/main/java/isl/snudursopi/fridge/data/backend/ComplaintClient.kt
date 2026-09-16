package isl.snudursopi.fridge.data.backend

import android.util.Log
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import isl.snudursopi.fridge.BuildConfig
import isl.snudursopi.fridge.domain.ComplaintReason
import java.util.UUID

private const val TAG = "FridgeComplaint"

/** One purchased line the customer is pointing at. */
data class ComplaintLine(
    val cabinet: Int,
    val basket: Int,
    val productId: String,
    val quantity: Int,
    val lineIsk: Int,
)

/** Outcome of a send attempt, as the UI needs to distinguish them. */
sealed class ComplaintResult {
    /** Delivered; [complaintId] is shown to the customer as a reference. */
    data class Sent(val complaintId: String) : ComplaintResult()

    /** Network failure — queued and will retry. Still a success for the customer. */
    object Queued : ComplaintResult()

    /** Rejected by the backend. A kiosk bug: do NOT queue, do NOT retry. */
    data class Rejected(val message: String) : ComplaintResult()
}

/**
 * Posts a complaint to `POST /api/v1/machines/{deviceCode}/fridge/complaints`.
 *
 * Contract agreed with the backend and enforced there:
 *   { orderId, lines[{cabinet, basket, productId, quantity, lineIsk}],
 *     reason, note, customerEmail?, timestampMs }  ->  { complaintId }
 *
 * Kept separate from [SettlementClient] rather than folded into a polymorphic
 * "report" endpoint — same decision, and for the same reason, as keeping
 * /fridge/complaints separate from the coil complaint route.
 */
class ComplaintClient(
    private val http: FridgeBackendHttp,
    private val deviceCode: String,
    private val queue: ComplaintQueueStore,
) {
    private val mapper = jacksonObjectMapper()

    private val path get() = "/api/v1/machines/$deviceCode/fridge/complaints"

    /**
     * Build the exact JSON we send. Kept as a string so a queued replay is
     * byte-identical to the first attempt.
     *
     * `note` and `customerEmail` are omitted entirely when blank rather than
     * sent as "" — the backend validates customerEmail only if present, and an
     * empty string is not a valid address.
     */
    fun buildBody(
        orderId: String,
        lines: List<ComplaintLine>,
        reason: ComplaintReason,
        note: String,
        customerEmail: String,
        timestampMs: Long,
    ): String {
        val body = buildMap<String, Any?> {
            put("orderId", orderId)
            put(
                "lines",
                lines.map {
                    mapOf(
                        "cabinet" to it.cabinet,
                        "basket" to it.basket,
                        "productId" to it.productId,
                        "quantity" to it.quantity,
                        "lineIsk" to it.lineIsk,
                    )
                },
            )
            put("reason", reason.wire)
            put("timestampMs", timestampMs)
            put("kioskAppVersion", BuildConfig.VERSION_NAME)
            note.trim().takeIf { it.isNotEmpty() }?.let { put("note", it) }
            customerEmail.trim().takeIf { it.isNotEmpty() }?.let { put("customerEmail", it) }
        }
        return mapper.writeValueAsString(body)
    }

    /**
     * Send, queueing on network failure.
     *
     * *** THE ClientError BRANCH MUST NOT QUEUE. A 400 means we built a bad body
     * — an unknown reason code, a malformed line — and retrying it forever would
     * be a poison entry that blocks the queue and never succeeds. Surface it
     * instead so it gets fixed.
     */
    suspend fun send(bodyJson: String): ComplaintResult =
        try {
            val res = http.postRawJson(path, bodyJson)
            val id = res.path("complaintId").asText().ifBlank {
                res.path("data").path("complaintId").asText()
            }
            Log.i(TAG, "complaint sent (complaintId=${id.ifBlank { "<none>" }})")
            ComplaintResult.Sent(id)
        } catch (e: BackendException) {
            if (e.kind == BackendException.Kind.ClientError) {
                Log.e(TAG, "complaint REJECTED, not queued: ${e.message}")
                ComplaintResult.Rejected(e.message ?: "rejected")
            } else {
                enqueue(bodyJson)
                Log.w(TAG, "complaint queued after ${e.kind}: ${e.message}")
                ComplaintResult.Queued
            }
        } catch (e: Exception) {
            enqueue(bodyJson)
            Log.w(TAG, "complaint queued after ${e.javaClass.simpleName}: ${e.message}")
            ComplaintResult.Queued
        }

    private suspend fun enqueue(bodyJson: String) {
        val items = queue.load() + QueuedComplaint(
            firstAttemptMs = System.currentTimeMillis(),
            localId = UUID.randomUUID().toString(),
            bodyJson = bodyJson,
        )
        queue.save(items)
    }

    /**
     * Retry queued complaints. Called on the same cadence as the settlement
     * flush.
     *
     * Stops at the first network failure rather than hammering every entry
     * against a backend we already know is unreachable — the next flush picks up
     * where this one left off. Expired and rejected entries are dropped.
     */
    suspend fun flush() {
        val items = queue.load()
        if (items.isEmpty()) return

        val now = System.currentTimeMillis()
        val fresh = items.filter { now - it.firstAttemptMs < FridgeBackendConfig.COMPLAINT_QUEUE_TTL_MS }
        if (fresh.size != items.size) {
            Log.i(TAG, "dropped ${items.size - fresh.size} expired complaint(s)")
        }

        val remaining = fresh.toMutableList()
        for (item in fresh) {
            try {
                http.postRawJson(path, item.bodyJson)
                remaining.remove(item)
                Log.i(TAG, "queued complaint delivered")
            } catch (e: BackendException) {
                if (e.kind == BackendException.Kind.ClientError) {
                    remaining.remove(item)
                    Log.e(TAG, "queued complaint rejected, dropping: ${e.message}")
                } else {
                    break
                }
            } catch (e: Exception) {
                break
            }
        }
        if (remaining.size != items.size) queue.save(remaining)
    }
}
