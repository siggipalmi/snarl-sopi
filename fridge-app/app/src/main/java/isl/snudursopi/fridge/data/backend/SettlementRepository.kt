package isl.snudursopi.fridge.data.backend

import android.util.Log
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Delivers settlements to the backend, with a persistent retry queue.
 *
 * Why this is the most safety-critical class in the app: at settlement time the
 * customer already has the goods and the card is already charged. A settlement
 * that never lands is silent stock drift and unreconciled revenue. So:
 *  - a delivery failure NEVER surfaces as a customer-facing error
 *  - anything retryable is persisted and replayed for up to 7 days
 *  - replays are safe (backend is idempotent on orderId)
 *
 * [flushQueue] is called opportunistically — on start and after each new
 * settlement — so a machine that was offline catches up as soon as it's back.
 */
class SettlementRepository(
    private val client: SettlementClient,
    private val queueStore: SettlementQueueStore,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
    /** Serialises queue read-modify-write so concurrent sales can't clobber it. */
    private val queueLock = Mutex()

    /**
     * Report a settlement. Returns true if the backend accepted it now; false
     * means it was queued (or dropped as non-retryable) — either way the
     * caller should carry on, never block the customer.
     */
    suspend fun report(orderId: String, bodyJson: String): Boolean {
        return try {
            client.post(bodyJson)
            Log.i(TAG, "settlement $orderId delivered")
            true
        } catch (e: BackendException) {
            if (e.retryable) {
                Log.w(TAG, "settlement $orderId not delivered (${e.kind}) — queueing: ${e.message}")
                enqueue(orderId, bodyJson)
            } else {
                // ClientError means we built a bad body; Unauthorized means the
                // machine key is wrong. Retrying either just burns the queue,
                // but we must not lose the money silently — log loudly.
                Log.e(TAG, "settlement $orderId REJECTED (${e.kind}), not retrying: ${e.message}")
            }
            false
        } catch (e: Exception) {
            Log.w(TAG, "settlement $orderId failed unexpectedly — queueing: ${e.message}")
            enqueue(orderId, bodyJson)
            false
        }
    }

    /**
     * Attempt every queued settlement, oldest first. Stops at the first
     * retryable failure (the backend is evidently still unreachable — no point
     * hammering it) and keeps the remainder for next time. Expired entries are
     * dropped.
     */
    suspend fun flushQueue() {
        queueLock.withLock {
            val queued = queueStore.load()
            if (queued.isEmpty()) return

            val cutoff = nowMs() - FridgeBackendConfig.SETTLEMENT_QUEUE_TTL_MS
            val (fresh, expired) = queued.partition { it.firstAttemptMs >= cutoff }
            if (expired.isNotEmpty()) {
                Log.e(TAG, "dropping ${expired.size} settlement(s) past TTL: ${expired.map { it.orderId }}")
            }

            val remaining = mutableListOf<QueuedSettlement>()
            var delivered = 0
            for ((index, item) in fresh.withIndex()) {
                try {
                    client.post(item.bodyJson)
                    delivered++
                } catch (e: BackendException) {
                    if (e.retryable) {
                        // Still offline — keep this and everything after it.
                        remaining += fresh.drop(index)
                        break
                    }
                    Log.e(TAG, "queued settlement ${item.orderId} rejected (${e.kind}), dropping: ${e.message}")
                } catch (e: Exception) {
                    remaining += fresh.drop(index)
                    break
                }
            }

            if (delivered > 0) Log.i(TAG, "flushed $delivered queued settlement(s)")
            queueStore.save(remaining)
        }
    }

    private suspend fun enqueue(orderId: String, bodyJson: String) {
        queueLock.withLock {
            val current = queueStore.load()
            if (current.any { it.orderId == orderId }) return
            queueStore.save(
                current + QueuedSettlement(
                    firstAttemptMs = nowMs(),
                    orderId = orderId,
                    bodyJson = bodyJson,
                )
            )
        }
    }

    private companion object {
        const val TAG = "FridgeSettlement"
    }
}
