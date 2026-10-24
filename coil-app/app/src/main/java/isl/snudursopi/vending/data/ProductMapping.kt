package isl.snudursopi.vending.data

import isl.snudursopi.vending.api.Aisle
import isl.snudursopi.vending.api.SlotCodeTranslator
import isl.snudursopi.vending.domain.Category
import isl.snudursopi.vending.domain.Product

/**
 * Map a list of Weimi aisles into deduplicated domain products.
 *
 * A single product can occupy multiple aisles (e.g. "Corny Big Súkkulaði"
 * in A1, A2, A3). We consolidate those into one Product:
 *  - stock = sum of currStock across all aisles
 *  - slots = list of all slot codes (used at dispense time to pick a slot)
 *  - slot  = first slot (for backwards-compat display)
 *  - price = uses the first aisle's price (we assume same product = same price)
 *
 * Filtering rules per aisle:
 *  - drop blank goodsName
 *  - drop broken aisles
 *  - drop operator-disabled aisles
 */
fun List<Aisle>.toProducts(): List<Product> {
    // Configure slot translator once, since all aisles share the encoding
    SlotCodeTranslator.columnBaseZero = true

    // Learn each row's width from the machine's own aisle list BEFORE anything
    // resolves a slot. Rows are not all the same width — Faxatorg has 9 lanes on
    // rows 1-4 and 7 on rows 5-6 — and because the column is reversed, the width
    // is part of the address. Assuming 9 on a 7-wide row addresses a different
    // bay entirely, or a raw index the board rejects as an open circuit.
    SlotCodeTranslator.learnRowWidths(this.map { it.code })

    // Group aisles by goodsId (or by aisle id if goodsId is missing)
    val grouped = this
        .filter { aisle ->
            // We own bay visibility via disabledAisles (our dashboard). We no longer
            // defer to Weimi's isEnable/isBroken — those are Weimi-cloud flags we can't
            // write, so letting them veto meant a Weimi-disabled bay could never be
            // brought back without the Weimi app online (which we've replaced). Show any
            // aisle that has a product; disabledAisles is the sole hide mechanism, and a
            // physically jammed bay is handled by the operator disabling it + the normal
            // failed-dispense path (no charge).
            aisle.goodsName?.isNotBlank() == true
        }
        .groupBy { it.goodsId ?: it.id }

    return grouped.mapNotNull { (productId, aisles) ->
        // Take the first aisle for non-aggregated fields (name, price, image, etc.)
        val first = aisles.first()
        val name = first.goodsName?.takeIf { it.isNotBlank() } ?: return@mapNotNull null

        // Translate each aisle's API slot code to a friendly slot. If any can't
        // be translated, skip just that one (don't lose the whole product).
        val slots = aisles.mapNotNull { SlotCodeTranslator.fromApiCode(it.code) }
        if (slots.isEmpty()) return@mapNotNull null

        val totalStock = aisles.sumOf { it.currStock }
        val goodsTypeNames = first.goodsTypeList.map { it.name }
        val category = inferCategory(name, goodsTypeNames)
        val image = first.thumbnailUrl ?: first.imgUrl

        Product(
            id = productId,
            slot = slots.first(),
            slots = slots,
            name = name.lowercase(),
            subtitle = null,
            priceIsk = first.priceKr,
            category = category,
            imagePath = image,
            stock = totalStock,
            featured = false,
            hidden = false,
            hideWhenEmpty = true,
        )
    }
}

private fun inferCategory(name: String, goodsTypeNames: List<String>): Category {
    val types = goodsTypeNames.joinToString(" ").lowercase()
    when {
        "orkudrykk" in types || "drykk" in types -> return Category.Drinks
        "orkustang" in types || "stang" in types -> return Category.Snacks
        "kaffi" in types -> return Category.Coffee
        "sælg" in types || "sætt" in types -> return Category.Sweet
        "holl" in types -> return Category.Healthy
    }

    val n = name.lowercase()
    return when {
        "kaffi" in n || "espress" in n || "latte" in n || "cappuc" in n ->
            Category.Coffee

        "skyr" in n || "hydra" in n || "rafvökv" in n ||
            "prótein" in n || "protein" in n || "oat king" in n ||
            "barebells" in n ->
            Category.Healthy

        "powerade" in n || "fylkis" in n || "kók" in n || "cola" in n ||
            "drykk" in n || "vatn" in n ->
            Category.Drinks

        "súkkul" in n || "sukkul" in n || "chocolate" in n || "choc" in n ||
            "sætt" in n || "sweet" in n || "candy" in n || "nammi" in n ->
            Category.Sweet

        "corny" in n || "bar " in n || "biscuit" in n ||
            "chips" in n || "snakk" in n || "pagen" in n || "giff" in n ->
            Category.Snacks

        else -> Category.Other
    }
}
