package isl.snudursopi.fridge.data.backend

import android.util.Log
import com.fasterxml.jackson.databind.JsonNode

/** One command the backend wants this machine to carry out. */
data class MachineCommand(
    val id: String,
    val type: String,
    val params: JsonNode?,
) {
    fun str(name: String): String? =
        params?.get(name)?.takeIf { !it.isNull }?.asText()?.takeIf { it.isNotBlank() }

    fun int(name: String): Int? =
        params?.get(name)?.takeIf { !it.isNull && it.isNumber }?.asInt()

    fun bool(name: String, default: Boolean = false): Boolean =
        params?.get(name)?.takeIf { !it.isNull }?.asBoolean() ?: default
}

/** What happened when we tried. Maps onto the backend's three statuses. */
sealed class CommandOutcome(val status: String, val detail: String) {
    class Ok(detail: String = "") : CommandOutcome("ok", detail)

    /** We understood it and it didn't work — or we refused it on purpose. */
    class Failed(detail: String) : CommandOutcome("failed", detail)

    /**
     * This build doesn't know this command type. Distinct from Failed on
     * purpose: during a staged OTA the fleet runs mixed versions, and "too old
     * for that command" is a different fact from "it broke".
     */
    class Unsupported(detail: String) : CommandOutcome("unsupported", detail)
}

/**
 * Pulls queued commands and reports what happened.
 *
 * The queue is the backend's, already in production for the coil app's restart
 * and cooling commands — this is just the fridge end of the same pipe.
 */
class CommandClient(
    private val http: FridgeBackendHttp,
    private val deviceCode: String,
) {
    private companion object { const val TAG = "CommandClient" }

    /** Anything waiting for us. An empty list is the normal answer. */
    suspend fun pending(): List<MachineCommand> {
        val body = http.getJson("/api/v1/machines/$deviceCode/commands")
        val arr = body.commandsArray()
        if (arr == null) {
            // The one case that must never be silent. A well-formed empty list is
            // normal and logs nothing; a reply we can't read at all is a bug, and
            // returning emptyList() quietly made those two indistinguishable —
            // which cost a debugging round the first time a command was queued.
            Log.w(TAG, "no commands array in reply: ${body.toString().take(200)}")
            return emptyList()
        }
        return arr.mapNotNull { n ->
            val id = n.get("id")?.takeIf { !it.isNull }?.asText()?.takeIf { it.isNotBlank() }
                ?: return@mapNotNull null
            val type = n.get("type")?.takeIf { !it.isNull }?.asText()?.takeIf { it.isNotBlank() }
                ?: return@mapNotNull null
            MachineCommand(id = id, type = type, params = n.get("params"))
        }
    }

    /**
     * Find the command array, whatever envelope it arrives in.
     *
     * The live shape is {ok, data:{commands:[...]}} — I originally assumed
     * {ok, data:[...]} and the mismatch produced an empty list with no error,
     * so the machine ignored a queued command in silence. Accept the variants
     * rather than depend on one.
     */
    private fun JsonNode.commandsArray(): JsonNode? {
        get("data")?.get("commands")?.takeIf { it.isArray }?.let { return it }
        get("data")?.takeIf { it.isArray }?.let { return it }
        get("commands")?.takeIf { it.isArray }?.let { return it }
        if (isArray) return this
        return null
    }

    /**
     * Report the outcome. The backend is idempotent here and takes the first
     * result, so a retry after a flaky network is safe.
     */
    suspend fun report(commandId: String, outcome: CommandOutcome) {
        http.postJson(
            "/api/v1/machines/$deviceCode/commands/$commandId/result",
            mapOf(
                "status" to outcome.status,
                "detail" to outcome.detail,
                "completedAt" to System.currentTimeMillis(),
            ),
        )
    }
}
