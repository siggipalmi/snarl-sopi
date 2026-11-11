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
    /** charged | partially_paid | unpaid | nothing_taken | declined | sensor_fault. */
    val outcome: String,
    val nayaxRef: String?,
    val result: Settlement.Result,
    /** Collected so far, when a charge was attempted ([isl.snudursopi.fridge.domain.PartialPayment]). */
    val paidIsk: Int? = null,
    /** False while the customer is still being asked to tap for a remaining balance. */
    val final: Boolean = true,
    /** Nayax's reference for every approved charge of this order, in order. */
    val paymentRefs: List<String> = emptyList(),
    /** One line per charge attempt: what the reader allowed, what was sent, what came back. */
    val paymentTrail: List<String> = emptyList(),
)
