package isl.snudursopi.fridge.hardware.nayax

/**
 * The ONE Nayax link for the whole app.
 *
 * Two MarshallPaymentControllers on /dev/ttyS4 fight over the port: both run
 * their own link thread, both register SDK callbacks, and every event fires
 * twice (visible in logcat as exactly duplicated lines). The reader ends up
 * talking to whichever won the race, and disconnecting one kills the other.
 *
 * Same failure mode as opening two MotorSerialPortKits on ttyS3. So the flow
 * and the payment test screen both go through this.
 */
object NayaxLink {

    /**
     * *** WHICH PORT THE NAYAX IS ON HAS NEVER BEEN VERIFIED ON THIS HARDWARE.
     *
     * ttyS4 was inherited from earlier work and has never once produced a
     * received byte on machine 8626020716. Weimi's own app handshakes with the
     * same terminal on the same board — confirmed on site 2026-09-06 — so the
     * hardware is fine and our side is not. The port is the leading suspect:
     * the coil machines put Nayax on ttyS3, and the gravity boards use ttyS3
     * for the weight bus, so the assignment clearly differs by machine type.
     *
     * *** THE PORT DIFFERS BY MACHINE TYPE. BOTH VALUES ARE CONFIRMED.
     *
     *   SINGLE cabinet -> /dev/ttyS4   (8626020623, handshake 2026-09-15)
     *   DOUBLE cabinet -> /dev/ttyS1   (8626020716, handshake 2026-09-06)
     *
     * Do not collapse these to one value. The double was diagnosed first and the
     * default was changed to ttyS1 for everything on the strength of it — which
     * would have broken payment on every single-cabinet machine in the fleet had
     * 8626020623 not been set up the same week and caught it.
     *
     * Nor can either be inferred from the coil machines: those use ttyS3 for
     * Nayax and ttyS1 for motors, while the gravity boards use ttyS3 for the
     * weight bus. Three machine types, three assignments, no pattern. Confirm on
     * hardware, never by analogy.
     *
     * [DEFAULT_SINGLE] is the starting value because a machine has no planogram
     * until its first config poll and payment should not wait for the backend.
     * [applyForCabinets] corrects it when the spec arrives; config
     * (paymentSerialPort) and set_payment_port override both.
     */
    const val DEFAULT_SINGLE = "/dev/ttyS4"
    const val DEFAULT_DOUBLE = "/dev/ttyS1"

    @Volatile
    var portPath: String = DEFAULT_SINGLE
        private set

    @Volatile
    private var overridden = false

    /**
     * Pick the default for this machine's cabinet count.
     *
     * Skipped once anything has set the port deliberately — otherwise a machine
     * corrected by config or command would be undone on the next planogram poll.
     */
    fun applyForCabinets(cabinets: Int): Boolean {
        if (overridden) return false
        return setPortPath(if (cabinets >= 2) DEFAULT_DOUBLE else DEFAULT_SINGLE)
    }

    /** Set deliberately, so cabinet-count defaults stop applying. */
    fun setPortPathExplicit(path: String): Boolean {
        overridden = true
        return setPortPath(path)
    }

    /** Returns true if the port changed and a reconnect is needed. */
    fun setPortPath(path: String): Boolean {
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
        )
    }

    val payment: MarshallFridgePayment by lazy { MarshallFridgePayment(controller) }
}
