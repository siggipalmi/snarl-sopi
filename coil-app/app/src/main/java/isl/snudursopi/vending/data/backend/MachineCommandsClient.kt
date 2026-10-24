package isl.snudursopi.vending.data.backend

import com.fasterxml.jackson.databind.JsonNode

/**
 * Client for the backend machine-command queue (contract addendum v0.5).
 *
 *  - GET  /api/v1/machines/{deviceCode}/commands            → pending commands
 *  - POST /api/v1/machines/{deviceCode}/commands/{id}/result → kiosk result
 *
 * Auth is the same `X-Machine-Key` header all kiosk calls use, handled by
 * [AdminBackendHttp]. The kiosk pulls on the config poll schedule, runs each
 * command on the hardware, and posts the result back.
 */
class MachineCommandsClient(
    private val http: AdminBackendHttp,
) {
    data class Command(
        val id: String,
        val type: String,
        val params: JsonNode?,
    )

    /** Fetch pending commands. Empty list when none (or on a malformed body). */
    suspend fun fetchPending(deviceCode: String): List<Command> {
        val root = http.getJson("/api/v1/machines/$deviceCode/commands")
        val data = root.get("data")?.takeIf { it.isObject } ?: root
        val arr = data.get("commands")?.takeIf { it.isArray } ?: return emptyList()
        return arr.mapNotNull { node ->
            val id = node.get("id")?.asText()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val type = node.get("type")?.asText()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            Command(id = id, type = type, params = node.get("params"))
        }
    }

    /** Post the result of a command. Body shape per the addendum. */
    suspend fun postResult(deviceCode: String, id: String, body: Map<String, Any?>) {
        http.postJson("/api/v1/machines/$deviceCode/commands/$id/result", body)
    }
}
