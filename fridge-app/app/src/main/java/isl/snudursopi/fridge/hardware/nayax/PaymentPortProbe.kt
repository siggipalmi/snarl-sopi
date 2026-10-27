package isl.snudursopi.fridge.hardware.nayax

/**
 * Which serial port the Nayax link should try next. Pure — no Android, no I/O —
 * so the decision can be tested without a board.
 *
 * *** THE PORT VARIES PER MACHINE, NOT PER TYPE.
 *
 *   8626020716  double  /dev/ttyS1
 *   8626020714  double  /dev/ttyS4
 *   singles so far      /dev/ttyS4
 *
 * v0.54.0 picked the port from the cabinet count. That was wrong, and it broke a
 * working link on 2026-09-29. So the machine finds out for itself: try a
 * candidate, and if onReady has not arrived within the controller's 90s
 * watchdog, move to the next one.
 *
 * A wrong port gives no error at all — it opens, link.start() succeeds, and
 * onReady never comes. Silence is the only signal, which is why the watchdog
 * timeout is what drives the rotation.
 *
 * Precedence:
 *   1. [explicit]  — config paymentSerialPort or set_payment_port. Never probed
 *                    away from: an operator said so.
 *   2. [confirmed] — a port that has produced onReady on this machine. Sticky:
 *                    a terminal that is rebooting or unplugged must not send us
 *                    wandering onto another port for hours.
 *   3. otherwise rotate through [CANDIDATES].
 */
class PaymentPortProbe(
    var explicit: String? = null,
    var confirmed: String? = null,
    /**
     * The weight bus, never probed or confirmed. ttyS3 on every machine except
     * 8625060404, where the scales are on ttyS1 and Nayax on ttyS3.
     */
    var weightPort: String = "/dev/ttyS3",
) {
    /** Candidates in order, without the weight bus; ttyS3 joins when it is free. */
    fun candidates(): List<String> =
        (CANDIDATES + "/dev/ttyS3").distinct().filter { it != weightPort }

    companion object {
        /**
         * ttyS4 first: every single seen so far, and one of the two doubles.
         * ttyS3 is never a candidate — it is the gravity weight bus, and a
         * second reader on it corrupts weights and payment at once.
         */
        val CANDIDATES = listOf("/dev/ttyS4", "/dev/ttyS1")

        private val VALID = Regex("^/dev/ttyS[0-9]$")

        fun isValid(path: String?): Boolean =
            path != null && VALID.matches(path) && path != "/dev/ttyS3"
    }

    /** True while the machine is still searching rather than told or sure. */
    val probing: Boolean
        get() = explicit == null && confirmed == null

    /** The port to open first. */
    fun initial(): String = explicit ?: confirmed ?: candidates().first()

    /** The port to try after [failed] produced no onReady within the watchdog. */
    fun nextAfterTimeout(failed: String): String {
        explicit?.let { return it }
        confirmed?.let { return it }
        val c = candidates()
        val i = c.indexOf(failed)
        return c[(i + 1) % c.size]
    }

    /** onReady arrived on [port]. Returns true if that is new and worth saving. */
    fun confirm(port: String): Boolean {
        if (!VALID.matches(port) || port == weightPort || port == confirmed) return false
        confirmed = port
        return true
    }
}
