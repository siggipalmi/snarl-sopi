package isl.snudursopi.fridge.ui.state

/**
 * What to do about a customer screen that has not changed for a long time.
 *
 * Blue Hotel (8626020716, 2026-11-02) sat on a customer phase from before 01:33 until at least
 * 05:33, with nobody at the machine. Every remote command deferred behind it ("a customer session
 * is live"), restart_app included, so the dashboard could not recover the machine it was showing
 * as online. Nothing bounded the phase: COMPLAINT has no timer by design, and a charge result
 * arriving after the receipt timer had already fired put RECEIPT back on screen with no timer.
 *
 * No real session holds one screen this long: shopping ends at 610 s, and every other customer
 * screen times out in seconds to a minute. So past [STUCK_MS]:
 *  - remote commands run again — a stuck screen must never lock out the command that clears it;
 *  - a screen AFTER the payment (receipt, complaint, declined…) returns to idle by itself;
 *  - a screen DURING one (authorising, door open, settling) is only logged: what the reader holds
 *    then is not ours to guess at, and restart_app now gets through for someone to decide.
 */
object StuckSession {
    const val STUCK_MS = 15L * 60L * 1000L

    /** Phases where a charge may still be in flight or the door may be open. */
    private val IN_PAYMENT = setOf(
        FridgePhase.AUTHORIZING,
        FridgePhase.UNLOCKED,
        FridgePhase.SHOPPING,
        FridgePhase.DOOR_OPEN_WARN,
        FridgePhase.CALCULATING,
    )

    fun isStuck(phase: FridgePhase, inPhaseMs: Long): Boolean =
        phase.isCustomerSession && inPhaseMs >= STUCK_MS

    /** The gate for remote commands: a live customer, unless the screen is stuck. */
    fun blocksCommands(phase: FridgePhase, inPhaseMs: Long): Boolean =
        phase.isCustomerSession && !isStuck(phase, inPhaseMs)

    /** True when the screen may be put back to idle without touching a payment. */
    fun mayReturnToIdle(phase: FridgePhase, inPhaseMs: Long): Boolean =
        isStuck(phase, inPhaseMs) && phase !in IN_PAYMENT
}
