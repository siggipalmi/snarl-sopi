package isl.snudursopi.fridge.domain

/**
 * How a basket larger than the card allows is paid (Siggi, 2026-11-09).
 *
 * Nayax gives one authorisation per tap — the "funds available" the reader reports when the card
 * opens its session (8,000 kr on 715). Until 0.70.13 the app sent the whole basket in one charge;
 * above that limit it was refused, the order showed "Cancelled by machine" at 0 kr in Nayax Core
 * (715, 5 Nov 2026), and the customer left with everything unpaid while the screen said it would
 * be charged later.
 *
 * Now: never ask for more than the card allows. Charge up to the limit, then ask for another tap
 * for the rest, and repeat. Whatever is still owed when the customer walks away is reported to the
 * backend as unpaid. A refused charge is the same case with nothing paid.
 */
object PartialPayment {
    /** The reader takes the amount as a signed 16-bit number; anything larger wraps. */
    const val MAX_SINGLE_CHARGE_ISK = 32_767

    /** The next amount to send: what is owed, capped by the card's limit (when known) and a Short. */
    fun nextCharge(owedIsk: Int, cardLimitIsk: Int?): Int {
        val limit = cardLimitIsk?.takeIf { it > 0 } ?: Int.MAX_VALUE
        return minOf(owedIsk, MAX_SINGLE_CHARGE_ISK, limit).coerceAtLeast(0)
    }

    /** The settlement outcome for what was collected of [totalIsk]. */
    fun outcome(totalIsk: Int, paidIsk: Int): String = when {
        paidIsk >= totalIsk -> "charged"
        paidIsk > 0 -> "partially_paid"
        else -> "unpaid"
    }
}
