package isl.snudursopi.vending.data.backend

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Instant

private const val TAG = "PaymentWatch"

/** What the Nayax link looks like right now. */
data class PaymentLinkStatus(
    val up: Boolean,
    val port: String?,
    val lastReadyAtMs: Long?,
    /** Terminal decimal places from the last handshake; anything but 0 mis-charges ISK. */
    val decimalPlace: Int? = null,
    /** Serial number, Monyx ID, firmware… from the last handshake. */
    val reader: Map<String, String>? = null,
)

/**
 * A machine that cannot take cards must say so.
 *
 * Copied from the fridge app (0.58.0, reader identity 0.69.1). Nothing on the
 * customer screen shows a dead payment link until someone tries to pay, and the
 * relayed log only shows it to someone already looking. This posts the link state
 * to the backend, which raises an alert when it stays down and shows the reader's
 * serial in the machine header (it read "Nayax —" for every coil machine until now).
 *
 * Samples every 30 s; posts on any change and every 5 minutes regardless, so the
 * backend can tell "still down" from "stopped reporting".
 */
class PaymentStatusReporter(
    private val http: AdminBackendHttp,
    private val deviceCode: String,
) {
    fun start(scope: CoroutineScope, current: () -> PaymentLinkStatus) {
        scope.launch {
            var last: PaymentLinkStatus? = null
            var lastPostMs = 0L
            while (isActive) {
                val now = System.currentTimeMillis()
                val cur = runCatching(current).getOrNull()
                if (cur != null && shouldPost(last, cur, lastPostMs, now)) {
                    runCatching { post(cur) }
                        .onSuccess {
                            if (last?.up != cur.up) {
                                Log.i(TAG, "payment link ${if (cur.up) "UP" else "DOWN"} on ${cur.port} — reported")
                            }
                            last = cur
                            lastPostMs = now
                        }
                        // Not recorded as sent, so the next sample tries again.
                        .onFailure { Log.w(TAG, "payment status post failed: ${it.message}") }
                }
                delay(SAMPLE_MS)
            }
        }
    }

    private suspend fun post(s: PaymentLinkStatus) {
        http.postJson(
            "/api/v1/machines/$deviceCode/payment-status",
            mapOf(
                "up" to s.up,
                "port" to s.port,
                "lastReadyAt" to s.lastReadyAtMs?.let { Instant.ofEpochMilli(it).toString() },
                "decimalPlace" to s.decimalPlace,
                "reader" to s.reader,
            ),
        )
    }

    companion object {
        const val SAMPLE_MS = 30_000L
        const val HEARTBEAT_MS = 5L * 60L * 1000L
        /** Pure, so the posting rule is testable without a network. */
        fun shouldPost(last: PaymentLinkStatus?, cur: PaymentLinkStatus, lastPostMs: Long, now: Long): Boolean =
            last == null ||
                last.up != cur.up ||
                last.port != cur.port ||
                last.decimalPlace != cur.decimalPlace ||
                last.reader != cur.reader ||
                now - lastPostMs >= HEARTBEAT_MS
    }
}
