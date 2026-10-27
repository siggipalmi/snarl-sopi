package isl.snudursopi.vending.data.backend

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
 * HTTP client for the AG Vending admin backend.
 *
 * Separate from [isl.snudursopi.vending.api.WeimiHttp] because the two
 * backends have different auth models, different content shapes, and
 * different failure modes. Keeping them apart means changes to one
 * never accidentally break the other.
 *
 * Auth is via the `X-Machine-Key` header (per API contract section 2.1).
 *
 * Failures bubble as [BackendException] with a [BackendException.Kind]
 * so callers can decide whether to retry, surrender, or re-provision.
 */
class AdminBackendHttp(
    private val baseUrl: String,
    private val machineKey: String,
    httpClient: OkHttpClient? = null,
) : isl.snudursopi.shared.backend.BackendPoster {
    private val mapper = jacksonObjectMapper()
    private val client: OkHttpClient = httpClient ?: OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /**
     * POST a JSON payload. Returns the parsed JSON response on success
     * (HTTP 2xx). Throws [BackendException] on any failure with a
     * categorized [BackendException.Kind].
     *
     * Note: a 409 Conflict is returned as success — the contract treats
     * it as "complaint already exists" which is fine from the kiosk's
     * perspective. The backend includes the existing complaintId in the
     * response body.
     */
    override suspend fun postJson(path: String, body: Map<String, Any?>): JsonNode =
        withContext(Dispatchers.IO) {
            val json = mapper.writeValueAsString(body)
            val req = Request.Builder()
                .url(baseUrl + path)
                .header("X-Machine-Key", machineKey)
                .header("Content-Type", "application/json")
                .post(json.toRequestBody(JSON_MEDIA))
                .build()
            try {
                client.newCall(req).execute().use { response ->
                    val responseBody = response.body?.string().orEmpty()
                    when {
                        // 2xx and 409 both count as "delivered" for our purposes
                        response.isSuccessful || response.code == 409 -> {
                            if (responseBody.isBlank()) mapper.createObjectNode()
                            else mapper.readTree(responseBody)
                        }
                        response.code == 401 -> throw BackendException(
                            kind = BackendException.Kind.Unauthorized,
                            message = "machine key rejected by backend",
                        )
                        response.code in 400..499 -> throw BackendException(
                            kind = BackendException.Kind.ClientError,
                            message = "HTTP ${response.code}: ${truncate(responseBody)}",
                        )
                        else -> throw BackendException(
                            kind = BackendException.Kind.ServerError,
                            message = "HTTP ${response.code}: ${truncate(responseBody)}",
                        )
                    }
                }
            } catch (e: BackendException) {
                throw e
            } catch (e: IOException) {
                throw BackendException(
                    kind = BackendException.Kind.NetworkError,
                    message = e.message ?: "network failure",
                    cause = e,
                )
            } catch (e: Exception) {
                throw BackendException(
                    kind = BackendException.Kind.Unknown,
                    message = e.message ?: e.javaClass.simpleName,
                    cause = e,
                )
            }
        }

    private fun truncate(s: String): String =
        if (s.length <= 200) s else s.take(200) + "…"

    /**
     * Plain GET returning parsed JSON on 2xx. Used by the machine command
     * poll (no ETag — commands are not cacheable). Same error
     * categorization as [postJson].
     */
    suspend fun getJson(path: String): JsonNode =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url(baseUrl + path)
                .header("X-Machine-Key", machineKey)
                .get()
                .build()
            try {
                client.newCall(req).execute().use { response ->
                    val responseBody = response.body?.string().orEmpty()
                    when {
                        response.isSuccessful ->
                            if (responseBody.isBlank()) mapper.createObjectNode()
                            else mapper.readTree(responseBody)
                        response.code == 401 -> throw BackendException(
                            kind = BackendException.Kind.Unauthorized,
                            message = "machine key rejected by backend",
                        )
                        response.code in 400..499 -> throw BackendException(
                            kind = BackendException.Kind.ClientError,
                            message = "HTTP ${response.code}: ${truncate(responseBody)}",
                        )
                        else -> throw BackendException(
                            kind = BackendException.Kind.ServerError,
                            message = "HTTP ${response.code}: ${truncate(responseBody)}",
                        )
                    }
                }
            } catch (e: BackendException) {
                throw e
            } catch (e: IOException) {
                throw BackendException(
                    kind = BackendException.Kind.NetworkError,
                    message = e.message ?: "network failure",
                    cause = e,
                )
            } catch (e: Exception) {
                throw BackendException(
                    kind = BackendException.Kind.Unknown,
                    message = e.message ?: e.javaClass.simpleName,
                    cause = e,
                )
            }
        }

    /**
     * Conditional GET supporting `If-None-Match`. Used by the config poll,
     * which is also the presence heartbeat — so a 304 is a successful
     * outcome (the backend records "last seen" before the 304 check).
     *
     * Returns:
     *  - [ConfigFetch.NotModified] on HTTP 304 — caller keeps its cache.
     *  - [ConfigFetch.Modified] on HTTP 200 — caller parses the body and
     *    stores the new ETag (configVersion).
     *
     * Throws [BackendException] on any real failure (network / 401 / 5xx),
     * same categorization as [postJson] so the caller's retry/terminal
     * logic is uniform.
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
                            ConfigFetch.Modified(node)
                        }
                        response.code == 401 -> throw BackendException(
                            kind = BackendException.Kind.Unauthorized,
                            message = "machine key rejected by backend",
                        )
                        response.code in 400..499 -> throw BackendException(
                            kind = BackendException.Kind.ClientError,
                            message = "HTTP ${response.code}: ${truncate(responseBody)}",
                        )
                        else -> throw BackendException(
                            kind = BackendException.Kind.ServerError,
                            message = "HTTP ${response.code}: ${truncate(responseBody)}",
                        )
                    }
                }
            } catch (e: BackendException) {
                throw e
            } catch (e: IOException) {
                throw BackendException(
                    kind = BackendException.Kind.NetworkError,
                    message = e.message ?: "network failure",
                    cause = e,
                )
            } catch (e: Exception) {
                throw BackendException(
                    kind = BackendException.Kind.Unknown,
                    message = e.message ?: e.javaClass.simpleName,
                    cause = e,
                )
            }
        }

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}

/**
 * Result of a conditional config fetch.
 */
sealed class ConfigFetch {
    /** HTTP 304 — config unchanged; keep the cached config. Still a heartbeat. */
    object NotModified : ConfigFetch()

    /** HTTP 200 — new config; [body] is the parsed `{ok, data}` envelope. */
    data class Modified(val body: com.fasterxml.jackson.databind.JsonNode) : ConfigFetch()
}

/**
 * Categorized backend failure. The [Kind] lets callers decide whether
 * to retry, requeue, or escalate.
 *
 * - [Kind.NetworkError] — transient, retry
 * - [Kind.ServerError]  — transient (5xx), retry
 * - [Kind.Unauthorized] — terminal; re-provisioning required
 * - [Kind.ClientError]  — kiosk bug or malformed payload; do not retry
 * - [Kind.Unknown]      — be conservative, retry once
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
}
