package isl.snudursopi.fridge.data.backend

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private const val TAG = "SelfTest"

/**
 * *** FIND THE FAULT BEFORE A PAYING CUSTOMER DOES (Siggi, 2026-10-19).
 *
 * Every [INTERVAL_MS] the machine checks itself — scales, clock, Device Owner, Weimi, storage,
 * memory, payment link — and posts the result to `POST /api/v1/machines/{code}/self-test`. The
 * backend decides what is wrong (it also knows sales and history) and puts it in Fleet → Health
 * and the 07:45 morning report.
 *
 * Only while idle: [snapshot] returns null when a customer is at the machine, and the test is
 * retried a minute later instead of competing with a sale.
 */
class SelfTestReporter(
    private val http: FridgeBackendHttp,
    private val deviceCode: String,
) {
    fun start(scope: CoroutineScope, snapshot: suspend () -> Map<String, Any?>?) {
        scope.launch {
            delay(FIRST_DELAY_MS)
            while (isActive) {
                var body: Map<String, Any?>? = null
                for (attempt in 0 until BUSY_RETRIES) {
                    body = runCatching { snapshot() }.getOrNull()
                    if (body != null) break
                    delay(BUSY_RETRY_MS)
                }
                if (body != null) {
                    runCatching { http.postJson("/api/v1/machines/$deviceCode/self-test", body) }
                        .onSuccess { Log.i(TAG, "self-test reported") }
                        .onFailure { Log.w(TAG, "self-test not sent: ${it.message}") }
                } else {
                    Log.w(TAG, "self-test skipped — machine busy for ${BUSY_RETRIES} minutes")
                }
                delay(INTERVAL_MS)
            }
        }
    }

    companion object {
        const val INTERVAL_MS = 15L * 60L * 1000L
        const val FIRST_DELAY_MS = 2L * 60L * 1000L
        const val BUSY_RETRY_MS = 60_000L
        const val BUSY_RETRIES = 10
    }
}
