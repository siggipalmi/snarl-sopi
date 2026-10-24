package isl.snudursopi.vending.data.backend

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * High-level entry point for complaint submission.
 *
 * Responsibilities:
 *   - First attempt: call the backend directly. On 2xx (or 409), done.
 *   - On transient failure (network, 5xx): enqueue for later retry.
 *   - On terminal failure (4xx other than 409): bubble back to caller —
 *     the kiosk shouldn't retry a payload the backend has rejected.
 *   - On unauthorized: bubble back so the ViewModel can clear the key
 *     and return to setup phase (per contract section 2.3).
 *   - [flushQueue] replays the queue. Called opportunistically by the
 *     ViewModel whenever the backend looks reachable.
 *
 * Concurrency: a single [Mutex] serializes queue read/write so a
 * background flush can't race with a fresh user submission.
 */
class ComplaintRepository(
    private val client: ComplaintClient,
    private val queueStore: ComplaintQueueStore,
) {
    private val mutex = Mutex()

    private val _queueSize = MutableStateFlow(0)
    /** Observable queue size for diagnostics UI. */
    val queueSize: StateFlow<Int> = _queueSize.asStateFlow()

    /** Should be called once at startup to load initial queue size into [queueSize]. */
    suspend fun init() {
        mutex.withLock {
            _queueSize.value = queueStore.load().size
        }
    }

    /**
     * Result of a submit attempt — returned to the ViewModel so it can
     * choose the right UI response (confirmation vs queued vs reauth).
     */
    sealed class SubmitResult {
        /** Backend accepted (or already had). Show confirmation. */
        data class Accepted(val complaintId: String) : SubmitResult()
        /** Network/server hiccup; queued for retry. Show confirmation anyway. */
        data object Queued : SubmitResult()
        /** Backend rejected the payload as malformed. Probably a bug; do not retry. */
        data class Rejected(val message: String) : SubmitResult()
        /** Auth failed — machine key needs re-provisioning. */
        data object Unauthorized : SubmitResult()
    }

    /**
     * Try to submit a fresh complaint right now. On a transient failure,
     * persist it for later retry. The UX-level decision (show
     * confirmation regardless of whether the backend got it now or
     * will get it shortly) is the right one for vending: the customer
     * filed their complaint, we promise it'll reach the operator.
     */
    suspend fun submitOrQueue(payload: ComplaintPayload): SubmitResult {
        return try {
            val response = client.submit(payload)
            SubmitResult.Accepted(complaintId = response.complaintId)
        } catch (e: BackendException) {
            when (e.kind) {
                BackendException.Kind.NetworkError,
                BackendException.Kind.ServerError,
                BackendException.Kind.Unknown -> {
                    enqueue(payload)
                    Log.w(TAG, "Complaint queued for retry: ${e.message}")
                    SubmitResult.Queued
                }
                BackendException.Kind.Unauthorized -> {
                    Log.w(TAG, "Complaint rejected with 401")
                    SubmitResult.Unauthorized
                }
                BackendException.Kind.ClientError -> {
                    Log.e(TAG, "Complaint rejected as malformed: ${e.message}")
                    SubmitResult.Rejected(e.message ?: "unknown client error")
                }
            }
        }
    }

    /**
     * Replay any queued complaints. Called by the ViewModel
     * opportunistically (after any successful backend interaction).
     *
     * Stops at the first transient failure — there's no point trying
     * the rest if the backend just refused. Drops items older than TTL.
     */
    suspend fun flushQueue() {
        mutex.withLock {
            val items = queueStore.load().toMutableList()
            if (items.isEmpty()) {
                _queueSize.value = 0
                return
            }
            val now = System.currentTimeMillis()
            // Drop TTL-expired entries first
            items.removeAll { (now - it.firstAttemptMs) > AdminBackendConfig.COMPLAINT_QUEUE_TTL_MS }

            val survivors = mutableListOf<QueuedComplaint>()
            var i = 0
            var halt = false
            while (i < items.size && !halt) {
                val item = items[i]
                try {
                    client.submit(item.payload)
                    // delivered; don't add to survivors, move on
                    i++
                } catch (e: BackendException) {
                    when (e.kind) {
                        BackendException.Kind.NetworkError,
                        BackendException.Kind.ServerError,
                        BackendException.Kind.Unknown -> {
                            // Still broken — keep this item and everything after it
                            survivors.addAll(items.subList(i, items.size))
                            halt = true
                        }
                        BackendException.Kind.Unauthorized -> {
                            // Auth bad — preserve the queue, bail out
                            survivors.addAll(items.subList(i, items.size))
                            halt = true
                            Log.w(TAG, "Queue flush halted by 401")
                        }
                        BackendException.Kind.ClientError -> {
                            // Bad payload — drop, continue
                            Log.e(TAG, "Dropping malformed queued complaint: ${e.message}")
                            i++
                        }
                    }
                }
            }
            queueStore.save(survivors)
            _queueSize.value = survivors.size
        }
    }

    private suspend fun enqueue(payload: ComplaintPayload) {
        mutex.withLock {
            val items = queueStore.load().toMutableList()
            items.add(QueuedComplaint(firstAttemptMs = System.currentTimeMillis(), payload = payload))
            queueStore.save(items)
            _queueSize.value = items.size.coerceAtMost(AdminBackendConfig.COMPLAINT_QUEUE_MAX_SIZE)
        }
    }

    companion object {
        private const val TAG = "ComplaintRepository"
    }
}
