package isl.snudursopi.fridge.ui.state

import isl.snudursopi.fridge.domain.Planogram
import isl.snudursopi.fridge.domain.Settlement

/**
 * Everything the backend needs to record one completed session.
 *
 * Emitted by [FridgeViewModel] once per session — including sessions where
 * nothing was taken, because "customer opened the door and took nothing" is
 * real operational signal, not a non-event.
 */
data class FridgeSettlementEvent(
    val orderId: String,
    val startedAtMs: Long,
    val closedAtMs: Long,
    val planogram: Planogram,
    val cabinetsOpened: List<String>,
    /** charged | nothing_taken | pending_offline (contract v5.67 vocabulary). */
    val outcome: String,
    val nayaxRef: String?,
    val result: Settlement.Result,
)
