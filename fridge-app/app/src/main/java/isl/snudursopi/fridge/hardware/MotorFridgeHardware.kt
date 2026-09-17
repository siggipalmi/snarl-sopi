package isl.snudursopi.fridge.hardware

import android.content.Context
import android.util.Log
import com.weimi.motorserial.MotorSerialPortKit
import com.weimi.motorserial.bean.MotorSendBean
import com.weimi.motorserial.data.MotorInstructCode
import com.weimi.serialport.IStartKitCallback
import com.weimi.serialport.SerialportConfigBean
import com.weimi.serialport.bean.ReceiverBean
import com.weimi.serialport.callback.ISerialportResponseCallback
import com.weimi.serialport.log.SerialLog
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Real fridge hardware, built on Weimi's MotorSerialPortKit — the same serial
 * framework the official Weimi SDK sample uses. This replaces the earlier
 * hand-rolled raw-serial transport (which never got a reply because the bus is
 * driven through this kit, not a raw file handle).
 *
 * One kit, both primitives:
 *   - weight  → MotorSerialPortKit.getWeightInstruct().multiReadModuleWeight(...)
 *   - lock    → MotorSerialPortKit.getLockInstruct().unlock(...) / getLockStatus(...)
 *
 * Responses arrive asynchronously on [responseCallback] as ReceiverBean; we
 * match bean.cmd against MotorInstructCode and fold results into state.
 */
class MotorFridgeHardware(
    private val appContext: Context,
    /**
     * *** MUST MATCH THE PHYSICAL CABINET COUNT, AND WAS HARDCODED AT 16.
     *
     * A double fridge has 32 trays. With this stuck at 16 the weight poll only
     * ever reads cabinet A, so every basket in cabinet B looks untouched — the
     * customer takes an item and is charged nothing. It fails as working
     * software, because cabinet A behaves perfectly throughout.
     *
     * Var, not val: the spec arrives with the planogram from the backend, which
     * is well after this object is constructed. [setTrayCount] is called once
     * the planogram lands.
     */
    private var trayCount: Int,
    private val weightPortPath: String = "/dev/ttyS3",
    private val baud: Int = 9600,
    private val onLog: (String) -> Unit = {},
) : FridgeHardwareController {

    private val kit = MotorSerialPortKit

    private val _status = MutableStateFlow(
        FridgeHardwareStatus(weightPort = weightPortPath, baud = baud)
    )
    override val status: StateFlow<FridgeHardwareStatus> = _status

    /** Latest known weight per tray number, updated as responses arrive. */
    private val latest = HashMap<Int, Int>()

    /** Bumped every time a multi-weight response lands, so readWeightsFresh
     *  can tell a genuinely new sample from the cached one. */
    private val weightSeq = MutableStateFlow(0L)

    private val _sensorFaults = MutableStateFlow<Map<Int, Int>>(emptyMap())
    override val sensorFaults: StateFlow<Map<Int, Int>> = _sensorFaults

    private val _doorState = MutableStateFlow<DoorState?>(null)
    override val doorState: StateFlow<DoorState?> = _doorState
    private var seq = 0L

    private val startCallback = object : IStartKitCallback.Stub() {
        override fun onStartKitResult(result: Int, path: String?) {
            // Per the Weimi sample, -1 and 1 both mean success.
            val ok = result == -1 || result == 1
            emit(if (ok) "serial started ($path) code=$result" else "serial start FAILED code=$result", null)
            if (ok) {
                // Board handshake: the stock app sends cmd 1 (GET_VERSION) +
                // module-status at startup to enumerate/wake the gravity boards
                // (a.k()). Weights only came back when the stock app was running,
                // so fire these once here so the boards start answering our polls.
                kit.getMotorInstruct()?.getVersion(0, null, 50)
                kit.getWeightInstruct()?.getModuleStatus(0, null, 50)
                emit("board handshake sent (getVersion + getModuleStatus)", null)
            }
        }
        override fun onRuntimeError(error: Int) {
            emit("serial runtime event code=$error", null)
        }
    }

    private val responseCallback = object : ISerialportResponseCallback {
        override fun onResponse(bean: ReceiverBean, devicePath: String) {
            handleResponse(bean, devicePath)
        }
    }

    override fun start(onResult: (Boolean) -> Unit) {
        try {
            // Idempotency guard: if the kit was already started, a second
            // startSerialPortKit() hits the SDK's "already started" no-op —
            // polling then fires but reads go nowhere. Stop first so every
            // start is clean. (Field techs / restarts must never wedge the bus.)
            if (_status.value.started) {
                try { kit.stopSerialPortKit(appContext) } catch (_: Throwable) {}
                Thread.sleep(200) // let the child service tear down before re-open
            }
            // Route the SDK's OWN serial logging to logcat (tag "SDK/...") so we
            // can see byte-level TX/RX the kit does internally.
            SerialLog.logCallback = object : SerialLog.LogCallback {
                override fun d(tag: String, message: String) { Log.d("SDK/$tag", message) }
                override fun e(tag: String, message: String) { Log.e("SDK/$tag", message) }
                override fun i(tag: String, message: String) { Log.i("SDK/$tag", message) }
                override fun v(tag: String, message: String) { Log.v("SDK/$tag", message) }
                override fun w(tag: String, message: String) { Log.w("SDK/$tag", message) }
            }
            kit.initSerialPortKit()
            val configs = arrayOf(SerialportConfigBean(weightPortPath, baud, 0, 0))
            kit.startSerialPortKit(appContext, startCallback, configs, responseCallback)
            _status.value = _status.value.copy(started = true, lastEvent = "serial kit started")
            emit("kit start requested on $weightPortPath @ $baud", null)
            onResult(true)
        } catch (t: Throwable) {
            Log.e(TAG, "start failed: ${t.message}", t)
            emit("start FAILED: ${t.message}", null)
            onResult(false)
        }
    }

    override fun stop() {
        try { kit.stopSerialPortKit(appContext) } catch (_: Throwable) {}
        _status.value = _status.value.copy(started = false, lastEvent = "stopped")
    }

    override fun readBoardVersion() {
        // Board handshake — this is what the stock app does (a.k() sends cmd 1
        // GET_VERSION to enumerate/wake the boards). Weights only came back when
        // the stock app was running, so the boards likely need this enable
        // before they answer weight polls. Fire version + module-status, then a
        // read.
        kit.getMotorInstruct()?.getVersion(0, null, 50)
        kit.getWeightInstruct()?.getModuleStatus(0, null, 50)
        issueWeightRead()
        emit("readBoardVersion → handshake (getVersion+getModuleStatus)+read", null)
    }

    /**
     * *** CABINET B IS NOT CONTIGUOUS WITH CABINET A. TWO READS, NOT ONE.
     *
     * multiReadModuleWeight(count, firstTray) asks for a CONTIGUOUS run, so a
     * single call for 36 trays sweeps 0..35 — including 16..19, which exist on
     * no machine and answer nothing. The board then burns six retries on each,
     * which is exactly the bus hammering that cycled machine #2's lights and
     * compressor.
     *
     * The vendor allots each cabinet a block of 20 addresses, so the real
     * layout is 0..15 and 20..35 with a four-address hole between. That needs
     * two reads.
     *
     * Fixing the tray MAPPING without fixing the READ was my error in v0.47.0:
     * the app knew cabinet B basket 1 was tray 20, then asked for every tray
     * from 0 to 35 anyway.
     */
    private fun issueWeightRead() {
        val wi = kit.getWeightInstruct() ?: return
        val perCabinet = isl.snudursopi.fridge.domain.Planogram.BASKETS_PER_CABINET
        val block = isl.snudursopi.fridge.domain.Planogram.ADDRESS_BLOCK_PER_CABINET
        wi.multiReadModuleWeight(minOf(trayCount, perCabinet), 0)
        if (trayCount > block) {
            // Cabinet B: 16 modules from address 20.
            wi.multiReadModuleWeight(trayCount - block, block)
        }
    }

    override fun openLock(cabinet: Int, holdSeconds: Int) {
        // Second arg is the bolt HOLD TIMEOUT, not a delay. The SDK clamps
        // anything under 6 up to 6, so the old hard-coded 0 meant a six-second
        // hold — which is why a restock opened from a desk had always re-locked
        // by the time anyone reached the machine.
        kit.getLockInstruct()?.unlock(cabinet, holdSeconds, null, 50)
        emit(
            "openLock cabinet=$cabinet hold=${if (holdSeconds < 6) 6 else holdSeconds}s",
            DoorState(cabinet, locked = false, doorOpen = false),
        )
    }

    override fun closeLock(cabinet: Int) {
        // The bolt re-locks itself on door close; there's no explicit close
        // command. Query status to reflect reality.
        kit.getLockInstruct()?.getLockStatus(cabinet, null, 50)
        emit("closeLock cabinet=$cabinet (query status)", null)
    }

    override fun readDoorState(cabinet: Int) {
        kit.getLockInstruct()?.getLockStatus(cabinet, null, 50)
        emit("readDoorState cabinet=$cabinet", null)
    }

    override fun readWeights(onWeights: (Map<Int, Int>) -> Unit) {
        val wi = kit.getWeightInstruct()
        if (wi == null) {
            emit("readWeights: getWeightInstruct() is NULL (kit not ready)", null)
        } else {
            // Match the sample exactly: 2-arg call, SDK defaults for the rest.
            issueWeightRead()
            emit("readWeights → multi-read trayCount=$trayCount (instruct OK)", null)
        }
        // Hand back the current snapshot; responses fold in asynchronously.
        onWeights(HashMap(latest))
    }

    /**
     * *** COOLING IS DRIVEN BY THE SETPOINT, NOT BY A COMPRESSOR TOGGLE.
     *
     * The board runs its own closed-loop thermostat and decides when to run the
     * compressor. That is why ctrlCompressor was acknowledged and ignored, and
     * why twelve swept combinations changed nothing: we never wrote a setpoint
     * below ambient, so the thermostat had no target to act on. Writing one is
     * the whole operation.
     *
     * "Off" is expressed as the warmest allowed setpoint rather than a stop
     * command — there is no honest way to force the compressor off through a
     * thermostat, and pretending otherwise would be a control that silently
     * does nothing.
     */
    private val _cabinetTempC = MutableStateFlow<Double?>(null)

    /** Latest cabinet temperature in C, or null if we have never read one. */
    val cabinetTempC: StateFlow<Double?> = _cabinetTempC.asStateFlow()

    private val _setpointC = MutableStateFlow<Int?>(null)
    val setpointC: StateFlow<Int?> = _setpointC.asStateFlow()

    /**
     * Decode a ctlTemp (0x4A) reply.
     *
     * Offsets are into the data HEX STRING as the coil decoder defines them, so
     * the two stay comparable — one shared decoder for one board, rather than
     * two that drift:
     *
     *   [20:24]  cabinet temperature, signed 16-bit big-endian, tenths of C
     *   [36:38]  sub-command; the setpoint field is only meaningful when 00
     *   [38:40]  setpoint, whole degrees C
     *
     * The signed decode matters below zero: 0xFFEC is -2.0 C, not 6553.2.
     */
    private fun parseEnergyFrame(data: String?) {
        val hex = data ?: return
        if (hex.length < 40) {
            Log.w(TAG, "ctlTemp reply too short (${hex.length} chars): $hex")
            return
        }
        val raw = hex.substring(20, 24).toIntOrNull(16)
        if (raw == null) {
            Log.w(TAG, "ctlTemp reply: bad temperature field in $hex")
            return
        }
        val signed = if (raw and 0x8000 != 0) raw - 0x10000 else raw
        val tempC = signed / 10.0
        // Sanity band, not a hard filter: a cabinet outside -30..60 C means the
        // decode or the probe is wrong, and a wrong number on a food-safety
        // panel is worse than none. Log it and keep the previous reading.
        if (tempC < -30.0 || tempC > 60.0) {
            Log.w(TAG, "ctlTemp reply: implausible temperature $tempC C — ignoring ($hex)")
            return
        }
        _cabinetTempC.value = tempC

        val setpointValid = hex.substring(36, 38) == "00"
        val setpoint = if (setpointValid) hex.substring(38, 40).toIntOrNull(16) else null
        if (setpoint != null) _setpointC.value = setpoint

        Log.i(
            TAG,
            "cabinet ${"%.1f".format(tempC)} C" +
                (setpoint?.let { ", setpoint $it C" } ?: ", setpoint n/a"),
        )
        emit("cabinet ${"%.1f".format(tempC)} C", null)
    }

    override fun setCooling(enabled: Boolean, targetC: Int?) {
        val ei = kit.getEnergyInstruct() ?: run {
            emit("setCooling: getEnergyInstruct() is NULL", null)
            return
        }
        // Clamped 1..15: the board accepts out-of-range values and behaves
        // oddly with them.
        val target = (if (enabled) (targetC ?: 4) else 15).coerceIn(1, 15)
        Thread {
            Log.i(TAG, "setCooling >>> ctlTemp(mode=1, setpoint=$target)")
            ei.ctlTemp(0, 1, target, null, 50)   // mode 1 = WRITE setpoint
            Thread.sleep(500)
            Log.i(TAG, "setCooling >>> read back")
            ei.ctlTemp(0, 0, 0, null, 50)        // mode 0 = READ, confirms it took
        }.start()
        emit("setCooling setpoint=$target C requested", null)
    }

    /**
     * Widen (or narrow) the poll once the planogram tells us how many cabinets
     * this machine actually has. Idempotent; logs only on a real change.
     */
    /**
     * Trays that answered "gravity board no response" — the module is not on the
     * bus at all, as distinct from a damaged sensor that does reply.
     */
    private val absentTrays = mutableSetOf<Int>()
    private var narrowedFor: Int? = null

    /**
     * *** STOP ASKING FOR MODULES THAT ARE NOT THERE.
     *
     * The six retries per tray are the BOARD's, not ours: we request 32 trays,
     * it tries each missing one six times and then notifies us. With sixteen
     * absent modules that is a continuous ~75-second sweep of a bus shared with
     * the lights and the compressor, forever — which is what cycled machine #2's
     * lights and cooling on 2026-08-27.
     *
     * So once a whole cabinet's worth of trays has reported "no response", stop
     * requesting them. The machine keeps selling from the cabinet that works
     * instead of flogging the bus for one that does not.
     *
     * Deliberately NOT silent: it logs at warn every time it narrows, because a
     * fridge quietly running at half capacity is a fault someone must see. And
     * deliberately not persistent — a reboot re-tries the full range, so fixing
     * the wiring needs no app change.
     */
    private fun noteAbsentModule(tray: Int) {
        absentTrays += tray
        if (trayCount <= isl.snudursopi.fridge.domain.Planogram.BASKETS_PER_CABINET) return
        // Cabinet B occupies 20..trayCount-1; 16..19 are unused padding in the
        // vendor's address scheme and never answer on any machine.
        val upper = (isl.snudursopi.fridge.domain.Planogram.ADDRESS_BLOCK_PER_CABINET until trayCount).toSet()
        if (!absentTrays.containsAll(upper)) return
        if (narrowedFor == trayCount) return
        narrowedFor = trayCount
        Log.w(
            TAG,
            "ALL trays ${upper.min()}..${upper.max()} report no gravity board — " +
                "narrowing the weight poll to ${isl.snudursopi.fridge.domain.Planogram.BASKETS_PER_CABINET} trays. " +
                "Cabinet B cannot sell until its modules are on the bus.",
        )
        emit("cabinet B modules absent — polling 16 trays only", null)
        trayCount = isl.snudursopi.fridge.domain.Planogram.BASKETS_PER_CABINET
    }

    private val probeAnswers = mutableSetOf<Int>()
    private val probeFaults = mutableMapOf<Int, Int>()

    /**
     * *** READ-ONLY ADDRESS SWEEP. CHANGES NOTHING.
     *
     * Asks each address 0..31 for its hardware version and records which reply.
     * getHardVersion is a query, so this cannot move a module or disturb a
     * working cabinet — which matters because the machine is at a remote site
     * and the repair command (MotorInstruct.changeShipmentAddress) very much
     * CAN break the cabinet that still works if it is fired blind.
     *
     * What the result means:
     *   16 answers at 0..15, silence at 16..31
     *       -> only one cabinet's modules are on the bus. Either cabinet B is
     *          unplugged, or its modules are still factory-addressed 0..15 and
     *          colliding with cabinet A. The corrupted cabinet A frames we see
     *          (a missing #14, a duplicated #0) point at collision.
     *   32 answers
     *       -> every module is present and addressed correctly, and the fault is
     *          elsewhere entirely.
     *
     * Deliberately slow — 250ms between queries. A burst would itself disturb
     * the bus we are trying to characterise.
     */
    /** Modules that answered the last sweep, and any that reported a fault. */
    fun lastProbeResult(): String {
        val ok = probeAnswers.sorted()
        val faulted = probeFaults.toSortedMap().entries.joinToString(",") { "${it.key}:${it.value}" }
        return "answered=${ok.size} $ok" +
            (if (faulted.isNotEmpty()) " | faults $faulted" else "") +
            when {
                ok.isEmpty() -> "  — NO modules on the bus at all"
                ok.size <= 16 -> "  — only one cabinet's modules present"
                else -> "  — both cabinets present"
            }
    }

    /**
     * *** READ-ONLY MODULE SWEEP. CHANGES NOTHING.
     *
     * Asks each tray 0..31 for its module status. This is the call that actually
     * reaches the shelf modules — an earlier version of this probe used
     * HardWareInstruct.getHardVersion, which only the CONTROLLER answers, so it
     * reported a single reply from the WM3.0ZL itself and told us nothing about
     * the shelves. getModuleStatus is what produces the real per-tray faults.
     *
     * Reading, once it runs:
     *   answered 0..15, faults 16..31   -> cabinet B's modules are not on the
     *       bus. Either unplugged, unpowered, or still factory-addressed 0..15
     *       and colliding with cabinet A — the corrupted cabinet A frames (a
     *       missing #14, a duplicated #0) point at collision.
     *   answered 0..31                  -> every module present; the fault lies
     *       elsewhere.
     *
     * 300ms between queries: the board itself retries a silent module six times
     * before giving up, so a faster sweep would simply queue behind itself.
     */
    fun probeAddresses() {
        val wi = kit.getWeightInstruct()
        if (wi == null) {
            emit("probeAddresses: getWeightInstruct() is NULL", null)
            return
        }
        probeAnswers.clear()
        probeFaults.clear()
        Thread {
            Log.i(TAG, "ADDR PROBE >>> sweeping trays 0..31 via getModuleStatus (read-only)")
            for (tray in 0..31) {
                runCatching { wi.getModuleStatus(tray, null, 50) }
                Thread.sleep(300)
            }
            // A silent module costs the board ~4.6s of retries before it
            // notifies, so leave room for the tail of those to arrive.
            Thread.sleep(8_000)
            Log.w(TAG, "ADDR PROBE done — ${lastProbeResult()}")
            emit("address probe: ${lastProbeResult()}", null)
        }.start()
        emit("address probe started (~18s, read-only)", null)
    }

    fun setTrayCount(count: Int) {
        // 36 = cabinet B's block start (20) + 16 baskets.
        val next = count.coerceIn(1, 36)
        if (next == trayCount) return
        // A deliberate re-widen clears the narrowing, so a fixed machine
        // recovers on the next planogram without a reinstall.
        absentTrays.clear()
        narrowedFor = null
        Log.i(TAG, "trayCount $trayCount -> $next")
        trayCount = next
        emit("trayCount now $next", null)
    }

    /**
     * *** UNVERIFIED PARAMETER MAPPING — READ THIS BEFORE TRUSTING A RESULT.
     *
     * `ctlLed` and `ledBrightnessAdjustment` both take (int, int, int, String,
     * int), the same shape as `ctlTemp(address, mode, value, tag, timeout)`.
     * By analogy: address 0, mode 1 = write, third arg = the value. That is an
     * ANALOGY, not an observation. On this board the analogous reading of
     * ctlTemp was wrong for days — mode 0 turned out to be a read, so a sweep
     * of twelve mode/compressor combinations never once wrote a setpoint.
     *
     * So this sends one combination and logs the exact call. One bench run with
     * logcat open says whether the lights moved and at what level, and the
     * constants below become facts instead of inference. Until then the command
     * result says "sent", never "working".
     *
     * ctlLed first because the name is the control and brightness adjustment
     * reads like a modifier on it. If the lights do not respond, try
     * ledBrightnessAdjustment with the same arguments before changing the ints
     * — swapping two unknowns at once is how a day disappears.
     */
    override fun setLedBrightness(brightness: Int) {
        val ei = kit.getEnergyInstruct() ?: run {
            emit("setLedBrightness: getEnergyInstruct() is NULL", null)
            return
        }
        val level = brightness.coerceIn(0, 100)
        Thread {
            Log.i(TAG, "setLedBrightness >>> ctlLed(addr=0, mode=$LED_MODE_WRITE, level=$level, null, 50)")
            ei.ctlLed(0, LED_MODE_WRITE, level, null, 50)
        }.start()
        emit("led brightness=$level requested (UNCONFIRMED — watch the cabinet)", null)
    }

    /**
     * Defrost, with the same unverified-mapping caveat as [setLedBrightness].
     *
     * The board runs its own thermostat and ignores ctrlCompressor entirely, so
     * there is a real possibility it treats defrost the same way — acknowledged
     * and ignored, with its own schedule winning. getDefrostPeriod and
     * getDefrostMaxTime exist on EnergyInstruct and would say what that schedule
     * is; worth reading before concluding a manual defrost does not work.
     */
    override fun setDefrost(on: Boolean) {
        val ei = kit.getEnergyInstruct() ?: run {
            emit("setDefrost: getEnergyInstruct() is NULL", null)
            return
        }
        val value = if (on) 1 else 0
        Thread {
            Log.i(TAG, "setDefrost >>> ctrlDefrost(addr=0, mode=$DEFROST_MODE_WRITE, on=$value, null, 50)")
            ei.ctrlDefrost(0, DEFROST_MODE_WRITE, value, null, 50)
            Thread.sleep(500)
            Log.i(TAG, "setDefrost >>> read back temperature to watch the cycle")
            ei.ctlTemp(0, 0, 0, null, 50)
        }.start()
        emit("defrost ${if (on) "on" else "off"} requested (UNCONFIRMED)", null)
    }

    override fun readTemperature() {
        val ei = kit.getEnergyInstruct() ?: run {
            emit("readTemperature: getEnergyInstruct() is NULL", null)
            return
        }
        // *** mode 0 = READ. The third argument is ignored on a read.
        //
        // getTemplate is silent on this board and on the coil boards too — it
        // was never the right call. The temperature comes back in the 0x4A
        // (INSTRUCT_CTL_TEMP) reply, which we had been logging for days while
        // treating it as a bare acknowledgement. See [parseEnergyFrame].
        Thread { ei.ctlTemp(0, 0, 0, null, 50) }.start()
    }

    override fun tareTray(tray: Int) {
        kit.getWeightInstruct()?.tare(tray, null, 50)
        emit("tare tray=$tray requested", null)
    }

    override fun calibrateTray(tray: Int, knownWeightG: Int) {
        kit.getWeightInstruct()?.adjust(tray, knownWeightG, null, 50)
        emit("calibrate tray=$tray with ${knownWeightG}g requested", null)
    }

    override fun setPriceTag(tray: Int, rawValue: Int) {
        kit.getWeightInstruct()?.setElePrice(tray, rawValue, null, 50)
        // Log what the SDK will make of the value, so the log alone explains
        // whatever ends up on the tag.
        val asDecimal = String.format("%.2f", rawValue / 100.0)
        emit("price tag tray=$tray raw=$rawValue (SDK formats as $asDecimal)", null)
    }

    override fun setPriceTagDigits(tray: Int, text: String) {
        val wi = kit.getWeightInstruct()
        if (wi == null) {
            emit("price tag digits: instruct NULL", null)
            return
        }
        // Build the SET_ELE_PRICE payload BY HAND. The SDK's own builder is
        // hard-wired to a two-decimal currency: it formats the value as "0.00"
        // and then ORs 0x80 into whichever digit the decimal point follows, so
        // a three-digit ISK price always lights a dot. Iceland doesn't use
        // decimals, so we send the digit bytes ourselves and never set that bit.
        //
        // Layout, read straight off the SDK's private getElePrice():
        //   [0..1]  tray number (2 bytes; order only matters above tray 0)
        //   [2]     constant 2
        //   [3..6]  the four digit bytes, left to right; 0x11 blanks a digit
        //   [7..10] zero padding
        val payload = ByteArray(11)
        // BIG-ENDIAN: high byte first. Getting this backwards sent every tray
        // below 256 to tray 0, because the board takes the low byte from
        // payload[1] — which little-endian ordering leaves as zero. That is
        // exactly the symptom we saw: tray 0 received everything.
        payload[0] = ((tray shr 8) and 0xFF).toByte()
        payload[1] = (tray and 0xFF).toByte()
        payload[2] = 2
        val padded = text.takeLast(4).padStart(4, ' ')
        for (i in 0 until 4) {
            val c = padded[i]
            payload[3 + i] = if (c.isDigit()) (c - '0').toByte() else BLANK_DIGIT
        }
        val bean = MotorSendBean(144)   // INSTRUCT_SET_ELE_PRICE
        // MotorSendBean is Kotlin, so these are `var` properties — assign them.
        // Calling setDataLength()/setAddress()/setDataByte() doesn't compile from
        // Kotlin even though the decompiled Java shows those method names.
        bean.dataLength = 11
        bean.address = 0
        bean.dataByte = payload
        wi.serialPortKit.serialPortImplSendData(
            bean.toProtocolByteArray(),
            wi.callbackStub,
            50,
            null,
        )
        emit(
            "price tag tray=$tray digits='$padded' payload=" +
                payload.joinToString(" ") { "%02X".format(it) },
            null,
        )
    }

    override fun readSensorStatus(tray: Int) {
        kit.getWeightInstruct()?.getModuleStatus(tray, null, 50)
        emit("sensor status query tray=$tray", null)
    }

    override suspend fun readTraysFresh(
        firstTray: Int,
        count: Int,
        timeoutMs: Long,
    ): Map<Int, Int>? {
        val before = weightSeq.value
        val wi = kit.getWeightInstruct() ?: return null
        wi.multiReadModuleWeight(count, firstTray)
        var waited = 0L
        while (waited < timeoutMs) {
            if (weightSeq.value != before) return HashMap(latest)
            delay(50)
            waited += 50
        }
        emit("readTraysFresh($firstTray,$count) TIMED OUT", null)
        return null
    }

    override suspend fun readWeightsFresh(timeoutMs: Long): Map<Int, Int>? {
        val before = weightSeq.value
        val wi = kit.getWeightInstruct()
        if (wi == null) {
            emit("readWeightsFresh: instruct NULL", null)
            return null
        }
        // Two blocks, skipping the 16..19 address hole — see issueWeightRead.
        issueWeightRead()
        var waited = 0L
        while (waited < timeoutMs) {
            if (weightSeq.value != before) return HashMap(latest)
            delay(50)
            waited += 50
        }
        emit("readWeightsFresh TIMED OUT after ${timeoutMs}ms", null)
        return null
    }

    // ---- async response handling ----

    private fun handleResponse(bean: ReceiverBean, devicePath: String) {
        try {
            when (bean.cmd) {
                MotorInstructCode.INSTRUCT_READ_WEIGHT_MULTI -> {
                    // dataLength hex at data[14..18]; trays = len/5; each tray:
                    // dataByte[9 + i*5] = tray, next 4 bytes BE = weight.
                    val d = bean.dataByte ?: return
                    val len = bean.data.substring(14, 18).toInt(16)
                    val trays = len / 5
                    val sb = StringBuilder("multi $trays trays:")
                    for (i in 0 until trays) {
                        val off = 9 + i * 5
                        if (off + 5 > d.size) break
                        val tray = d[off].toInt() and 0xFF
                        val grams = ((d[off + 1].toInt() and 0xFF) shl 24) or
                            ((d[off + 2].toInt() and 0xFF) shl 16) or
                            ((d[off + 3].toInt() and 0xFF) shl 8) or
                            (d[off + 4].toInt() and 0xFF)
                        // Sanity filter: reject readings that can't be real (bus
                        // noise / interleaved frames produce wild tray#/weights).
                        // Real: tray 0..31, weight -500..50000 g.
                        if (tray in 0..31 && grams in -500..50000) {
                            latest[tray] = grams
                            sb.append(" #$tray=${grams}g")
                        }
                    }
                    weightSeq.value = weightSeq.value + 1
                    emit(sb.toString(), null)
                }
                // *** THE TEMPERATURE LIVES IN THIS FRAME.
                //
                // We logged 0x4A for days as a bare acknowledgement. It is the
                // ctlTemp reply and it carries the cabinet reading, verified
                // against frames captured before we knew what they meant:
                // [20:24] read 0x0122 = 29.0 C on a warm garage cabinet, and
                // the setpoint discriminator behaved exactly as documented.
                //
                // Offsets are into the DATA HEX STRING, not the byte array.
                MotorInstructCode.INSTRUCT_CTL_TEMP -> {
                    parseEnergyFrame(bean.data)
                }

                MotorInstructCode.INSTRUCT_GET_ALL_DEVICE_STATUS -> {
                    // Static presence flags, not a live reading. Kept only so
                    // the frame does not fall through to the unknown branch.
                    Log.i(TAG, "allDeviceStatus: ${bean.data}")
                }

                MotorInstructCode.INSTRUCT_TARE -> {
                    val tray = bean.data.substring(4, 12).toInt(16)
                    val result = bean.data.substring(18, 20).toInt(16)
                    emit("TARE tray=$tray ${if (result == 0) "OK" else "FAILED"}", null)
                }
                MotorInstructCode.INSTRUCT_ADJUST -> {
                    val tray = bean.data.substring(4, 12).toInt(16)
                    val result = bean.data.substring(18, 20).toInt(16)
                    emit("CALIBRATE tray=$tray ${if (result == 0) "OK" else "FAILED"}", null)
                }
                MotorInstructCode.INSTRUCT_GET_VERSION -> {
                    emit("BOARD VERSION reply — board alive! data=${bean.data.take(40)}", null)
                }
                MotorInstructCode.INSTRUCT_GET_MODULE_STATUS -> {
                    // The vendor sample never parses this reply, so the field
                    // layout is unknown. Log the FULL raw frame (not truncated)
                    // so we can decode it against known-good vs known-bad trays.
                    val addr = bean.data.substring(4, 12).toIntOrNull(16) ?: -1
                    probeAnswers += addr
                    Log.i(TAG, "ADDR PROBE reply from tray=$addr raw=${bean.data}")
                    emit("MODULE STATUS addr=$addr raw=${bean.data}", null)
                }
                MotorInstructCode.INSTRUCT_READ_WEIGHT -> {
                    // single-read: tray at data[4..12] hex, weight at data[18..26] hex.
                    val tray = bean.data.substring(4, 12).toInt(16)
                    val grams = bean.data.substring(18, 26).toLong(16).toInt()
                    latest[tray] = grams
                    emit("weight tray=$tray ${grams}g", null)
                }
                MotorInstructCode.INSTRUCT_NOTIFY_WEIGHT_ERROR -> {
                    val tray = bean.data.substring(18, 20).toInt(16)
                    val code = bean.data.substring(20, 22).toInt(16)
                    val reason = when (code) {
                        1 -> "sensor damaged / wire loose / AD chip"
                        2 -> "over max load"
                        3 -> "gravity board no response (6 tries)"
                        else -> "unknown code $code"
                    }
                    _sensorFaults.value = _sensorFaults.value + (tray to code)
                    emit("SENSOR FAULT tray=$tray — $reason", null)
                    probeFaults[tray] = code
                    if (code == 3) noteAbsentModule(tray)
                }
                MotorInstructCode.INSTRUCT_GET_LOCK_STATUS,
                MotorInstructCode.INSTRUCT_NOTIFY_LOCK_STATUS -> {
                    // Field map confirmed against the Weimi sample AND real
                    // frames from this machine (28 hex chars / 14 bytes):
                    //   data[18..20] door number  1 = A, 2 = B
                    //   data[20..22] door state   0 = OPEN,     1 = CLOSED
                    //   data[22..24] lock state   0 = UNLOCKED, 1 = LOCKED
                    // NOTE the door byte is inverted from what you'd guess:
                    // 0 means open. The bolt relocks itself on a timeout, so
                    // "closed + unlocked" is the normal post-unlock state until
                    // the customer actually pulls the door.
                    if (bean.data.length < 24) {
                        emit("lock frame too short raw=${bean.data}", null)
                        return
                    }
                    val doorNum = bean.data.substring(18, 20).toIntOrNull(16) ?: 0
                    val doorOpen = bean.data.substring(20, 22).toIntOrNull(16) == 0
                    val locked = bean.data.substring(22, 24).toIntOrNull(16) == 1
                    // The board expects an ack for the pushed variant.
                    // *** REJECT IMPOSSIBLE DOOR NUMBERS. Doors are 1 and 2;
                    // anything else means this frame is not the lock status we
                    // think it is — a truncated or mis-framed message on a bus
                    // that also carries weight traffic. Publishing it as truth
                    // once settled a live session 15 SECONDS EARLY, charging a
                    // customer mid-shop off a frame claiming "door 0, locked".
                    // A frame we can't identify is not evidence about the door.
                    if (doorNum !in 1..2) {
                        emit("IGNORED lock frame, impossible door=$doorNum raw=${bean.data}", null)
                        return
                    }
                    if (bean.cmd == MotorInstructCode.INSTRUCT_NOTIFY_LOCK_STATUS) {
                        kit.getLockInstruct()?.ackLockStatus(doorNum, devicePath, 50)
                    }
                    val ds = DoorState(doorNum, locked = locked, doorOpen = doorOpen)
                    _doorState.value = ds
                    emit(
                        "door $doorNum ${if (doorOpen) "OPEN" else "closed"} / " +
                            "${if (locked) "locked" else "unlocked"}",
                        ds,
                    )
                }
                MotorInstructCode.INSTRUCT_NOTIFY_ERROR_AFTER_UNLOCK -> {
                    val cab = bean.data.substring(18, 20).toInt(16)
                    kit.getLockInstruct()?.ackNotifyErrorAfterUnlock(cab, devicePath, 50)
                    emit("lock error-after-unlock cab=$cab (acked)", null)
                }
                MotorInstructCode.INSTRUCT_UNLOCK -> {
                    emit("unlock ack", null)
                }
                else -> {
                    // *** UNMATCHED FRAMES WERE INVISIBLE UNTIL v0.40.1.
                    //
                    // This branch only touched internal status, never logcat,
                    // so any reply whose cmd we do not handle vanished without
                    // trace. The getTemplate probe in v0.40.0 came back empty
                    // for exactly that reason: we cannot tell whether the board
                    // stayed silent or answered with a code we ignore.
                    //
                    // Cheap to log, and the alternative is diagnosing a silent
                    // channel — which is what cost us a day on the sealed
                    // machine. Instrument before theorising.
                    val d = bean.dataByte
                    Log.i(
                        TAG,
                        "FRAME cmd=0x%02X".format(bean.cmd) +
                            " data=${bean.data}" +
                            " bytes=${d?.joinToString(" ") { b -> "%02X".format(b) } ?: "<null>"}" +
                            " len=${d?.size ?: 0}",
                    )
                    emit("resp cmd=${bean.cmd}", null)
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "response parse error: ${t.message}")
            emit("resp parse error cmd=${bean.cmd}: ${t.message}", null)
        }
    }

    private fun emit(event: String, door: DoorState?) {
        seq += 1
        _status.value = _status.value.copy(
            lastEvent = event,
            lastDoorState = door ?: _status.value.lastDoorState,
            eventSeq = seq,
        )
        Log.i(TAG, event)
        onLog(event)
    }

    companion object {
        private const val TAG = "MotorFridgeHW"

        /**
         * Blanks one digit on an LED price tag. Deduced from the SDK: its own
         * builder puts 0x11 in the leading slot when the formatted price only
         * needs three digits (the "2.99" case), so 0x11 is the tag's "off".
         */
        private const val BLANK_DIGIT: Byte = 0x11

        /**
         * *** INFERRED, NOT OBSERVED. Both are the "mode" slot of a five-arg
         * EnergyInstruct call, read by analogy with ctlTemp where 1 = write and
         * 0 = read. Nothing on this hardware has confirmed either.
         *
         * They are named constants rather than literals precisely so the bench
         * run that establishes the truth changes one line each, and so a reader
         * cannot mistake an inference for a fact. If the lights do not respond,
         * these are the first two numbers to sweep — one at a time.
         */
        private const val LED_MODE_WRITE = 1
        private const val DEFROST_MODE_WRITE = 1
    }
}
