package isl.snudursopi.fridge.data.backend

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Exchanges a six-digit pairing code for this machine's identity.
 *
 *   POST /api/v1/provisioning/pair  { code }
 *     200 { ok, data: { deviceCode, machineKey } }
 *     404 { error: "invalid_code" }   unknown, malformed, expired or used
 *     429                              rate limited
 *
 * *** THE KEY NEVER PASSES THROUGH A HUMAN.
 *
 * Until now a machine got its identity from adb intent extras, so the machine
 * key went through a clipboard, a shell history and more than once a chat. Here
 * an admin issues a code on the machine's dashboard page, the operator types the
 * code, and the key goes from the backend straight into the identity store.
 *
 * Unauthenticated by necessity — the machine has no key yet — so it has its own
 * client rather than [FridgeBackendHttp], which always sends `X-Machine-Key`.
 * Pairing ROTATES the machine's key on the backend: whatever key the machine
 * held before is dead the moment this returns [PairResult.Paired].
 */
class PairingClient(
    private val baseUrl: String = FridgeBackendConfig.BASE_URL,
    httpClient: OkHttpClient? = null,
) {
    private val client: OkHttpClient = httpClient ?: OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    suspend fun pair(code: String): PairResult =
        withContext(Dispatchers.IO) {
            if (!isWellFormed(code)) return@withContext PairResult.InvalidCode
            val req = Request.Builder()
                .url("$baseUrl/api/v1/provisioning/pair")
                .post(mapper.writeValueAsString(mapOf("code" to code)).toRequestBody(JSON))
                .build()
            try {
                client.newCall(req).execute().use { r -> parse(r.code, r.body?.string()) }
            } catch (e: IOException) {
                // Most often no network, or a wrong clock failing TLS — the
                // admin sheet shows the clock right above for exactly this.
                PairResult.Failed("${e.javaClass.simpleName}: ${e.message}")
            }
        }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val mapper = jacksonObjectMapper()
        private val CODE = Regex("^\\d{6}$")

        fun isWellFormed(code: String): Boolean = CODE.matches(code)

        /** Pure, so the response handling is testable without a server. */
        fun parse(status: Int, body: String?): PairResult {
            when (status) {
                404 -> return PairResult.InvalidCode
                429 -> return PairResult.RateLimited
            }
            if (status !in 200..299) return PairResult.Failed("HTTP $status")
            val data = runCatching { mapper.readTree(body ?: "") }.getOrNull()?.get("data")
            val dc = data?.get("deviceCode")?.takeIf { it.isTextual }?.asText()?.trim()
            val mk = data?.get("machineKey")?.takeIf { it.isTextual }?.asText()?.trim()
            if (dc.isNullOrEmpty() || mk.isNullOrEmpty()) {
                return PairResult.Failed("HTTP $status without deviceCode and machineKey")
            }
            return PairResult.Paired(dc, mk)
        }
    }
}

sealed class PairResult {
    data class Paired(val deviceCode: String, val machineKey: String) : PairResult() {
        // Never let the key reach a log line or a crash report by way of toString().
        override fun toString() = "Paired(deviceCode=$deviceCode, machineKey=<redacted>)"
    }
    object InvalidCode : PairResult()
    object RateLimited : PairResult()
    data class Failed(val reason: String) : PairResult()
}
