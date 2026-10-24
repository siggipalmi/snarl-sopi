package isl.snudursopi.vending.data.backend

import com.fasterxml.jackson.databind.JsonNode
import isl.snudursopi.vending.domain.Nutrition
import isl.snudursopi.vending.domain.ProductDetails

/**
 * Fetches per-machine product details (nutrition, ingredients, allergens)
 * from the admin backend.
 *
 * Endpoint: `GET /api/v1/machines/{deviceCode}/product-details`
 *   - Auth: `X-Machine-Key` (handled by [AdminBackendHttp])
 *   - `If-None-Match: <version>` → 304 when unchanged
 *
 * Envelope:
 * ```
 * { "version": 7, "products": {
 *     "<productCode>": {
 *        "packSize", "basis", "ingredients", "notes",
 *        "allergens": ["Milk"], "mayContain": [],
 *        "nutrition": { "energyKj", "energyKcal", "fat", "saturates",
 *                       "carbs", "sugars", "protein", "fibre", "salt" }
 *     }, ...
 * } }
 * ```
 *
 * Like [ConfigClient], this just turns JSON into typed data; merging into
 * the live catalog (by product code) is the ViewModel's job.
 */
class ProductDetailsClient(
    private val http: AdminBackendHttp,
) {
    suspend fun fetch(deviceCode: String, etag: String?): Result {
        val path = "/api/v1/machines/$deviceCode/product-details"
        return when (val fetch = http.getJsonWithEtag(path, etag)) {
            is ConfigFetch.NotModified -> Result.Unchanged
            is ConfigFetch.Modified -> parse(fetch.body)
        }
    }

    private fun parse(root: JsonNode): Result.Loaded {
        val data = root.get("data")?.takeIf { it.isObject } ?: root

        val version = data.get("version")?.asText()?.takeIf { it.isNotBlank() }

        val productsNode = data.get("products")?.takeIf { it.isObject }
        val byCode: Map<String, ProductDetails> = buildMap {
            productsNode?.fields()?.forEach { (code, node) ->
                if (code.isNotBlank() && node != null && node.isObject) {
                    put(code, parseOne(node))
                }
            }
        }

        return Result.Loaded(detailsByCode = byCode, version = version)
    }

    private fun parseOne(node: JsonNode): ProductDetails {
        return ProductDetails(
            packSize = node.text("packSize"),
            basis = node.text("basis"),
            ingredients = node.text("ingredients"),
            allergens = node.stringList("allergens"),
            mayContain = node.stringList("mayContain"),
            notes = node.text("notes"),
            nutrition = node.get("nutrition")?.takeIf { it.isObject }?.let { n ->
                Nutrition(
                    energyKj = n.dbl("energyKj"),
                    energyKcal = n.dbl("energyKcal"),
                    fat = n.dbl("fat"),
                    saturates = n.dbl("saturates"),
                    carbs = n.dbl("carbs"),
                    sugars = n.dbl("sugars"),
                    protein = n.dbl("protein"),
                    fibre = n.dbl("fibre"),
                    salt = n.dbl("salt"),
                )
            },
        )
    }

    // ---- JSON helpers ----

    private fun JsonNode.text(field: String): String? =
        get(field)?.asText()?.takeIf { it.isNotBlank() }

    private fun JsonNode.dbl(field: String): Double? {
        val v = get(field) ?: return null
        if (v.isNull) return null
        return if (v.isNumber) v.asDouble() else v.asText().toDoubleOrNull()
    }

    /**
     * Allergens/mayContain are arrays of strings. Back-compat: if a
     * deployment sends a single string, treat it as a one-element list.
     */
    private fun JsonNode.stringList(field: String): List<String> {
        val v = get(field) ?: return emptyList()
        return when {
            v.isArray -> v.mapNotNull { it.asText()?.takeIf { s -> s.isNotBlank() } }
            v.isTextual -> v.asText().takeIf { it.isNotBlank() }?.let { listOf(it) } ?: emptyList()
            else -> emptyList()
        }
    }

    sealed class Result {
        /** 304 — details unchanged; keep the cached map. */
        object Unchanged : Result()

        /** 200 — parsed details keyed by product code. */
        data class Loaded(
            val detailsByCode: Map<String, ProductDetails>,
            val version: String?,
        ) : Result()
    }
}
