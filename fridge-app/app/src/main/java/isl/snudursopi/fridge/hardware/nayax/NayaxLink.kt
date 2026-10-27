package isl.snudursopi.fridge.hardware.nayax

import android.content.Context
import android.content.SharedPreferences
import android.util.Log

/**
 * The ONE Nayax link for the whole app.
 *
 * Two MarshallPaymentControllers on the same port fight over it: both run
 * their own link thread, both register SDK callbacks, and every event fires
 * twice (visible in logcat as exactly duplicated lines). The reader ends up
 * talking to whichever won the race, and disconnecting one kills the other.
 *
 * Same failure mode as opening two MotorSerialPortKits on ttyS3. So the flow
 * and the payment test screen both go through this.
 */
object NayaxLink {

    private const val TAG = "MarshallPay"
    private const val PREFS = "nayax_link"
    private const val KEY_CONFIRMED = "confirmed_port"

    /**
     * *** THE PORT IS FOUND, NOT GUESSED. See [PaymentPortProbe].
     *
     * It varies per machine — two doubles are on different ports — so no rule
     * by cabinet count or machine type holds. v0.54.0 had one, and it broke a
     * working link on 2026-09-29.
     *
     * The port that first produces onReady is saved, so a machine searches
     * once and then starts on the right port at every boot after. Config
     * (paymentSerialPort) and set_payment_port still override everything.
     */
    private val probe = PaymentPortProbe()

    private var prefs: SharedPreferences? = null

    /** When the link last completed a handshake, for the payment-status report. */
    @Volatile
    var lastReadyAtMs: Long? = null
        private set

    /** The terminal's decimal_place from its last handshake (must be 0 for ISK). */
    val decimalPlace: Int? get() = controller.decimalPlace

    /** The reader's serial number, Monyx ID, firmware… from its last handshake. */
    val readerInfo: Map<String, String>? get() = controller.readerInfo

    /** True while the reader can take a card. */
    fun isUp(): Boolean = when (controller.state) {
        MarshallPaymentController.State.READY,
        MarshallPaymentController.State.AWAITING_CARD,
        MarshallPaymentController.State.VENDING -> true
        else -> false
    }

    @Volatile
    var portPath: String = probe.initial()
        private set

    /** Load the port this machine confirmed before. Call before connecting. */
    fun init(context: Context) {
        val p = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = p
        // The weight bus port MotorFridgeHardware remembered from config, so a
        // boot that probes before config arrives still keeps off the scales.
        context.applicationContext.getSharedPreferences("weight_bus", Context.MODE_PRIVATE)
            .getString("port", null)?.let { probe.weightPort = it }
        probe.confirmed = p.getString(KEY_CONFIRMED, null)
            ?.takeIf { Regex("^/dev/ttyS[0-9]$").matches(it) && it != probe.weightPort }
        Log.i(
            TAG,
            "payment port: " + (probe.confirmed?.let { "$it (confirmed earlier)" }
                ?: "none confirmed yet — probing ${probe.candidates()}"),
        )
        setPortPath(probe.initial())
    }

    /** The port the scales are on, so probing never opens it. */
    fun setWeightPort(path: String) {
        if (probe.weightPort == path) return
        probe.weightPort = path
        Log.i(TAG, "payment probe skips the weight bus on $path — candidates ${probe.candidates()}")
    }

    /** Set deliberately, so probing stops. Returns true if a reconnect is needed. */
    fun setPortPathExplicit(path: String): Boolean {
        probe.explicit = path
        return setPortPath(path)
    }

    /**
     * Forget both the explicit and the confirmed port and search again. For a
     * board moved to another machine, or a confirmation that must be redone.
     */
    fun useAutomatic(): Boolean {
        probe.explicit = null
        probe.confirmed = null
        prefs?.edit()?.remove(KEY_CONFIRMED)?.apply()
        Log.w(TAG, "payment port: automatic — probing ${probe.candidates()}")
        return setPortPath(probe.initial())
    }

    /** For the admin sheet: the port, and whether it was set, found or is being searched. */
    fun describe(): String {
        val how = when {
            probe.explicit != null -> "stillt"
            probe.confirmed != null -> "fundið"
            else -> "leitar"
        }
        return "${portPath.removePrefix("/dev/")} · $how"
    }

    /** Returns true if the port changed and a reconnect is needed. */
    private fun setPortPath(path: String): Boolean {
        if (path == portPath) return false
        portPath = path
        controller.setPortPath(path)
        return true
    }

    val controller: MarshallPaymentController by lazy {
        MarshallPaymentController(
            portPath = portPath,
            baud = 115200,
            // *** NO LOGGER HERE. MarshallPaymentController.emit already calls
            // Log.i(TAG, …) with the same "MarshallPay" tag, so passing one
            // printed every line TWICE under the same tag. That looked exactly
            // like the two-controllers-on-one-port failure this object exists to
            // prevent, and cost real time on 2026-09-04 chasing a duplicate
            // controller that was never there.
            log = {},
        ).also { c ->
            c.onReadyTimeout = { failed ->
                val next = probe.nextAfterTimeout(failed)
                if (next != failed) {
                    Log.w(TAG, "probe: no onReady on $failed — trying $next")
                    portPath = next
                    c.setPortPath(next)
                }
            }
            c.onLinkUp = { port ->
                lastReadyAtMs = System.currentTimeMillis()
                if (probe.confirm(port)) {
                    prefs?.edit()?.putString(KEY_CONFIRMED, port)?.apply()
                    Log.w(TAG, "payment port confirmed: $port — saved, used at every start")
                }
            }
        }
    }

    val payment: MarshallFridgePayment by lazy { MarshallFridgePayment(controller) }
}
