package isl.snudursopi.fridge.hardware

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * In-memory fridge hardware for the emulator and for driving the whole
 * purchase flow without a real machine. Mirrors the coil app's
 * FakeHardwareController approach: same interface, simulated behaviour.
 *
 * It holds a settable weight map so a test/dev screen can "take" an item
 * (drop a basket's weight by one unit) and watch the flow settle correctly.
 */
class FakeFridgeHardware(
    initialWeights: Map<Int, Int> = emptyMap(),
) : FridgeHardwareController {

    private val _status = MutableStateFlow(
        FridgeHardwareStatus(weightPort = "fake", baud = 115200)
    )
    override val status: StateFlow<FridgeHardwareStatus> = _status

    /** Mutable simulated basket weights (basket number -> grams). */
    private val weights: MutableMap<Int, Int> = initialWeights.toMutableMap()
    private val doorOpen: MutableMap<Int, Boolean> = mutableMapOf(1 to false, 2 to false)
    private val locked: MutableMap<Int, Boolean> = mutableMapOf(1 to true, 2 to true)
    private var seq = 0L

    /** Test hook: set a basket's resting weight. */
    fun setWeight(basket: Int, grams: Int) { weights[basket] = grams }

    /** Test hook: simulate removing [count] units of [unitWeightG] from a basket. */
    fun take(basket: Int, unitWeightG: Int, count: Int = 1) {
        weights[basket] = (weights[basket] ?: 0) - unitWeightG * count
    }

    /** Test hook: simulate the customer opening/closing a door. */
    fun setDoorOpen(cabinet: Int, open: Boolean) {
        doorOpen[cabinet] = open
        emit("fake door $cabinet ${if (open) "opened" else "closed"}",
            DoorState(cabinet, locked[cabinet] ?: true, open))
    }

    override fun start(onResult: (Boolean) -> Unit) {
        _status.value = _status.value.copy(started = true, lastEvent = "fake started")
        onResult(true)
    }

    override fun stop() {
        _status.value = _status.value.copy(started = false, lastEvent = "fake stopped")
    }

    override fun readBoardVersion() = emit("fake board v0", null)

    override fun openLock(cabinet: Int, holdSeconds: Int) {
        locked[cabinet] = false
        emit("fake openLock $cabinet", DoorState(cabinet, false, doorOpen[cabinet] ?: false))
    }

    override fun closeLock(cabinet: Int) {
        locked[cabinet] = true
        emit("fake closeLock $cabinet", DoorState(cabinet, true, doorOpen[cabinet] ?: false))
    }

    override fun readDoorState(cabinet: Int) {
        emit("fake doorState $cabinet",
            DoorState(cabinet, locked[cabinet] ?: true, doorOpen[cabinet] ?: false))
    }

    override fun readWeights(onWeights: (Map<Int, Int>) -> Unit) {
        onWeights(weights.toMap())
    }

    override fun tareTray(tray: Int) {
        weights[tray] = 0
        emit("fake tare tray=$tray", null)
    }

    override fun calibrateTray(tray: Int, knownWeightG: Int) {
        emit("fake calibrate tray=$tray with ${knownWeightG}g", null)
    }

    override fun setPriceTag(tray: Int, rawValue: Int) {
        // No hardware in the fake; the log line is the whole behaviour.
        emit("fake price tag tray=$tray raw=$rawValue", null)
    }

    override fun setPriceTagDigits(tray: Int, text: String) {
        emit("fake price tag tray=$tray digits='$text'", null)
    }

    override fun setCooling(enabled: Boolean, targetC: Int?) {
        emit("setCooling enabled=$enabled target=${targetC ?: "unchanged"} (fake)", null)
    }

    override fun setLedBrightness(brightness: Int) {
        emit("setLedBrightness ${brightness.coerceIn(0, 100)} (fake)", null)
    }

    override fun setDefrost(on: Boolean) {
        emit("setDefrost ${if (on) "on" else "off"} (fake)", null)
    }

    override fun readTemperature() {
        emit("readTemperature (fake: no board)", null)
    }

    override fun readSensorStatus(tray: Int) {
        emit("fake sensor status tray=$tray OK", null)
    }

    private val _sensorFaults = MutableStateFlow<Map<Int, Int>>(emptyMap())
    override val sensorFaults: StateFlow<Map<Int, Int>> = _sensorFaults

    private val _doorState = MutableStateFlow<DoorState?>(null)
    override val doorState: StateFlow<DoorState?> = _doorState

    override suspend fun readWeightsFresh(timeoutMs: Long): Map<Int, Int> {
        delay(80)
        return weights.toMap()
    }

    override suspend fun readTraysFresh(
        firstTray: Int,
        count: Int,
        timeoutMs: Long,
    ): Map<Int, Int> {
        delay(40)
        return weights.toMap()
    }

    private fun emit(event: String, door: DoorState?) {
        seq += 1
        _status.value = _status.value.copy(
            lastEvent = event,
            lastDoorState = door ?: _status.value.lastDoorState,
            eventSeq = seq,
        )
    }
}
