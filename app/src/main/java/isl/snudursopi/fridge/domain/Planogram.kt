package isl.snudursopi.fridge.domain

/**
 * One basket in the fridge planogram, as delivered in the `fridge.baskets[]`
 * block of the machine config (backend contract v5.67).
 *
 * The key fact is [unitWeightG]: quantity removed = weight delta / unit weight.
 * The backend resolves any per-product vs per-basket override server-side, so
 * the value here is ALWAYS the effective one — the app never looks at the
 * product's own weight separately.
 *
 * [cabinet] (A/B) is preserved even though both doors open together, because
 * stocking and dispute resolution are done per cabinet.
 *
 * [serialLockNum] is opaque to us — it's how the weight board addresses the
 * tray on the RS-485 bus; we pass it through and use it only to group baskets
 * onto their physical door/lock.
 */
data class Basket(
    val cabinet: Cabinet,
    val basket: Int,
    val serialLockNum: String,
    val productId: String?,
    val name: String,
    val imageUrl: String?,
    val priceIsk: Int,
    val unitWeightG: Int,
    val toleranceG: Int,
    val measurementFlag: Int,
    val enabled: Boolean,
) {
    /**
     * Protocol tray for this basket — THE ONE PLACE the mapping lives.
     *
     * *** CABINET B STARTS AT ADDRESS 20, NOT 16. CONFIRMED BY WEIMI 2026-08-28.
     *
     * Basket numbers run 1-16 WITHIN EACH CABINET (the backend's planogram key
     * is (deviceCode, cabinet, basket), so cabinet A's basket 1 and cabinet B's
     * basket 1 are different physical baskets). Both cabinets share one RS-485
     * bus, but the vendor addresses them in blocks of 20:
     *
     *   cabinet A basket 1..16 -> tray 0..15
     *   cabinet B basket 1..16 -> tray 20..35
     *
     * We assumed B continued at 16, so every cabinet B basket was addressed four
     * short — asking 16..31 when the modules answer at 20..35. Trays 16..19 do
     * not exist at all, which is why they returned "gravity board no response",
     * and 20..31 were real modules being asked for the wrong baskets.
     *
     * The gap of four is deliberate on the vendor's side: a cabinet may hold up
     * to 20 baskets, so each cabinet gets a 20-address block whatever it
     * actually contains.
     */
    val trayIndex: Int get() =
        cabinet.ordinal * Planogram.ADDRESS_BLOCK_PER_CABINET + (basket - 1)

    /** A basket we can actually sell from: enabled, has a product, sane weight. */
    val sellable: Boolean
        get() = enabled && productId != null && unitWeightG > 0
}

data class Planogram(
    val spec: FridgeSpec,
    val baskets: List<Basket>,
    /**
     * The language this machine opens in. Set per location from the backend, so
     * a workplace can run Icelandic-first and a hotel English-first from the
     * same build. Falls back to Icelandic when the config doesn't say.
     */
    val defaultLanguage: Language = Language.Icelandic,
    /** Who runs this machine, for the info sheet. Blank falls back to generic copy. */
    val operatorName: String = "",
    /** Where a customer should write. Blank hides the field rather than showing an empty one. */
    val supportEmail: String = "",
    /** Serial port for the Nayax terminal, when the backend overrides the default. */
    val paymentSerialPort: String? = null,
    /** Which languages the pill cycles through. One entry hides the pill. */
    val availableLanguages: List<Language> = listOf(
        Language.Icelandic,
        Language.English,
        Language.Polish,
    ),
) {
    /**
     * Keyed by TRAY, not by basket number. Keying by number alone silently lost
     * half the planogram on a double, because cabinet A basket 1 and cabinet B
     * basket 1 share a number and associateBy keeps only the last.
     */
    private val byTray: Map<Int, Basket> = baskets.associateBy { it.trayIndex }

    fun basketAt(tray: Int): Basket? = byTray[tray]

    fun basketsFor(cabinet: Cabinet): List<Basket> =
        baskets.filter { it.cabinet == cabinet }

    /** True if any sellable basket is missing a usable unit weight — a config
     *  gap the operator must fix before the machine can charge correctly. */
    val hasWeightGaps: Boolean
        get() = baskets.any { it.enabled && it.productId != null && it.unitWeightG <= 0 }

    companion object {
        /** Baskets per cabinet. A double is two of these, not one 32-basket space. */
        const val BASKETS_PER_CABINET = 16

        /**
         * Address stride between cabinets on the RS-485 bus.
         *
         * NOT the same as [BASKETS_PER_CABINET]. The vendor allots each cabinet
         * a block of 20 addresses because a cabinet can hold up to 20 baskets,
         * so cabinet B begins at 20 even when cabinet A holds only 16.
         */
        const val ADDRESS_BLOCK_PER_CABINET = 20

        val EMPTY = Planogram(
            spec = FridgeSpec("GR-UNKNOWN", listOf(Cabinet.A), 16),
            baskets = emptyList(),
        )
    }
}
