package isl.snudursopi.fridge.data.backend

import com.fasterxml.jackson.databind.JsonNode
import isl.snudursopi.fridge.domain.Basket
import isl.snudursopi.fridge.domain.Cabinet
import isl.snudursopi.fridge.domain.FridgeSpec
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.domain.Planogram
import isl.snudursopi.fridge.domain.Settlement

/**
 * Turns the `fridge` block of `GET /api/v1/machines/:deviceCode/config` into a
 * typed [Planogram] (backend contract v5.67). Tolerant of both the enveloped
 * ({ok,data:{...}}) and bare shapes, matching the coil ConfigClient.
 *
 * Expected shape:
 * ```
 * "fridge": {
 *   "model": "GR-WM22Z1260",
 *   "cabinets": ["A","B"],
 *   "basketCount": 32,
 *   "baskets": [ { cabinet, basket, serialLockNum, productId, name,
 *                  imageUrl, priceIsk, unitWeightG, toleranceG,
 *                  measurementFlag, enabled }, ... ]
 * }
 * ```
 */
object FridgeConfigParser {

    fun parse(root: JsonNode): Planogram? {
        val data = root.get("data")?.takeIf { it.isObject } ?: root
        val fridge = data.get("fridge")?.takeIf { it.isObject } ?: return null

        val model = fridge.get("model")?.takeIf { !it.isNull }?.asText().orEmpty()
        val spec = FridgeSpec.fromModel(model) ?: return null

        val baskets = fridge.get("baskets")?.takeIf { it.isArray }
            ?.mapNotNull { parseBasket(it) }
            ?: emptyList()

        // *** THE BACKEND SERVES language.default / language.available, NESTED.
        //
        // We only ever read the FLAT defaultLanguage / availableLanguages, at
        // the fridge block or top level. The backend never served that shape, so
        // every attempt to set a machine's language silently did nothing — the
        // config arrived, parsed cleanly, and the fields simply were not where
        // we looked. Confirmed against their config on 2026-09-01.
        //
        // Reading BOTH shapes, nested first: matching their existing wire format
        // is cheaper than asking them to change it, and the flat form stays
        // accepted so nothing that might already rely on it breaks.
        val languageBlock = fridge.get("language")?.takeIf { it.isObject }
            ?: data.get("language")?.takeIf { it.isObject }
        val defaultLang = languageOf(languageBlock?.get("default"))
            ?: languageOf(fridge.get("defaultLanguage"))
            ?: languageOf(data.get("defaultLanguage"))
            ?: Language.Icelandic
        val availableNode = languageBlock?.get("available")?.takeIf { it.isArray }
            ?: fridge.get("availableLanguages")?.takeIf { it.isArray }
            ?: data.get("availableLanguages")?.takeIf { it.isArray }
        val available = availableNode
            ?.mapNotNull { languageOf(it) }
            ?.distinct()
            ?.takeIf { it.isNotEmpty() }
            // The default must always be offerable, even if the backend omits it
            // from the list — otherwise the pill could cycle away from it and
            // never come back.
            ?.let { if (defaultLang in it) it else listOf(defaultLang) + it }
            ?: listOf(Language.Icelandic, Language.English, Language.Polish)

        // Operator identity lives in the top-level profile block, same place the
        // coil kiosk reads it from — one contract for both apps.
        val profile = data.get("profile")
        val operator = profile?.get("operatorName")?.takeIf { !it.isNull }?.asText().orEmpty()
        // *** THE PAYMENT PORT MUST SURVIVE A REINSTALL.
        //
        // set_payment_port is app state, so a reinstall or a data clear reverts
        // it and the machine silently stops taking payment again. Serving it in
        // config makes it durable, visible in the dashboard, and settable on a
        // new machine BEFORE it ever fails.
        val paymentPort = fridge.get("paymentSerialPort")?.takeIf { !it.isNull }?.asText()
            ?.takeIf { Regex("^/dev/ttyS[0-9]$").matches(it) }

        val email = profile?.get("supportEmail")?.takeIf { !it.isNull }?.asText().orEmpty()

        return Planogram(
            spec = spec,
            baskets = baskets,
            operatorName = operator,
            supportEmail = email,
            paymentSerialPort = paymentPort,
            defaultLanguage = defaultLang,
            availableLanguages = available,
        )
    }

    /**
     * A field, treating an explicit JSON `null` the same as a missing key.
     *
     * Jackson's [JsonNode.get] returns a NullNode for `"x": null` rather than
     * Kotlin null, so `get("x")?.asInt() ?: default` NEVER reaches the default —
     * NullNode.asInt() is 0 and NullNode.asText() is the string "null". The
     * backend does send explicit nulls (toleranceG and measurementFlag come back
     * null on baskets that have only had a price set), so without this a basket
     * would silently get toleranceG 0 instead of 15, and an unassigned basket
     * would get the productId "null" and look stocked.
     */
    private fun JsonNode.field(name: String): JsonNode? =
        get(name)?.takeIf { !it.isNull }

    /**
     * Resolve a language code. Accepts a bare code ("is") or an object carrying
     * one ({"code":"is","label":"íslenska"}) — the backend said it would send
     * both the code and a human label, so don't assume which shape arrives.
     * Unknown codes are dropped rather than guessed at.
     */
    private fun languageOf(n: JsonNode?): Language? {
        val code = when {
            n == null || n.isNull -> null
            n.isObject -> n.get("code")?.takeIf { !it.isNull }?.asText()
            else -> n.asText()
        }?.trim()?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
        return Language.entries.firstOrNull { it.code == code }
    }

    private fun parseBasket(n: JsonNode): Basket? {
        val number = n.field("basket")?.asInt() ?: return null
        val cabinet = when (n.field("cabinet")?.asText()?.uppercase()) {
            "B" -> Cabinet.B
            else -> Cabinet.A
        }
        return Basket(
            cabinet = cabinet,
            basket = number,
            serialLockNum = n.field("serialLockNum")?.asText().orEmpty(),
            productId = n.field("productId")?.asText()?.takeIf { it.isNotBlank() },
            name = n.field("name")?.asText().orEmpty(),
            imageUrl = n.field("imageUrl")?.asText()?.takeIf { it.isNotBlank() },
            priceIsk = n.field("priceIsk")?.asInt() ?: 0,
            unitWeightG = n.field("unitWeightG")?.asInt() ?: 0,
            toleranceG = n.field("toleranceG")?.asInt() ?: Settlement.DEFAULT_TOLERANCE_G,
            measurementFlag = n.field("measurementFlag")?.asInt() ?: 1,
            enabled = n.field("enabled")?.asBoolean() ?: true,
        )
    }
}
