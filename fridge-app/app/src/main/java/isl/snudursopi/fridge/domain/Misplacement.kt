package isl.snudursopi.fridge.domain

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * An item put back in the WRONG basket (Siggi, 2026-11-06; mockup on the design canvas).
 *
 * Settlement weighs every basket on its own, so moving an item from A to B charges for it
 * (A got lighter — correct, they took it) and ignores B (heavier is never a credit). What it
 * leaves behind is a basket carrying the wrong weight: the next customer to lift that item out
 * of B is charged for B's product. This finds those moves so the kiosk can ask for the item to
 * go back while the door is still open, and the dashboard can say which basket to fix if not.
 *
 * The rule: a basket that got HEAVIER by more than its noise floor is matched against what left
 * the other baskets — one or more units of a counted product, or the grams of a per-kg one. A
 * match is a misplaced item with a known source. A gain that matches nothing (a foreign object,
 * or a scale drift) is reported with no source: never shown to the customer, only flagged.
 *
 * Detection never changes the charge. That stays [Settlement.settle]'s, unchanged.
 */
object Misplacement {

    /** Within this many grams of a candidate, or [MATCH_FRACTION] of it if larger. */
    const val MATCH_MIN_G = 15
    const val MATCH_FRACTION = 0.08

    data class Found(
        /** The basket that got heavier. */
        val into: Basket,
        val gainG: Int,
        /** The basket the item most likely came from; null when nothing taken matches. */
        val from: Basket?,
        /** Units of [from]'s product the gain matches (1 for a per-kg cut). */
        val quantity: Int,
    )

    fun detect(
        planogram: Planogram,
        orig: Map<Int, Int>,
        now: Map<Int, Int>,
    ): List<Found> {
        // What left each basket: (source, candidate weight, units). A counted source offers one
        // candidate per unit taken, so "took two, put one back in the wrong place" still matches.
        data class Candidate(val from: Basket, val grams: Int, val units: Int)
        val taken = mutableListOf<Candidate>()
        val unitsLeft = HashMap<Int, Int>()   // tray -> units still available to explain a gain
        for (b in planogram.baskets) {
            if (!b.enabled || b.productId == null) continue
            val o = orig[b.trayIndex] ?: continue
            val n = now[b.trayIndex] ?: continue
            val delta = o - n
            if (b.soldByWeight) {
                if (delta >= Settlement.BY_WEIGHT_MIN_G) {
                    taken += Candidate(b, delta, 1)
                    unitsLeft[b.trayIndex] = 1
                }
                continue
            }
            if (b.unitWeightG <= 0) continue
            if (delta <= tolerance(b)) continue
            val qty = (delta.toDouble() / b.unitWeightG).roundToInt()
            if (qty <= 0) continue
            for (k in 1..qty) taken += Candidate(b, k * b.unitWeightG, k)
            unitsLeft[b.trayIndex] = qty
        }

        val found = mutableListOf<Found>()
        // Every physical basket counts as a destination, assigned or not: an item dropped into an
        // empty basket is just as misplaced. Largest gains first, so a big clear move claims its
        // source before a marginal one can.
        val gainers = planogram.baskets.mapNotNull { b ->
            val o = orig[b.trayIndex] ?: return@mapNotNull null
            val n = now[b.trayIndex] ?: return@mapNotNull null
            val gain = n - o
            if (gain > tolerance(b)) b to gain else null
        }.sortedByDescending { it.second }

        for ((into, gain) in gainers) {
            val match = taken
                .filter { it.from.trayIndex != into.trayIndex }
                .filter { (unitsLeft[it.from.trayIndex] ?: 0) >= it.units }
                .filter { abs(gain - it.grams) <= max(MATCH_MIN_G, (it.grams * MATCH_FRACTION).toInt()) }
                .minByOrNull { abs(gain - it.grams) }
            if (match != null) {
                unitsLeft[match.from.trayIndex] = (unitsLeft[match.from.trayIndex] ?: 0) - match.units
                found += Found(into, gain, match.from, match.units)
            } else {
                found += Found(into, gain, null, 0)
            }
        }
        return found
    }

    private fun tolerance(b: Basket): Int =
        if (b.toleranceG > 0) b.toleranceG else Settlement.DEFAULT_TOLERANCE_G
}
