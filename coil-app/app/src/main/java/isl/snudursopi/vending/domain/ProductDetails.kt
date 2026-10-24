package isl.snudursopi.vending.domain

/**
 * Optional, per-product editorial details shown on the product detail
 * screen (pack size, nutrition, ingredients, allergens). Sourced from the
 * admin backend's `/product-details` endpoint, keyed by product code
 * (== Product.id == Weimi goodsId), and merged in at render time.
 *
 * EVERYTHING is optional. A product with no details (or no entry at all)
 * falls back to the photo-only detail screen — see DetailScreen. Each field
 * renders only when present, so a half-filled entry is fine.
 *
 * The text fields (ingredients, allergens, notes) are stored as supplied —
 * currently English only; a separate Icelandic text field is not in scope.
 * Only the static UI labels are localized.
 */
data class ProductDetails(
    val packSize: String? = null,        // "330 ml"
    val basis: String? = null,           // nutrition basis, e.g. "per 100 ml"
    val ingredients: String? = null,
    val allergens: List<String> = emptyList(),     // solid pills
    val mayContain: List<String> = emptyList(),     // outline pills
    val notes: String? = null,
    val nutrition: Nutrition? = null,
) {
    /**
     * True if there's anything worth showing beyond the photo/name/price.
     * When false, the detail screen uses the photo-only fallback.
     */
    val hasAnyDetail: Boolean
        get() = !packSize.isNullOrBlank() ||
            !ingredients.isNullOrBlank() ||
            !notes.isNullOrBlank() ||
            allergens.isNotEmpty() ||
            mayContain.isNotEmpty() ||
            (nutrition?.hasAnyValue == true)
}

/**
 * Nutrition values, per the [ProductDetails.basis] (e.g. per 100 ml).
 * Each value is optional — a null value means "skip this row". If every
 * value is null, the whole nutrition table is hidden.
 */
data class Nutrition(
    val energyKj: Double? = null,
    val energyKcal: Double? = null,
    val fat: Double? = null,
    val saturates: Double? = null,
    val carbs: Double? = null,
    val sugars: Double? = null,
    val protein: Double? = null,
    val fibre: Double? = null,
    val salt: Double? = null,
) {
    val hasAnyValue: Boolean
        get() = listOf(
            energyKj, energyKcal, fat, saturates, carbs, sugars, protein, fibre, salt,
        ).any { it != null }
}
