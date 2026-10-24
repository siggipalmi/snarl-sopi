package isl.snudursopi.vending.domain

/**
 * A per-product offer from the backend config `offers[]` block (backend v5.28).
 * Display only — the `/quote` endpoint stays authoritative for the actual charge.
 */
enum class OfferKind { Percent, Fixed, Price, Expiry, Multibuy, Combo, Unknown }

/** One product in a combo group (for the detail-screen pairing). */
data class ComboItem(val goodsId: String, val name: String)

/** A combo group: pick one item from each group to complete the combo.
 *  [label] is a short human name ("drykkur") when the backend authors one
 *  (null for now — generic fallback applies). */
data class ComboGroup(val label: String?, val items: List<ComboItem>)

data class Offer(
    val goodsId: String,
    val kind: OfferKind,
    /** percent off (percent/expiry), kr off (fixed), or set price (price). */
    val value: Int? = null,
    /** Days until the soonest in-stock batch expires (expiry only). */
    val daysLeft: Int? = null,
    /** Backend-computed discounted price off the machine price (price-drop kinds). */
    val discountedPriceIsk: Int? = null,
    /** Multibuy: buy [qty] for [totalKr] kr total. */
    val qty: Int? = null,
    val totalKr: Int? = null,
    /** Combo grouping (combo only); members repeated on each member's offer. */
    val comboId: String? = null,
    val comboGroups: List<ComboGroup> = emptyList(),
) {
    /** Whether this kind shows a discounted + struck price on the tile. */
    val hasPriceDrop: Boolean
        get() = kind == OfferKind.Percent || kind == OfferKind.Fixed ||
            kind == OfferKind.Price || kind == OfferKind.Expiry

    /** Discounted price to show on the tile. Prefers the backend value; falls
     *  back to computing it off [basePriceIsk] only if the backend omitted it. */
    fun discountedDisplayPriceIsk(basePriceIsk: Int): Int? {
        discountedPriceIsk?.let { return it.coerceIn(0, basePriceIsk) }
        return when (kind) {
            OfferKind.Percent, OfferKind.Expiry ->
                value?.let { ((basePriceIsk * (100 - it) + 50) / 100).coerceIn(0, basePriceIsk) }
            OfferKind.Fixed -> value?.let { (basePriceIsk - it).coerceIn(0, basePriceIsk) }
            OfferKind.Price -> value?.coerceIn(0, basePriceIsk)
            else -> null
        }
    }

    /** Main red-bar label, or null for plain markdown (its struck price is enough). */
    fun dealBarMain(language: Language): String? = when (kind) {
        OfferKind.Expiry -> if (language == Language.English) "Use by soon" else "Síðasti söludagur"
        OfferKind.Multibuy -> multibuyLabel(language)
        OfferKind.Combo -> "Combo"
        else -> null
    }

    /** Optional second bar line — expiry days-left. */
    fun dealBarSub(language: Language): String? =
        if (kind == OfferKind.Expiry) daysLeft?.let { daysPhrase(language, it) } else null

    private fun multibuyLabel(language: Language): String {
        val q = qty
        val t = totalKr
        return if (q != null && t != null) {
            if (language == Language.English) "$q for $t kr" else "$q fyrir $t kr"
        } else {
            if (language == Language.English) "Deal" else "Tilboð"
        }
    }

    private fun daysPhrase(language: Language, n: Int): String = when {
        language == Language.English -> when {
            n <= 0 -> "Last day"
            n == 1 -> "1 day left"
            else -> "$n days left"
        }
        n <= 0 -> "Síðasti dagur"
        n == 1 -> "1 dagur eftir"
        else -> "$n dagar eftir"
    }
}

fun String?.toOfferKind(): OfferKind = when (this?.lowercase()) {
    "percent" -> OfferKind.Percent
    "fixed" -> OfferKind.Fixed
    "price" -> OfferKind.Price
    "expiry" -> OfferKind.Expiry
    "multibuy" -> OfferKind.Multibuy
    "combo" -> OfferKind.Combo
    else -> OfferKind.Unknown
}
