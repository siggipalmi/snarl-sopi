package isl.snudursopi.vending.api

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class WeimiHttp(
    private val baseUrl: String,
    appId: String,
    secretKey: String,
    httpClient: OkHttpClient? = null,
) {
    private val signer = ApiSignGenerator(appId, secretKey)
    private val mapper = jacksonObjectMapper()

    private val client: OkHttpClient = httpClient ?: OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    suspend fun get(path: String, params: Map<String, Any?> = emptyMap()): JsonNode =
        withContext(Dispatchers.IO) {
            val urlBuilder = (baseUrl + path).toHttpUrl().newBuilder()
            params.forEach { (k, v) ->
                if (v != null) urlBuilder.addQueryParameter(k, v.toString())
            }
            val req = Request.Builder()
                .url(urlBuilder.build())
                .also { signer.headers(params).forEach { (k, v) -> it.header(k, v) } }
                .get()
                .build()
            execute(req)
        }

    suspend fun post(path: String, params: Map<String, Any?> = emptyMap()): JsonNode =
        withContext(Dispatchers.IO) {
            val headers = signer.headers(params)
            val body = signer.canonicalJson(params)
            val req = Request.Builder()
                .url((baseUrl + path).toHttpUrl())
                .also { headers.forEach { (k, v) -> it.header(k, v) } }
                .post(body.toRequestBody(JSON))
                .build()
            execute(req)
        }

    private fun execute(request: Request): JsonNode {
        client.newCall(request).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            android.util.Log.d("WeimiHttp", "${request.method} ${request.url} → ${resp.code}")
            android.util.Log.d("WeimiHttp", "body: $body")
            if (!resp.isSuccessful) throw WeimiApiException.Http(resp.code, body)
            val json = try {
                mapper.readTree(body)
            } catch (e: Exception) {
                throw WeimiApiException.MalformedResponse(body, e)
            }
            val code = json.get("code")?.asInt() ?: 0
            if (code != 200) {
                val msg = json.get("msg")?.asText() ?: "no message"
                throw WeimiApiException.Api(code, msg, json)
            }
            return json
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        const val TEST_BASE_URL = "http://api.weimi24.com/v2022/third-center-web"
        const val PROD_BASE_URL = "https://micron.weimi24.com/v8/third-center-web"
    }
}

sealed class WeimiApiException(message: String) : Exception(message) {
    class Http(val httpStatus: Int, val rawBody: String) :
        WeimiApiException("HTTP $httpStatus — $rawBody")

    class Api(val code: Int, val apiMsg: String, val body: JsonNode) :
        WeimiApiException("Weimi API code=$code msg=$apiMsg")

    class MalformedResponse(val rawBody: String, cause: Throwable) :
        WeimiApiException("Could not parse response: ${cause.message}")
}
