package isl.snudursopi.fridge.domain

/**
 * Has the stock in the baskets moved away from what the dashboard was last told?
 *
 * Stock was reported at app start, after a sale that took something and after a recorded
 * restock. Anything else that changed a basket left the dashboard showing the old count:
 * 8626020618 showed A14 at 0 for hours while its scale read 479 g of 50 g bars (2026-11-17).
 * The idle loop reads every scale every few seconds anyway, so it compares that read with
 * the last report and sends a new one when they disagree.
 */
object StockDrift {
    /** A per-kg basket counts as changed when its weight moves by this much. */
    const val BY_WEIGHT_STEP_G = 50

    /** Two idle reads in a row must agree before a change is believed (a hand in a basket). */
    const val STABLE_READS = 2

    /** At most one drift report in this long: a basket sitting on a rounding edge flips for ever. */
    const val MIN_INTERVAL_MS = 5 * 60_000L

    /** Items in a basket holding [grams]; null for a per-kg basket or one with no unit weight. */
    fun units(b: Basket, grams: Int): Int? = when {
        b.soldByWeight -> null
        b.unitWeightG > 0 -> ((grams.coerceAtLeast(0).toDouble() / b.unitWeightG) + 0.5).toInt()
        else -> null
    }

    /**
     * What the dashboard shows per tray for [weights]: the item count, or for a per-kg basket
     * its weight in steps of [BY_WEIGHT_STEP_G]. Only assigned baskets that have a reading.
     */
    fun shown(baskets: List<Basket>, weights: Map<Int, Int>): Map<Int, Int> =
        baskets.filter { it.productId != null }.mapNotNull { b ->
            val grams = weights[b.trayIndex] ?: return@mapNotNull null
            val v = units(b, grams)
                ?: if (b.soldByWeight) grams.coerceAtLeast(0) / BY_WEIGHT_STEP_G else return@mapNotNull null
            b.trayIndex to v
        }.toMap()

    /** True when any tray in [now] differs from, or is missing in, [reported]. */
    fun differs(reported: Map<Int, Int>, now: Map<Int, Int>): Boolean =
        now.any { (tray, v) -> reported[tray] != v }
}
