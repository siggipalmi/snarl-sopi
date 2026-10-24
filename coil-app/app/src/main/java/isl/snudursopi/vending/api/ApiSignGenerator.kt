package isl.snudursopi.vending.api

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.databind.MapperFeature
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import java.security.MessageDigest
import java.util.UUID

/**
 * Generates SIGN header per Weimi spec.
 * SHA-1 over: secretKey={k},nonce={n},timestamp={ms},appId={a},paramJson={j}
 *
 * Algorithm verified against vendor's Java/Python reference (May 2023).
 */
class ApiSignGenerator(
    private val appId: String,
    private val secretKey: String,
) {
    private val mapper = jacksonObjectMapper().apply {
        configure(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY, true)
        enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
        setSerializationInclusion(JsonInclude.Include.NON_NULL)
    }

    fun headers(params: Map<String, Any?>): Map<String, String> {
        val nonce = UUID.randomUUID().toString().replace("-", "")
        val timestamp = System.currentTimeMillis()
        val paramJson = canonicalJson(params)
        val sign = sign(secretKey, nonce, timestamp, appId, paramJson)
        return mapOf(
            "Client-Type" to "EXTERNAL",
            "APP_ID" to appId,
            "TIMESTAMP" to timestamp.toString(),
            "NONCE" to nonce,
            "SIGN" to sign,
            "Content-Type" to "application/json",
        )
    }

    internal fun canonicalJson(params: Map<String, Any?>): String =
        mapper.writeValueAsString(params)

    companion object {
        fun sign(
            secretKey: String,
            nonce: String,
            timestamp: Long,
            appId: String,
            paramJson: String,
        ): String {
            val toSign = "secretKey=$secretKey,nonce=$nonce,timestamp=$timestamp,appId=$appId,paramJson=$paramJson"
            val bytes = MessageDigest.getInstance("SHA-1")
                .digest(toSign.toByteArray(Charsets.UTF_8))
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}
