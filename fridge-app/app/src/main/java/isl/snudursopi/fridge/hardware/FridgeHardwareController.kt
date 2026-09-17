package isl.snudursopi.fridge.hardware

import kotlinx.coroutines.flow.StateFlow

/**
 * Abstraction over the gravity-fridge hardware, in the same spirit as the coil
 * app's `HardwareController` — but the fridge's two primitives are different:
 *
 *   - **Lock**   — an electronic bolt per cabinet, driven through the Weimi
 *     ZtlApi GPIO library (`openLock(cabinet)` / `closeLock(cabinet)`), with a
 *     lock-state and a door-state sensor per cabinet.
 *   - **Weight** — per-basket load cells on an RS-485 bus (weight service on
 *     /dev/ttyS3 per the live capture), addressed by tray number. We snapshot
 *     before unlock and read again after close.
 *
 * There is NO dispense here — removing the item is the customer's job; the
 * hardware's job is to unlock, sense the door, and weigh.
 *
 * The real implementation wraps the vendor SDK; [FakeFridgeHardware] backs the
 * emulator and lets the whole purchase flow run with simulated weights.
 */
interface FridgeHardwareController {

    val status: StateFlow<FridgeHardwareStatus>

    /** Open the serial/GPIO channels and init the SDK. Idempotent. */
    fun start(onResult: (success: Boolean) -> Unit)

    /** Release serial/GPIO and stop. */
    fun stop()

    /** Cheapest proof the link works end to end. Result arrives via [status]. */
    fun readBoardVersion()

    /**
     * Throw the bolt on [cabinet] (1 = A, 2 = B). On a double we call this for
     * BOTH cabinets to open both doors on one tap.
     */
    /**
     * Release the bolt on [cabinet] for [holdSeconds].
     *
     * The SDK's unlock takes a TIMEOUT and clamps anything below 6 up to 6, so
     * the default is a six-second hold — fine for a customer standing at the
     * door, useless for an operator who pressed a button elsewhere and is still
     * walking over. Pass a longer hold for staff work.
     */
    fun openLock(cabinet: Int, holdSeconds: Int = 0)

    /** Re-lock [cabinet] (used on timeout / after a completed session). */
    fun closeLock(cabinet: Int)

    /**
     * Read the lock + door sensors for [cabinet]. Result arrives via [status]
     * as a [DoorState]. Used to detect "door closed" — the trigger to settle —
     * and "door left open" — the timeout warning.
     */
    fun readDoorState(cabinet: Int)

    /**
     * Read the current weight of every basket (addressed broadcast on the bus).
     * Results arrive via [onWeights] as basket number -> grams. Used for the
     * pre-unlock snapshot, the live estimate while open, and the post-close
     * settlement read.
     */
    fun readWeights(onWeights: (Map<Int, Int>) -> Unit)

    /**
     * Zero (tare) a single tray — resets its load cell's zero point. Needed
     * after transport, since cells drift. Empty the tray first.
     */
    fun tareTray(tray: Int)

    /**
     * Calibrate a single tray against a known reference weight (grams). Place
     * the reference on the (already tared) tray, then call this with its exact
     * weight so the cell's scale factor is set.
     */
    fun calibrateTray(tray: Int, knownWeightG: Int)

    /**
     * Set the basket's LED price tag (INSTRUCT_SET_ELE_PRICE, 144).
     *
     * [rawValue] is passed to the SDK UNCHANGED and is NOT krónur. The SDK
     * divides it by 100 and formats "0.00", then lights a decimal point on
     * whichever digit the dot lands on — an encoding built for a two-decimal
     * currency. What integer renders a clean ISK price on a 4-digit tag has to
     * be established by experiment, which is why this takes a raw value rather
     * than a price.
     */
    fun setPriceTag(tray: Int, rawValue: Int)

    /**
     * Set the LED price tag from RAW DIGITS, bypassing the SDK's price
     * formatter entirely so no decimal point is ever lit.
     *
     * [text] is right-aligned into the tag's four digits; anything
     * non-numeric blanks that digit. "299" therefore shows as " 299".
     * This exists because Iceland doesn't use decimals and the SDK's
     * own encoder cannot render a three-digit price without a dot.
     */
    fun setPriceTagDigits(tray: Int, text: String)

    /**
     * Ask the board for a tray's sensor/module health. Used to distinguish a
     * genuinely faulty load cell from one that's merely mis-calibrated, and
     * required by settlement (which refuses to unlock on a sensor fault).
     */
    fun readSensorStatus(tray: Int)

    /**
     * Ask the energy/refrigeration board for the cabinet temperature.
     *
     * *** PROBE ONLY AT THIS STAGE. The reply is logged as raw hex and NOT
     * parsed into a number, because the byte layout is unknown: the SDK's
     * constant pool gives us the command (INSTRUCT_GET_TEMPLATE — "template" is
     * the SDK's mistranslation of the Chinese for temperature) but says nothing
     * about width, sign, or whether the value is tenths of a degree. Inventing
     * a scaling and shipping it would put a plausible wrong number on a
     * food-safety panel, which is worse than an empty one.
     *
     * Fires getTemplate and getAllDeviceStatus together — the latter is likely
     * to carry temperature alongside compressor and defrost state, and one
     * round trip tells us which is the better source.
     */
    fun readTemperature()

    /**
     * Turn the compressor on or off and set the target temperature.
     *
     * *** SETPOINT IS WHOLE DEGREES; THE PROBE READING IS SIGNED TENTHS.
     * Two different encodings on the same board — conflating them is a 10x
     * error, so this call deals only in whole degrees and never touches the
     * read path.
     *
     * [targetC] is clamped to 1..15. The coil side found the board accepts
     * out-of-range values and behaves oddly with them, so the clamp is a guard
     * against a bad dashboard value reaching the hardware, not a UI nicety.
     */
    fun setCooling(enabled: Boolean, targetC: Int?)

    /**
     * Set cabinet lighting brightness, 0-100, where 0 is off.
     *
     * *** THE PARAMETER SEMANTICS ARE NOT ESTABLISHED. The SDK exposes both
     * `EnergyInstruct.ctlLed(int, int, int, String, int)` and
     * `ledBrightnessAdjustment(...)` with the same shape as `ctlTemp`, but
     * which int is a mode and which is a level is NOT documented and has never
     * been observed on this hardware. See [MotorFridgeHardware.setLedBrightness]
     * — it sends one combination and logs the raw call so a bench run settles
     * it, exactly as the 0x4A reply was settled.
     *
     * Do not trust an `ok` from this until the lights have been watched to
     * change. Twelve combinations of ctlTemp against ctrlCompressor were swept
     * on this board before anyone noticed mode 0 was a read.
     */
    fun setLedBrightness(brightness: Int)

    /**
     * Start or stop a defrost cycle.
     *
     * Same caveat as [setLedBrightness]: `ctrlDefrost(int, int, int, String,
     * int)` matches the `ctlTemp` shape, so mode-then-value is the obvious
     * reading, and obvious readings of this board's API have been wrong before.
     * The board does not acknowledge, so the only confirmation is the cabinet
     * temperature rising during the cycle.
     */
    fun setDefrost(on: Boolean)

    /**
     * Send a read and SUSPEND until a genuinely new response arrives (or the
     * timeout expires, returning null).
     *
     * [readWeights] hands back the cached snapshot immediately — the real reply
     * lands ~2.4s later on this bus. Anything that needs distinct successive
     * samples (the median-of-3 that decides what we charge) MUST use this, or
     * it silently averages the same stale map three times.
     */
    suspend fun readWeightsFresh(timeoutMs: Long = 8000L): Map<Int, Int>?

    /**
     * Fresh read of just [count] trays starting at [firstTray]. A full 16-tray
     * read costs ~2.4s on this bus; narrowing it to the one or two trays that
     * actually changed is much quicker, which matters because the card
     * session expires while we're still settling.
     */
    suspend fun readTraysFresh(
        firstTray: Int,
        count: Int,
        timeoutMs: Long = 8000L,
    ): Map<Int, Int>?

    /**
     * Trays the board has reported a fault for: tray number -> error code
     * (1 = sensor damaged/wire loose, 2 = over max, 3 = board not responding).
     *
     * This board does NOT answer an on-demand status query, so health is only
     * knowable from the faults it pushes at us. Settlement refuses to unlock
     * while any sellable basket is in here.
     */
    val sensorFaults: StateFlow<Map<Int, Int>>

    /** Latest door/lock state pushed by the board, or null if none seen yet. */
    val doorState: StateFlow<DoorState?>
}

/** Lock + door sensor snapshot for one cabinet. */
data class DoorState(
    val cabinet: Int,
    val locked: Boolean,
    val doorOpen: Boolean,
    /** True if the cell(s) on this cabinet failed to answer — gates opening. */
    val sensorFault: Boolean = false,
)

data class FridgeHardwareStatus(
    val started: Boolean = false,
    val weightPort: String? = null,
    val baud: Int? = null,
    val lastEvent: String = "—",
    val lastDoorState: DoorState? = null,
    val eventSeq: Long = 0,
)
