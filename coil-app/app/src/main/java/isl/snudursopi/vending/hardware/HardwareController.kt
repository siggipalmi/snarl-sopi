package isl.snudursopi.vending.hardware

import kotlinx.coroutines.flow.StateFlow

/**
 * Abstraction over the physical vending hardware.
 *
 * Two concerns, deliberately separated because on this fleet they may
 * live on different serial channels:
 *   - **Dispense** — the spring-coil motors, via the Weimi control
 *     board (`MotorInstruct` in the Weimi SDK). This is well understood.
 *   - **Payment** — the Nayax terminal. The topology is NOT yet
 *     confirmed (see hardware-testing-prep.md): it may be driven through
 *     the control board (`NayaxInstruct`) or directly over /dev/ttyS3.
 *     Payment methods are intentionally NOT on this interface yet — they
 *     get added once hardware testing (Step 0) tells us which path is
 *     real, so we don't bake in the wrong assumption.
 *
 * The real implementation ([WeimiHardwareController]) wraps the Weimi
 * SDK. A [FakeHardwareController] backs the emulator + the current
 * tap-to-fake payment flow.
 */
interface HardwareController {

    /** Observable state of the hardware link (serial up/down, last event). */
    val status: StateFlow<HardwareStatus>

    /**
     * Open the serial port(s) and initialize the SDK. Idempotent — calling
     * twice is a no-op if already started. [onResult] reports whether the
     * port opened.
     */
    fun start(onResult: (success: Boolean) -> Unit)

    /** Close serial port(s) and release the SDK. */
    fun stop()

    /**
     * Ask the control board for its hardware/software version. This is the
     * cheapest proof that serial comms work end-to-end (port + baud +
     * wiring + permissions). Result arrives asynchronously via [status]
     * (the SDK is callback-based, not request/response).
     */
    fun readBoardVersion(address: Int = 0)

    /**
     * Trigger a vend on [slot] at board [address]. The coil turns; whether
     * a product actually drops is a separate question answered by the
     * infrared sensor ([queryDropSensor]).
     *
     * This is the real money-moving action — guard its callers carefully.
     */
    /**
     * @param channelType SDK `setShipments` channelType. Null = the SDK default,
     *   which is the spiral behaviour every machine has used until now. A
     *   direct-push lane may need a different value; see WeimiHardwareController.
     */
    fun dispense(address: Int = 0, slot: Int, channelType: Int? = null)

    /**
     * Board-level infrared drop-sensor mode.
     *
     * NOTE: the SDK's setInfraredState takes only (address, isOpen) — there is
     * no lane or layer parameter. The sensor is a property of the BOARD, so it
     * cannot be enabled for layers 5–6 alone while leaving the spiral layers
     * without it. On a mixed machine it is one setting for the whole cabinet.
     */
    fun setInfraredState(open: Boolean, address: Int = 0)

    /**
     * Query the drop sensor (infrared / light grid). Tells us whether
     * something fell after a [dispense]. This is the signal that
     * distinguishes a successful vend from a failed one — and feeds the
     * complaint flow's "didn't vend" case.
     */
    fun queryDropSensor(address: Int = 0)

    /**
     * EXPERIMENTAL — Nayax cashless via the Weimi SDK.
     *
     * Calls `NayaxInstruct.sendPrice(...)` to present a price to the
     * Nayax terminal. The SDK exposes this but Weimi did NOT document the
     * parameter meanings or response codes (unlike dispense, which is
     * fully documented). The signature is `(int, int, int, long, String,
     * int)` from the bytecode; the meanings below are our best guess and
     * MUST be confirmed at the machine by observing what the terminal
     * does. This is why the test screen exposes the raw params as fields.
     *
     * Working hypothesis (to be verified, NOT trusted):
     *   - [address]: control-board address (0, like dispense)
     *   - [slot]: the aisle/cmd being purchased
     *   - [arg3]: unknown (currency? sub-command? try 0 first)
     *   - [amount]: the price as a long (units unknown — kr? minor units?)
     *   - [orderId]: transaction reference string
     *   - [arg6]: unknown (try 0)
     *
     * Money caution: only call on the bench, with the stock app closed,
     * using tiny amounts, until the protocol is understood. A wrong call
     * could in principle initiate a real charge.
     */
    fun sendNayaxPriceRaw(
        address: Int,
        slot: Int,
        arg3: Int,
        amount: Long,
        orderId: String,
        arg6: Int,
    )

    /** EXPERIMENTAL — cancel a pending Nayax price presentment. */
    fun cancelNayaxPriceRaw(address: Int, amount: Long, orderId: String, arg4: Int)

    /**
     * EXPERIMENTAL — the rest of the NayaxInstruct surface, for
     * reverse-engineering the cashless protocol on the bench.
     *
     * getCardMdbInfo is the prime suspect for the STATUS POLL / keep-alive
     * that the stock Weimi app uses to hold the terminal's host session
     * (without it, the terminal shows Error V00). The keep-alive helpers
     * call getCardMdbInfo on a timer to test whether we can hold the
     * session ourselves.
     *
     * String params: meaning unconfirmed — likely the device path
     * ("/dev/ttyS3") since that matches the longer MotorInstruct overloads.
     * The test screen exposes these as editable fields.
     */
    fun nayaxGetCardInfo(address: Int, str: String, arg3: Int)
    fun nayaxResponseReadCard(address: Int, str: String, arg3: Int)
    fun nayaxResponseAgree(address: Int, amount: Long, str: String, arg4: Int)
    fun nayaxSendPriceEnd(address: Int, arg2: Int, arg3: Int, str: String, arg5: Int)
    fun nayaxSendOutGoodResult(address: Int, arg2: Int, arg3: Int, amount: Long, str: String, arg6: Int)

    /**
     * Start polling getCardMdbInfo every [periodMs] to try to hold the
     * terminal's host session (clear/avoid Error V00). Stop with
     * [stopNayaxKeepAlive]. This is the key experiment: if polling holds the
     * session without the stock app, direct control becomes viable.
     */
    fun startNayaxKeepAlive(address: Int, str: String, arg3: Int, periodMs: Long)
    fun stopNayaxKeepAlive()

    // ---- energy / cooling board (read-only probe) ----
    // These target the SEPARATE energy board (SDK section 3), which may or
    // may not be fitted on a given machine. Read-only until a probe proves
    // the board answers; control commands (set temp / LED / compressor)
    // come later, once confirmed.

    /** Read cabinet temperature, humidity, evaporator temp (ctlTemp, mode=read). */
    fun readTemperature(address: Int = 0)

    /** Read power usage — energy, voltage, current (getEleInfo). */
    fun readPower(address: Int = 0)

    /** Read overall energy hardware status (getAllDeviceStatus). */
    fun readEnergyStatus(address: Int = 0)
}

/**
 * Snapshot of hardware link state for diagnostics + the debug test screen.
 *
 * [lastEvent] is a human-readable line of the most recent SDK callback
 * (version string, dispense ack, infrared result, error) — surfaced raw
 * in the debug screen so we can read protocol responses live at the
 * machine.
 */
data class HardwareStatus(
    val started: Boolean = false,
    val portPath: String? = null,
    val baud: Int? = null,
    val lastEvent: String = "—",
    /** Most recent decoded dispense outcome, or null if none yet. */
    val lastDispenseResult: DispenseResult? = null,
    /** Monotonic counter so the UI re-renders even on a repeated identical event. */
    val eventSeq: Long = 0,
)
