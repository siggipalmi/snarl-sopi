package isl.snudursopi.vending.data.backend

import com.fasterxml.jackson.databind.JsonNode

/** What a successful pairing hands back. */
data class PairedIdentity(
    val deviceCode: String,
    val deviceName: String,
    val machineKey: String,
)

/**
 * Exchanges a 6-digit pairing code for this machine's identity.
 *
 * Endpoint: `POST /api/v1/provisioning/pair` — **no machine-key auth**, and that
 * is the entire point. A machine being set up has no key, so this is the only
 * door into the backend it can open. The server rate-limits by IP, and a code is
 * single-use and expires two hours after it is generated.
 *
 * The response carries deviceCode, deviceName and machineKey. The backend
 * ROTATES the key on every pair, so pairing also retires whatever the machine
 * was using before — including a key that leaked into a terminal or a chat.
 *
 * Replaces a two-step setup that resolved the vélarnúmer against Weimi and then
 * asked the operator to type a 56-character key. That lookup is what produced
 * "Vél fannst ekki" on every machine assigned to a sub-operator, and it stopped
 * both Grótta machines in October 2026. Nothing here touches Weimi.
 */
class PairingClient(
    private val http: AdminBackendHttp,
) {
    /**
     * Throws [BackendException]; the caller maps the typed kind to a message.
     *
     * Deliberately no interpretation of the error TEXT here. A 404 (unknown,
     * expired, already-used or malformed) and a 429 (too many attempts) both
     * arrive as ClientError, and the server answers all four 404 cases
     * identically on purpose so it cannot be used to discover which of a
     * million codes exist. Reading the message to tell them apart is the exact
     * mistake testMachineKey made — it string-matched "401" against a sentence
     * that did not contain it, so every rejection fell through as "unverified"
     * and the wrong key was stored anyway.
     */
    suspend fun pair(code: String): PairedIdentity {
        val root = http.postJson("/api/v1/provisioning/pair", mapOf("code" to code))
        return parse(root)
    }

    private fun parse(root: JsonNode): PairedIdentity {
        val data = root.get("data")?.takeIf { it.isObject } ?: root
        val deviceCode = data.get("deviceCode")?.asText()?.takeIf { it.isNotBlank() }
            ?: throw BackendException(
                kind = BackendException.Kind.Unknown,
                message = "pairing response had no deviceCode",
            )
        val machineKey = data.get("machineKey")?.asText()?.takeIf { it.isNotBlank() }
            ?: throw BackendException(
                kind = BackendException.Kind.Unknown,
                message = "pairing response had no machineKey",
            )
        return PairedIdentity(
            deviceCode = deviceCode,
            // Older backends (before 6.73.5) did not send a name. Fall back to the
            // code rather than failing: the confirmation step is a nicety, the
            // identity is not.
            deviceName = data.get("deviceName")?.asText()?.takeIf { it.isNotBlank() } ?: deviceCode,
            machineKey = machineKey,
        )
    }
}
