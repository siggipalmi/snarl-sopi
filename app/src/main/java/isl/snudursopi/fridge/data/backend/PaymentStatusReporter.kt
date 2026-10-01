package isl.snudursopi.fridge.data.backend

import android.util.Log
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Instant

private const val TAG = "PaymentWatch"

/** What the Nayax link looks like right now. */
data class PaymentLinkStatus(val up: Boolean, val port: String?, val lastReadyAtMs: Long?)

/**
 * *** A MACHINE THAT CANNOT TAKE CARDS MUST SAY SO.
 *
 * Nothing on the customer screen shows a dead payment link until someone tries
 * to pay, and the relayed log only shows it to someone already looking. This
 * posts the link state to the backend, which raises an alert and emails the AG
 * admins when it stays down (backend v6.42.0, POST /payment-status).
 *
 * Samples every 30s; posts on any change and every 5 minutes regardless, so the
 * backend can tell "still down" from "stopped reporting".
 */
class PaymentStatusReporter(
    private val http: FridgeBackendHttp,
    private val deviceCode: String,
) {
    private val mapper = jacksonObjectMapper()

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
        val body = mapper.writeValueAsString(
            buildMap<String, Any?> {
                put("up", s.up)
                put("port", s.port)
                put("lastReadyAt", s.lastReadyAtMs?.let { Instant.ofEpochMilli(it).toString() })
            },
        )
        http.postRawJson("/api/v1/machines/$deviceCode/payment-status", body)
    }

    companion object {
        const val SAMPLE_MS = 30_000L
        const val HEARTBEAT_MS = 5L * 60L * 1000L

        /** Pure, so the posting rule is testable without a network. */
        fun shouldPost(
            last: PaymentLinkStatus?,
            cur: PaymentLinkStatus,
            lastPostMs: Long,
            now: Long,
        ): Boolean =
            last == null ||
                last.up != cur.up ||
                last.port != cur.port ||
                now - lastPostMs >= HEARTBEAT_MS
    }
}
