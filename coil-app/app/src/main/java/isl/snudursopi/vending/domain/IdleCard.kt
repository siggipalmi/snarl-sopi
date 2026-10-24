package isl.snudursopi.vending.domain

/**
 * Idle/attract-screen deal cards, fed ready-to-render by the backend in the
 * machine config (`idle` object). The kiosk does NO filtering or discount math
 * — the backend already resolved everything per machine (stock, schedule,
 * expiry tiers, scope). The kiosk just renders [IdleConfig.cards] in order and
 * cycles them. See the backend render-spec memo (backend v5.17).
 */
enum class IdleCardType { Markdown, Expiry, Multibuy, Combo, Unknown }

/**
 * One product on a card. Most fields are optional because they only apply to
 * certain card types (e.g. [percent]/[daysLeft] are expiry-only, [imgUrl] may
 * be null → render a neutral tile).
 */
data class IdleItem(
    val goodsId: String? = null,
    val name: String = "",
    val imgUrl: String? = null,
    val priceIsk: Int? = null,
    val discountedPriceIsk: Int? = null,
    val percent: Int? = null,
    val daysLeft: Int? = null,
)

/**
 * The discount descriptor. [kind] selects which of the optional fields are
 * meaningful:
 *  - "percent" → [value] = N (badge "−N%")
 *  - "fixed"   → [value] = kr off (badge "−kr. N")
 *  - "price"   → [value] = set price (badge "kr. N")
 *  - "expiry"  → [maxPercent] = headline "allt að −N%"
 *  - "multibuy"→ [qty] + [totalKr] ("{qty} fyrir kr. {totalKr}")
 *  - "combo"   → [mode] ("price"|"percent") + [value]
 */
data class IdleDiscount(
    val kind: String = "",
    val value: Int? = null,
    val maxPercent: Int? = null,
    val qty: Int? = null,
    val totalKr: Int? = null,
    val mode: String? = null,
)

/**
 * A single attract card. [items] holds up to 4 items to show; [itemCount] is
 * the TRUE total (may exceed items shown → "+N more"). [groups] is populated
 * for combo cards (one thumbnail group per element); [items] still carries one
 * representative per group for simple renderers.
 */
data class IdleCard(
    val dealId: String,
    val dealName: String,
    val type: IdleCardType,
    val discount: IdleDiscount,
    val itemCount: Int,
    val items: List<IdleItem>,
    val groups: List<List<IdleItem>> = emptyList(),
)

/**
 * The `idle` block from config. Empty [cards] → show the normal attract screen,
 * no deal loop. [rotationSeconds] (card cycle speed) and [attractTimeoutSeconds]
 * (inactivity before dropping into the attract loop) are operator-tunable from
 * the backend — read them, don't hard-code.
 */
data class IdleConfig(
    val rotationSeconds: Int = 6,
    val attractTimeoutSeconds: Int = 30,
    val cards: List<IdleCard> = emptyList(),
) {
    companion object {
        val EMPTY = IdleConfig()
    }
}
