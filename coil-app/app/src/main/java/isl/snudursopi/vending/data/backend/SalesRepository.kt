package isl.snudursopi.vending.data.backend

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * High-level entry point for reporting sales (the kiosk's required input
 * under the stock-ownership contract, backend v5.23).
 *
 * Reporting is fire-and-forget from the customer's point of view — there's
 * no UI for it. So unlike complaints, every recoverable failure (including
 * unauthorized, since the machine key may not be provisioned yet) is
 * queued and retried; only a malformed payload (4xx ClientError) is
 * dropped. Replays are safe: the backend dedupes by saleId.
 *
 * Concurrency: a single [Mutex] serializes queue access so a background
 * flush can't race a fresh report.
 */
class SalesRepository(
    private val client: SalesClient,
    private val queueStore: SalesQueueStore,
) {
    private val mutex = Mutex()

    private val _queueSize = MutableStateFlow(0)
    /** Observable queue size for diagnostics. */
    val queueSize: StateFlow<Int> = _queueSize.asStateFlow()

    /** Load the initial queue size at startup. */
    suspend fun init() {
        mutex.withLock { _queueSize.value = queueStore.load().size }
    }

    /** Report a sale now; on a recoverable failure, persist it for retry. */
    suspend fun reportOrQueue(payload: SalePayload) {
        try {
            client.report(payload)
            Log.i(TAG, "Sale reported: ${payload.saleId}")
            // A fresh success is a good moment to drain any backlog.
            flushQueueLocked()
        } catch (e: BackendException) {
            when (e.kind) {
                BackendException.Kind.ClientError -> {
                    // Malformed — will never succeed; drop (but log loudly).
                    Log.e(TAG, "Sale rejected as malformed, dropping ${payload.saleId}: ${e.message}")
                }
                else -> {
                    // Network / server / unknown / unauthorized — queue & retry.
                    enqueue(payload)
                    Log.w(TAG, "Sale queued for retry (${e.kind}): ${payload.saleId}")
                }
            }
        }
    }

    /** Replay queued sales. Called opportunistically whenever the backend
     *  looks reachable (startup, after a successful config poll, after a
     *  fresh report). Safe to call often. */
    suspend fun flushQueue() {
        mutex.withLock { flushQueueLocked() }
    }

    private suspend fun enqueue(payload: SalePayload) {
        mutex.withLock {
            val items = queueStore.load().toMutableList()
            items.add(QueuedSale(firstAttemptMs = System.currentTimeMillis(), payload = payload))
            queueStore.save(items)
            _queueSize.value = items.size.coerceAtMost(AdminBackendConfig.SALES_QUEUE_MAX_SIZE)
        }
    }

    /** Caller must hold [mutex]. */
    private suspend fun flushQueueLocked() {
        val items = queueStore.load().toMutableList()
        if (items.isEmpty()) {
            _queueSize.value = 0
            return
        }
        val now = System.currentTimeMillis()
        items.removeAll { (now - it.firstAttemptMs) > AdminBackendConfig.SALES_QUEUE_TTL_MS }

        val survivors = mutableListOf<QueuedSale>()
        var i = 0
        var halt = false
        while (i < items.size && !halt) {
            val item = items[i]
            try {
                client.report(item.payload)
                i++  // delivered (or duplicate) — drop from queue
            } catch (e: BackendException) {
                when (e.kind) {
                    BackendException.Kind.ClientError -> {
                        Log.e(TAG, "Dropping malformed queued sale: ${item.payload.saleId}")
                        i++
                    }
                    else -> {
                        // Still unreachable / unauthorized — keep this and the rest.
                        survivors.addAll(items.subList(i, items.size))
                        halt = true
                    }
                }
            }
        }
        queueStore.save(survivors)
        _queueSize.value = survivors.size
    }

    companion object {
        private const val TAG = "SalesRepository"
    }
}
