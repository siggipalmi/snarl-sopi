package isl.snudursopi.fridge.ui.state

import isl.snudursopi.fridge.data.backend.ComplaintLine
import isl.snudursopi.fridge.domain.ComplaintReason

import isl.snudursopi.fridge.domain.Basket
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.domain.Settlement

/**
 * The screen the kiosk is showing. One-to-one with the mockup Siggi signed off:
 * idle -> authorizing -> unlocked -> shopping -> calculating -> receipt, plus
 * the edge states.
 */
enum class FridgePhase {
    IDLE,           // attract; tap card to open
    AUTHORIZING,    // pre-auth hold being placed on the card
    UNLOCKED,       // door(s) unlocked, "help yourself"
    SHOPPING,       // door open, live tentative cart
    CALCULATING,    // door closed, median-of-3 read + settle
    RECEIPT,        // charged; line items shown
    // ---- edge states ----
    DECLINED,       // card declined; door never opened
    SENSOR_FAULT,   // a load cell failed; refuse to open, no charge
    DOOR_OPEN_WARN, // door left open past the nudge threshold
    PENDING_OFFLINE,// settled locally; charge queued until network returns
    NOTHING_TAKEN,  // door closed with no net change; no charge
    // ---- staff ----
    RESTOCK,        // backend opened a door to refill; no charging, re-baseline on close
    // ---- complaint (UI 8) ----
    COMPLAINT,      // customer filling in the "something was wrong" form
    COMPLAINT_DONE, // complaint accepted; reference number shown
}

/**
 * True while a CUSTOMER is mid-transaction.
 *
 * RESTOCK is deliberately NOT one of these. It looked harmless to treat "not
 * idle" as "busy" until a restock got stuck: every later command then deferred
 * behind it, including the ones that would have recovered the machine. Staff
 * work must never block remote control.
 */
val FridgePhase.isCustomerSession: Boolean
    get() = this != FridgePhase.IDLE && this != FridgePhase.RESTOCK

/**
 * One basket on the restock grid.
 *
 * The screen is a REFERENCE DISPLAY, not a tool — placement is the primary
 * information (what goes where), and the live figure from the scales is
 * secondary confirmation.
 */
data class RestockCell(
    val basket: Int,
    val label: String,
    val name: String,
    val imageUrl: String?,
    val units: Int?,
    val grams: Int?,
    val state: RestockCellState,
)

/** The states an operator must be able to spot at a glance. */
enum class RestockCellState { STOCKED, EMPTY, DISABLED, FAULT }

/** A tentative or final cart line for the tiled UI (image + name + price). */
/** In-progress complaint form. Lives in UI state so a rotation can't lose it. */
data class ComplaintDraft(
    val selectedLines: Set<Int> = emptySet(),
    val reason: ComplaintReason = ComplaintReason.NOT_TAKEN,
    val note: String = "",
    val email: String = "",
    val sending: Boolean = false,
    /** Set when the backend REJECTED the complaint — distinct from queued. */
    val error: Boolean = false,
    /** Shown on the confirmation screen; blank when the complaint was queued. */
    val reference: String = "",
)

data class CartTile(
    val name: String,
    val imageUrl: String?,
    val priceIsk: Int,
    val quantity: Int,
)

data class FridgeUiState(
    val phase: FridgePhase = FridgePhase.IDLE,
    val machineLabel: String = "",
    val operatorName: String = "",
    val supportEmail: String = "",
    /** The ⓘ sheet is open. */
    val showInfo: Boolean = false,
    /** 1 or 2 — the idle animation draws itself from this, no separate art. */
    val cabinetCount: Int = 1,
    val cabinetsOpen: List<String> = emptyList(),
    /** Which cabinet the backend opened for restocking (1 or 2; 0 when none). */
    val restockCabinet: Int = 0,
    /** The open cabinet's 16 baskets, for the restock reference grid. */
    val restockCells: List<RestockCell> = emptyList(),
    /** Tentative cart while shopping, final cart on the receipt. */
    val cart: List<CartTile> = emptyList(),
    val totalIsk: Int = 0,
    /** True once the total is final (post-close), false while it's an estimate. */
    val totalIsFinal: Boolean = false,
    /**
     * The language the CUSTOMER is currently seeing. Chosen at runtime via the
     * globe pill, NOT taken from the tablet's OS locale — these machines are
     * imaged identically and the OS locale tells us nothing useful.
     */
    val language: Language = Language.Icelandic,
    /**
     * Which languages this machine offers. Comes from backend config so a
     * workplace can run Icelandic-first and a hotel English-first with no
     * separate builds. The pill is hidden when there's only one.
     */
    val availableLanguages: List<Language> = listOf(
        Language.Icelandic,
        Language.English,
        Language.Polish,
    ),
    /**
     * The settled order the receipt is showing, and the only thing a complaint
     * can be filed against.
     *
     * *** THESE ARE SEPARATE FROM [cart] ON PURPOSE. A [CartTile] is a display
     * row — name, image, price, quantity — and it is also used for the TENTATIVE
     * cart while the door is still open, where no order exists yet. The
     * complaint body needs cabinet/basket/productId, which a display row has no
     * business carrying. Widening CartTile to cover both would be the same
     * "one type doing two jobs" mistake that produced the partial-write bugs.
     */
    /** Shown on the admin sheet so a quiet machine can be diagnosed on site. */
    val deviceCode: String? = null,
    val lastPollOkMs: Long? = null,
    val orderId: String = "",
    val receiptLines: List<ComplaintLine> = emptyList(),
    /** Draft state for the complaint form, reset whenever the form is opened. */
    val complaint: ComplaintDraft = ComplaintDraft(),
) {
    companion object {
        fun tilesFrom(lines: List<Settlement.Line>): List<CartTile> =
            lines.map {
                CartTile(
                    name = it.basket.name,
                    imageUrl = it.basket.imageUrl,
                    priceIsk = it.basket.priceIsk,
                    quantity = it.quantity,
                )
            }

        /** Build tentative tiles from a live weight diff while the door is open. */
        fun tentativeTiles(
            baskets: List<Basket>,
            /** TRAY -> weight. Tray-keyed because basket numbers repeat per cabinet. */
            orig: Map<Int, Int>,
            live: Map<Int, Int>,
        ): List<CartTile> {
            val tiles = mutableListOf<CartTile>()
            for (b in baskets) {
                if (!b.sellable) continue
                val o = orig[b.trayIndex] ?: continue
                val l = live[b.trayIndex] ?: continue
                val delta = o - l
                val tol = if (b.toleranceG > 0) b.toleranceG else Settlement.DEFAULT_TOLERANCE_G
                if (delta <= tol) continue
                val qty = Math.round(delta.toDouble() / b.unitWeightG).toInt()
                if (qty <= 0) continue
                tiles += CartTile(b.name, b.imageUrl, b.priceIsk, qty)
            }
            return tiles
        }
    }
}
