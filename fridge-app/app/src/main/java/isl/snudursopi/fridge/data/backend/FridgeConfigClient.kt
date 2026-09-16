package isl.snudursopi.fridge.data.backend

import isl.snudursopi.fridge.domain.Planogram

/**
 * Fetches the planogram from `GET /api/v1/machines/{deviceCode}/config`.
 *
 * The fridge planogram rides the SAME config endpoint the coil kiosk already
 * polls (backend contract v5.67) — it's the `fridge` block of the response,
 * parsed by [FridgeConfigParser]. Conditional on ETag, so an unchanged config
 * costs a 304 and still counts as the presence heartbeat.
 */
class FridgeConfigClient(
    private val http: FridgeBackendHttp,
    private val deviceCode: String,
) {
    sealed class Result {
        /**
         * New planogram. [rawJson] is the untouched response body so the caller
         * can cache it verbatim — that cache is what keeps the machine selling
         * after an offline reboot.
         */
        data class Updated(
            val planogram: Planogram,
            val etag: String?,
            val rawJson: String,
        ) : Result()

        /** Config unchanged — keep the cached planogram. */
        object NotModified : Result()

        /**
         * The response parsed, but carried no usable `fridge` block. Treated
         * separately from a hard failure: the machine may simply not be
         * provisioned as a fridge yet, and we must NOT wipe a good cached
         * planogram over it.
         */
        data class NoFridgeBlock(val etag: String?) : Result()
    }

    /**
     * The value to send back as `If-None-Match`: `configVersion` from the body
     * (enveloped or bare), falling back to the response header.
     */
    private fun configVersionOf(fetched: ConfigFetch.Modified): String? {
        val root = fetched.body
        val fromBody = root.get("configVersion")?.asText()
            ?: root.get("data")?.get("configVersion")?.asText()
        return fromBody?.takeIf { it.isNotBlank() } ?: fetched.etag
    }

    suspend fun fetch(etag: String?): Result =
        when (val fetched = http.getJsonWithEtag("/api/v1/machines/$deviceCode/config", etag)) {
            is ConfigFetch.NotModified -> Result.NotModified
            is ConfigFetch.Modified -> {
                val version = configVersionOf(fetched)
                val planogram = FridgeConfigParser.parse(fetched.body)
                if (planogram == null) Result.NoFridgeBlock(version)
                else Result.Updated(planogram, version, fetched.body.toString())
            }
        }
}
