package isl.snudursopi.fridge.data.backend

import com.fasterxml.jackson.databind.JsonNode
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
 * HTTP client for the AG Vending admin backend (fridge side).
 *
 * Ported from the coil app's AdminBackendHttp, which is proven in production —
 * same auth model (`X-Machine-Key`), same error categorisation. Two additions
 * for the fridge:
 *  - [postRawJson], because settlement bodies are built as a JSONObject by
 *    [SettlementReport] rather than a Kotlin Map.
 *  - [ConfigFetch.Modified] now carries the response ETag, so the config poll
 *    can store it without a second round trip.
 *
 * Failures bubble as [BackendException] with a [BackendException.Kind] so
 * callers can decide whether to retry, queue, or escalate.
 */
class FridgeBackendHttp(
    private val baseUrl: String,
    private val machineKey: String,
    httpClient: OkHttpClient? = null,
) {
    private val mapper = jacksonObjectMapper()
    private val client: OkHttpClient = httpClient ?: OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** POST a JSON body already serialised to a string. */
    suspend fun postRawJson(path: String, json: String): JsonNode =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url(baseUrl + path)
                .header("X-Machine-Key", machineKey)
                .header("Content-Type", "application/json")
                .post(json.toRequestBody(JSON_MEDIA))
                .build()
            execute(req)
        }

    /** POST a JSON payload built from a Kotlin map. */
    suspend fun postJson(path: String, body: Map<String, Any?>): JsonNode =
        postRawJson(path, mapper.writeValueAsString(body))

    /** Plain GET returning parsed JSON on 2xx. */
    suspend fun getJson(path: String): JsonNode =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url(baseUrl + path)
                .header("X-Machine-Key", machineKey)
                .get()
                .build()
            execute(req)
        }

    /**
     * Conditional GET supporting `If-None-Match`. The config poll is also the
     * presence heartbeat, so a 304 is a SUCCESSFUL outcome (the backend records
     * "last seen" before the 304 check) — not an error.
     */
    suspend fun getJsonWithEtag(path: String, etag: String?): ConfigFetch =
        withContext(Dispatchers.IO) {
            val builder = Request.Builder()
                .url(baseUrl + path)
                .header("X-Machine-Key", machineKey)
                .get()
            if (!etag.isNullOrBlank()) {
                builder.header("If-None-Match", etag)
            }
            val req = builder.build()
            try {
                client.newCall(req).execute().use { response ->
                    val responseBody = response.body?.string().orEmpty()
                    when {
                        response.code == 304 -> ConfigFetch.NotModified
                        response.isSuccessful -> {
                            val node = if (responseBody.isBlank()) mapper.createObjectNode()
                            else mapper.readTree(responseBody)
                            ConfigFetch.Modified(node, response.header("ETag"))
                        }
                        else -> throw errorFor(response.code, responseBody)
                    }
                }
            } catch (e: BackendException) {
                throw e
            } catch (e: IOException) {
                throw BackendException(BackendException.Kind.NetworkError, e.message ?: "network failure", e)
            } catch (e: Exception) {
                throw BackendException(BackendException.Kind.Unknown, e.message ?: e.javaClass.simpleName, e)
            }
        }

    private fun execute(req: Request): JsonNode =
        try {
            client.newCall(req).execute().use { response ->
                val responseBody = response.body?.string().orEmpty()
                when {
                    // 2xx and 409 both count as delivered: 409 means the
                    // backend already has this orderId, which is exactly what
                    // an idempotent replay should look like.
                    response.isSuccessful || response.code == 409 -> {
                        if (responseBody.isBlank()) mapper.createObjectNode()
                        else mapper.readTree(responseBody)
                    }
                    else -> throw errorFor(response.code, responseBody)
                }
            }
        } catch (e: BackendException) {
            throw e
        } catch (e: IOException) {
            throw BackendException(BackendException.Kind.NetworkError, e.message ?: "network failure", e)
        } catch (e: Exception) {
            throw BackendException(BackendException.Kind.Unknown, e.message ?: e.javaClass.simpleName, e)
        }

    private fun errorFor(code: Int, body: String): BackendException = when {
        code == 401 -> BackendException(
            BackendException.Kind.Unauthorized,
            "machine key rejected by backend",
        )
        code in 400..499 -> BackendException(
            BackendException.Kind.ClientError,
            "HTTP $code: ${truncate(body)}",
        )
        else -> BackendException(
            BackendException.Kind.ServerError,
            "HTTP $code: ${truncate(body)}",
        )
    }

    private fun truncate(s: String): String =
        if (s.length <= 200) s else s.take(200) + "…"

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}

/** Result of a conditional config fetch. */
sealed class ConfigFetch {
    /** HTTP 304 — config unchanged; keep the cached planogram. Still a heartbeat. */
    object NotModified : ConfigFetch()

    /** HTTP 200 — new config. [body] is the `{ok, data}` envelope, [etag] its version. */
    data class Modified(val body: JsonNode, val etag: String?) : ConfigFetch()
}

/**
 * Categorised backend failure.
 *
 *  - [Kind.NetworkError] — transient, retry
 *  - [Kind.ServerError]  — transient (5xx), retry
 *  - [Kind.Unauthorized] — terminal; re-provisioning required
 *  - [Kind.ClientError]  — kiosk bug or malformed payload; do NOT retry
 *  - [Kind.Unknown]      — be conservative, retry
 */
class BackendException(
    val kind: Kind,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause) {
    enum class Kind {
        NetworkError,
        ServerError,
        Unauthorized,
        ClientError,
        Unknown,
    }

    /** Whether requeueing for a later retry makes sense. */
    val retryable: Boolean
        get() = kind == Kind.NetworkError || kind == Kind.ServerError || kind == Kind.Unknown
}
