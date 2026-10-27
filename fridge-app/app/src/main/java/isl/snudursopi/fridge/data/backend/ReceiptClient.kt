package isl.snudursopi.fridge.data.backend

import android.util.Log
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val TAG = "FridgeReceipt"

/** Outcome of asking for an email receipt, as the screen needs to tell them apart. */
sealed class ReceiptResult {
    /** The backend has it: sent, or waiting there for the settlement to arrive. */
    object Accepted : ReceiptResult()

    /** Backend unreachable — held here and retried. Still "on its way" to the customer. */
    object Queued : ReceiptResult()

    /** Refused (a bad address, receipts switched off). Not retried. */
    data class Rejected(val message: String) : ReceiptResult()
}

/**
 * Asks the backend to email a receipt: `POST /api/v1/machines/{code}/fridge/receipt`
 * with `{ orderId, email, language }`. The backend builds the receipt from its
 * own record of the settlement and sends it.
 *
 * *** THE RETRY QUEUE IS IN MEMORY, ON PURPOSE. Unlike complaints and
 * settlements, a pending receipt is not written to disk: it carries a customer's
 * email address, and the promise on screen is that the address is used once.
 * The cost is that a receipt asked for while offline is lost if the app
 * restarts before the network returns — acceptable for a courtesy copy, and the
 * customer still has their card statement.
 */
class ReceiptClient(
    private val http: FridgeBackendHttp,
    private val deviceCode: String,
) {
    private data class Pending(val orderId: String, val email: String, val language: String, val firstAttemptMs: Long)

    private val path get() = "/api/v1/machines/$deviceCode/fridge/receipt"
    private val lock = Mutex()
    private val pending = mutableListOf<Pending>()

    suspend fun send(orderId: String, email: String, language: String): ReceiptResult {
        val p = Pending(orderId, email.trim(), language, System.currentTimeMillis())
        return when (val r = attempt(p)) {
            null -> {
                lock.withLock { pending += p }
                ReceiptResult.Queued
            }
            else -> r
        }
    }

    /** Retry held requests. Called from the backend loop alongside the complaint flush. */
    suspend fun flush() {
        val items = lock.withLock { pending.toList() }
        if (items.isEmpty()) return
        val now = System.currentTimeMillis()
        for (p in items) {
            val done = now - p.firstAttemptMs > TTL_MS || attempt(p) != null
            if (!done) break // still offline; the next flush picks up from here
            lock.withLock { pending.remove(p) }
        }
    }

    /** null = transient failure, keep it; otherwise the final answer. */
    private suspend fun attempt(p: Pending): ReceiptResult? =
        try {
            val res = http.postJson(
                path,
                mapOf("orderId" to p.orderId, "email" to p.email, "language" to p.language),
            )
            // The address is deliberately not logged.
            Log.i(TAG, "receipt for ${p.orderId}: ${res.path("status").asText("accepted")}")
            ReceiptResult.Accepted
        } catch (e: BackendException) {
            if (e.kind == BackendException.Kind.ClientError) {
                Log.e(TAG, "receipt for ${p.orderId} refused: ${e.message}")
                ReceiptResult.Rejected(e.message ?: "rejected")
            } else {
                Log.w(TAG, "receipt for ${p.orderId} held after ${e.kind}: ${e.message}")
                null
            }
        } catch (e: Exception) {
            Log.w(TAG, "receipt for ${p.orderId} held after ${e.javaClass.simpleName}: ${e.message}")
            null
        }

    private companion object {
        /** Long enough to ride out an evening offline; a receipt days late is no use. */
        const val TTL_MS = 24L * 60L * 60L * 1000L
    }
}
