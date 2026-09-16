package isl.snudursopi.fridge.hardware.nayax

import isl.snudursopi.fridge.ui.state.PaymentGateway

/**
 * Real Nayax payment for the fridge, on /dev/ttyS4.
 *
 * ORDER OF OPERATIONS — this is the bit that differs from a normal vending
 * machine, and the bit that was wrong in v0.7.x:
 *
 *   1. customer taps -> the READER opens a session and reports available funds
 *   2. that alone is our authorisation: unlock the door        [preAuthorize]
 *   3. customer shops; door closes; settlement computes a total
 *   4. NOW send the vend_request for the real total            [capture]
 *   5. nothing taken -> session_cancel, no charge              [cancel]
 *
 * We deliberately do NOT send a vend_request up front for a ceiling. In MDB,
 * approving a vend IS the settlement — a vend_request for 3500 charges 3500
 * immediately, which is exactly what happened when this was built the other
 * way round. Holding an approved vend open is not something the protocol
 * offers.
 *
 * The reader's own session (step 1) is what keeps the card "present" while the
 * customer shops, and [minFundsIsk] stops us opening the door for a card with
 * no money on it.
 */
class MarshallFridgePayment(
    private val controller: MarshallPaymentController,
    private val minFundsIsk: Int = 1,
) : PaymentGateway {

    /** Fired when a customer taps — the app should start a session. */
    var onCardPresented: (() -> Unit)? = null

    /** True once the link handshake has completed and vends are accepted. */
    @Volatile private var readerReady = false

    /** Funds the reader reported for the card currently presented. */
    @Volatile private var fundsAvail = 0

    fun connect(onReady: () -> Unit = {}) {
        controller.onReaderStateChanged = { ready -> readerReady = ready }
        controller.onCardDetected = { funds ->
            fundsAvail = funds
            onCardPresented?.invoke()
        }
        controller.connect {
            readerReady = true
            onReady()
        }
    }

    /**
     * Not a real pre-authorisation — the reader has already validated the card
     * and told us its balance. We only decide whether to open the door.
     */
    override fun lastReference(): String? = controller.lastTransactionId

    override fun preAuthorize(orderId: String, onResult: (approved: Boolean) -> Unit) {
        if (!readerReady) {
            // Card arrived before the link finished handshaking. Release the
            // reader rather than leave it waiting on a request we can't send.
            controller.cancel()
            onResult(false)
            return
        }
        if (fundsAvail < minFundsIsk) {
            controller.cancel()
            onResult(false)
            return
        }
        onResult(true)
    }

    /**
     * The actual charge. Sends vend_request for the settled total against the
     * session the card tap opened; approval settles it at exactly this amount.
     */
    override fun capture(orderId: String, amountIsk: Int, onResult: (captured: Boolean) -> Unit) {
        if (amountIsk <= 0) {
            // Took nothing — release the session instead of charging zero.
            controller.cancel()
            onResult(true)
            return
        }
        controller.charge(amountIsk) { result ->
            onResult(result is MarshallPaymentController.Result.Approved)
        }
    }

    override fun cancel(orderId: String) {
        controller.cancel()
    }

    fun disconnect() = controller.disconnect()
}
