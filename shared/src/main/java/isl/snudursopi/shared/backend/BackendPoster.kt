package isl.snudursopi.shared.backend

import com.fasterxml.jackson.databind.JsonNode

/**
 * The one call shared reporters need from an app's backend HTTP helper: a JSON POST
 * with the machine key already attached. Both apps' helpers have exactly this method;
 * they only declare that they implement it.
 */
interface BackendPoster {
    suspend fun postJson(path: String, body: Map<String, Any?>): JsonNode
}
