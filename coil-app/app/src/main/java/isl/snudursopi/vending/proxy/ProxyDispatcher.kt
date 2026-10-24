package isl.snudursopi.vending.proxy

import com.fasterxml.jackson.databind.JsonNode
import isl.snudursopi.vending.api.WeimiHttp
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Translates a proxy request from the backend into a Weimi API call and
 * extracts the `data` field for the response.
 *
 * Stays out of WebSocket concerns — pure async function. The proxy client
 * calls into this and serializes the result over the socket.
 *
 * Allowed actions are explicitly listed; unknown actions are rejected.
 * This bounds the backend's blast radius: no future expansion without an
 * explicit code change here.
 */
class ProxyDispatcher(
    private val weimiHttp: WeimiHttp,
) {

    /** Returned to the WebSocket layer for serialization. */
    sealed class Result {
        data class Ok(val data: JsonNode) : Result()
        data class Err(val message: String) : Result()
    }

    /**
     * Dispatch a single proxy request. Returns [Result.Ok] with the
     * Weimi `data` field on success, [Result.Err] with a short message
     * on failure.
     *
     * Times out after [BackendConfig.PROXY_REQUEST_TIMEOUT_MS]. The
     * backend's own timeout is longer (per addendum), so we respond
     * before that fires.
     */
    suspend fun dispatch(action: String, params: JsonNode): Result {
        return try {
            val result = withTimeoutOrNull(BackendConfig.PROXY_REQUEST_TIMEOUT_MS) {
                when (action) {
                    "deviceProfile" -> doDeviceProfile(params)
                    "deviceInfo" -> doDeviceInfo(params)
                    "queryOrders" -> doQueryOrders(params)
                    else -> throw IllegalArgumentException("unknown action: $action")
                }
            } ?: return Result.Err("timed out after ${BackendConfig.PROXY_REQUEST_TIMEOUT_MS}ms")
            Result.Ok(result)
        } catch (e: Exception) {
            Result.Err(e.message ?: e.javaClass.simpleName)
        }
    }

    private suspend fun doDeviceProfile(params: JsonNode): JsonNode {
        // params: { "deviceCodes": ["...", "..."] }
        // Weimi expects: ?deviceCodes=a,b,c  — comma-joined.
        val deviceCodes = params.path("deviceCodes")
            .let { node ->
                if (!node.isArray) throw IllegalArgumentException("deviceCodes must be an array")
                node.joinToString(",") { it.asText() }
            }
        val response = weimiHttp.get(
            path = "/ext/device-profile",
            params = mapOf("deviceCodes" to deviceCodes),
        )
        return response.path("data").requireNotMissing("data")
    }

    private suspend fun doDeviceInfo(params: JsonNode): JsonNode {
        // params: { "deviceCode": "..." }
        // Weimi returns data as an array; addendum says return the first (only) element.
        val deviceCode = params.path("deviceCode").asText().ifBlank {
            throw IllegalArgumentException("deviceCode required")
        }
        val response = weimiHttp.get(
            path = "/ext/device-info",
            params = mapOf("deviceCodes" to deviceCode),
        )
        val data = response.path("data").requireNotMissing("data")
        return if (data.isArray && data.size() > 0) data.get(0) else data
    }

    private suspend fun doQueryOrders(params: JsonNode): JsonNode {
        // POST /ext/query-order-list with the params as JSON body (signed).
        // Strip nulls before signing — addendum requirement. Jackson can
        // serialize JsonNode values directly so we don't need to unbox.
        val cleaned = mutableMapOf<String, Any?>()
        params.fields().forEachRemaining { (key, value) ->
            if (!value.isNull) cleaned[key] = value
        }
        val response = weimiHttp.post(
            path = "/ext/query-order-list",
            params = cleaned,
        )
        return response.path("data").requireNotMissing("data")
    }

    private fun JsonNode.requireNotMissing(name: String): JsonNode {
        if (isMissingNode || isNull) {
            throw IllegalStateException("Weimi response missing field: $name")
        }
        return this
    }
}
