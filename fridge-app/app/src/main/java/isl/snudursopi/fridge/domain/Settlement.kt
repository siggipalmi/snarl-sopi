package isl.snudursopi.fridge.domain

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The gravity settlement algorithm, reimplemented cleanly from the vendor's
 * `SubUnlockGRState` logic (decision D2 — our own readable version, not their
 * obfuscated classes).
 *
 * The shape of a sale:
 *   1. Before unlocking, snapshot each basket's resting weight  -> [origWeights].
 *   2. While the door is open, poll continuously (for the live cart estimate).
 *   3. After the door closes, read each basket THREE times and take the
 *      MEDIAN, to reject load-cell jitter -> [medianOf3].
 *   4. Per basket: delta = orig - final. Convert to a quantity using the
 *      planogram unit weight, with two guards:
 *        - noise floor: |delta| below the per-basket tolerance (default 15 g)
 *          is treated as zero (condensation, vibration, a hand resting).
 *        - misread guard: a *negative* delta (basket got heavier) larger than
 *          60% of the original weight is discarded as a bad read.
 *   5. Only positive whole quantities are charged.
 *
 * All weights are integer grams. Money is integer króna.
 */
object Settlement {

    /** Default noise floor in grams — the vendor's `b3.a.m`. Per-basket
     *  tolerance overrides this when the planogram provides one. */
    const val DEFAULT_TOLERANCE_G = 15

    /** A read that isn't within tolerance of a whole multiple of the unit
     *  weight is "ambiguous" — we still charge the rounded quantity but flag
     *  it so field data can tell us whether the tolerance needs tuning. */
    data class Line(
        val basket: Basket,
        val startWeightG: Int,
        val endWeightG: Int,
        val deltaG: Int,          // startWeightG - endWeightG (positive = items removed)
        val quantity: Int,
        val lineIsk: Int,
        val ambiguous: Boolean,
    )

    data class Anomaly(
        val basketNumber: Int,
        val cabinet: Cabinet,
        val deltaG: Int,
        val reason: String,       // "below_tolerance" | "misread_guard" | "no_unit_weight"
    )

    data class Result(
        val lines: List<Line>,    // only baskets that produced a charge
        val anomalies: List<Anomaly>,
        val totalIsk: Int,
    ) {
        val nothingTaken: Boolean get() = lines.isEmpty()
    }

    /**
     * Median of up to three readings (matches the vendor: sort, take the
     * middle; with fewer than three, take the lowest as the conservative
     * value). Public so the weight service and tests can share it.
     */
    fun medianOf3(readings: List<Int>): Int {
        if (readings.isEmpty()) return 0
        val s = readings.sorted()
        return if (s.size < 3) s.first() else s[1]
    }

    /**
     * Compute the charge from the before/after snapshots.
     *
     * @param planogram the machine planogram (unit weights + prices).
     * @param origWeights TRAY -> resting weight before unlock.
     * @param finalWeights TRAY -> median-of-3 weight after close.
     *   Keyed by tray, not basket number: basket numbers repeat across cabinets
     *   on a double, so they can't identify a basket on their own.
     */
    fun settle(
        planogram: Planogram,
        origWeights: Map<Int, Int>,
        finalWeights: Map<Int, Int>,
    ): Result {
        val lines = mutableListOf<Line>()
        val anomalies = mutableListOf<Anomaly>()
        var total = 0

        for (basket in planogram.baskets) {
            if (!basket.enabled || basket.productId == null) continue

            val orig = origWeights[basket.trayIndex] ?: continue
            val final = finalWeights[basket.trayIndex] ?: continue
            val delta = orig - final   // positive = lighter now = items removed

            // No usable unit weight -> can't convert; flag, never charge.
            if (basket.unitWeightG <= 0) {
                if (delta != 0) {
                    anomalies += Anomaly(basket.basket, basket.cabinet, delta, "no_unit_weight")
                }
                continue
            }

            // Misread guard: basket got HEAVIER by > 60% of its original weight
            // -> physically implausible for a purchase, treat as a bad read.
            if (delta < 0 && abs(delta) > (orig * 0.6).toInt() && orig >= 10) {
                anomalies += Anomaly(basket.basket, basket.cabinet, delta, "misread_guard")
                continue
            }

            val tol = if (basket.toleranceG > 0) basket.toleranceG else DEFAULT_TOLERANCE_G

            // Noise floor: within tolerance of zero -> nothing taken here.
            if (abs(delta) <= tol) {
                if (delta != 0) {
                    anomalies += Anomaly(basket.basket, basket.cabinet, delta, "below_tolerance")
                }
                continue
            }

            // Convert to quantity. A clean read sits within tolerance of a whole
            // multiple of the unit weight; otherwise it's ambiguous but we still
            // charge the nearest whole count (never fractional, never negative).
            val exact = delta.toDouble() / basket.unitWeightG
            val qty = exact.roundToInt()
            if (qty <= 0) {
                anomalies += Anomaly(basket.basket, basket.cabinet, delta, "below_tolerance")
                continue
            }
            val residual = abs(delta - qty * basket.unitWeightG)
            val ambiguous = residual > tol

            val lineIsk = qty * basket.priceIsk
            total += lineIsk
            lines += Line(
                basket = basket,
                startWeightG = orig,
                endWeightG = final,
                deltaG = delta,
                quantity = qty,
                lineIsk = lineIsk,
                ambiguous = ambiguous,
            )
        }

        return Result(lines = lines, anomalies = anomalies, totalIsk = total)
    }
}
