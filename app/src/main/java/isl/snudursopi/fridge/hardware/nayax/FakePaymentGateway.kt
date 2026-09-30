package isl.snudursopi.fridge.hardware.nayax

import android.os.Handler
import android.os.Looper
import isl.snudursopi.fridge.ui.state.PaymentGateway

/**
 * Emulator payment stub. Approves after a short delay so the flow can run end
 * to end without a terminal. The real [MarshallFridgePayment] replaces this,
 * reusing the coil app's proven pre-auth (`price_not_final_support`) + capture.
 */
class FakePaymentGateway(
    private val approve: Boolean = true,
    private val captureSucceeds: Boolean = true,
) : PaymentGateway {

    private val main = Handler(Looper.getMainLooper())

    override fun preAuthorize(orderId: String, onResult: (Boolean) -> Unit) {
        main.postDelayed({ onResult(approve) }, 1400)
    }

    override fun capture(orderId: String, amountIsk: Int, onResult: (Boolean) -> Unit) {
        main.postDelayed({ onResult(captureSucceeds) }, 1200)
    }

    override fun cancel(orderId: String) { /* no-op in the fake */ }
}
