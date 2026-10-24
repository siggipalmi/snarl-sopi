package isl.snudursopi.vending.domain

/**
 * The deal-aware price of a cart, returned by the backend quote endpoint
 * (`POST /api/v1/machines/{deviceCode}/quote`). The kiosk does NO discount math
 * — it sends the cart, charges [totalIsk], and shows the breakdown. Backend
 * v5.21 contract.
 */
data class CartQuote(
    val lines: List<QuoteLine>,
    val subtotalIsk: Int,
    val discountIsk: Int,
    /** What the kiosk charges the Nayax. */
    val totalIsk: Int,
    val appliedDeals: List<AppliedDeal>,
    /**
     * Deals the basket is exactly one item short of completing (from the backend
     * `comboNearMiss` block, v5.60). Drives the checkout nudge. Empty when there's
     * nothing to suggest. Re-read from every quote — [ComboNearMiss.addOnPriceIsk]
     * is specific to the current basket and must not be cached across baskets.
     */
    val nearMiss: List<ComboNearMiss> = emptyList(),
)

/**
 * A deal the basket is one item short of. The backend only emits these when
 * completing the deal is a genuine saving, so every hint is safe to show.
 */
data class ComboNearMiss(
    val comboId: String,
    /** Display name for the card eyebrow, e.g. "snarl combo". */
    val label: String,
    /** Missing group's label, e.g. "drykkur" (null for multibuy). */
    val missingGroupLabel: String?,
    /** What adding one item costs — combo total minus what's already in the basket.
     *  Rendered verbatim: "bættu við einni vöru fyrir {addOnPriceIsk} kr". */
    val addOnPriceIsk: Int,
    /** "combo" (default) or "multibuy". */
    val kind: String,
    /** In-stock members of the missing group, cheapest-first. The kiosk resolves
     *  name/price/image from the catalog itself. */
    val candidateGoodsIds: List<String>,
)

/**
 * One priced line. Cart-level discounts (multibuy/combo) are distributed across
 * the qualifying lines, integer ISK, so [lineTotalIsk] across all lines sums
 * exactly to [CartQuote.totalIsk].
 */
data class QuoteLine(
    val goodsId: String,
    val name: String,
    val qty: Int,
    val unitPriceIsk: Int,
    val lineBaseIsk: Int,
    val lineDiscountIsk: Int,
    val lineTotalIsk: Int,
    val appliedDealId: String? = null,
    val appliedDealName: String? = null,
)

data class AppliedDeal(
    val dealId: String,
    val dealName: String,
    val type: String,
    val amountIsk: Int,
)
