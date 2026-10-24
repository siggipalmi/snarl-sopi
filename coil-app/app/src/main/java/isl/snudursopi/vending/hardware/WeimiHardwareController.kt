package isl.snudursopi.vending.hardware

import android.content.Context
import android.util.Log
import com.weimi.motorserial.MotorSerialPortKit
import com.weimi.motorserial.data.MotorInstructCode
import com.weimi.serialport.IStartKitCallback
import com.weimi.serialport.SerialportConfigBean
import com.weimi.serialport.bean.ReceiverBean
import com.weimi.serialport.callback.ISerialportResponseCallback
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Real hardware controller backed by the Weimi serial SDK.
 *
 * Wraps `MotorSerialPortKit` (the SDK's entry point) for the dispense
 * side. Payment is deliberately absent until the Nayax topology is
 * confirmed on real hardware.
 *
 * The SDK is callback-based: you fire an instruction (e.g. setShipments)
 * and the board's reply arrives later on [ISerialportResponseCallback].
 * We translate every reply into [HardwareStatus.lastEvent] so the debug
 * screen can show raw protocol responses while we learn them.
 *
 * Init sequence mirrors the SDK demo's MotorSerialCenter:
 *   initSerialPortKit() → startSerialPortKit(ctx, startCb, configArray, rxCb)
 * where each config is SerialportConfigBean(devicePath, baud, 0, 0).
 */
class WeimiHardwareController(
    private val appContext: Context,
    private val portPath: String,
    private val baud: Int,
    // Optional second port (the Nayax/Marshall link, ttyS3). When set, it's
    // included in the config array so the SDK's background service brings up
    // the VMC/Marshall stack on it — the way the stock Weimi app does. The
    // cold-launch log showed the service opens ttyS3 itself and runs
    // reset→config→Reader Enable→poll once ttyS3 is in the config.
    private val nayaxPortPath: String? = null,
    private val nayaxBaud: Int = 115200,
) : HardwareController {

    private val _status = MutableStateFlow(HardwareStatus(portPath = portPath, baud = baud))
    override val status: StateFlow<HardwareStatus> = _status.asStateFlow()

    @Volatile private var started = false
    @Volatile private var keepAliveThread: Thread? = null

    // ---- lifecycle ----

    override fun start(onResult: (Boolean) -> Unit) {
        if (started) {
            onResult(true)
            return
        }
        try {
            // Open both ports in one call if a Nayax port is configured, so the
            // SDK service runs the Marshall/VMC stack on ttyS3 alongside the
            // motor link on ttyS1 — matching the stock app's init.
            val configArray = if (nayaxPortPath != null) {
                emit("opening BOTH ports: motor=$portPath@$baud + nayax=$nayaxPortPath@$nayaxBaud")
                arrayOf(
                    SerialportConfigBean(portPath, baud, 0, 0),
                    SerialportConfigBean(nayaxPortPath, nayaxBaud, 0, 0),
                )
            } else {
                arrayOf(SerialportConfigBean(portPath, baud, 0, 0))
            }
            MotorSerialPortKit.initSerialPortKit()
            MotorSerialPortKit.startSerialPortKit(
                appContext,
                object : IStartKitCallback.Stub() {
                    override fun onRuntimeError(error: Int) {
                        emit("runtime error eventCode=$error")
                    }

                    override fun onStartKitResult(result: Int, p1: String) {
                        // Demo treats result == -1 or 1 as success (quirk of the SDK).
                        val ok = result == -1 || result == 1
                        started = ok
                        _status.update { it.copy(started = ok) }
                        emit("serial start result=$result port=$p1 → ${if (ok) "OK" else "FAIL"}")
                        onResult(ok)
                    }
                },
                configArray,
                receiverCallback,
            )
        } catch (t: Throwable) {
            Log.e(TAG, "start failed", t)
            emit("start threw: ${t.message}")
            onResult(false)
        }
    }

    override fun stop() {
        if (!started) return
        keepAliveActive = false
        keepAliveThread?.interrupt()
        keepAliveThread = null
        try {
            MotorSerialPortKit.stopSerialPortKit(appContext)
        } catch (t: Throwable) {
            Log.e(TAG, "stop failed", t)
        } finally {
            started = false
            _status.update { it.copy(started = false) }
            emit("serial stopped")
        }
    }

    // ---- instructions (dispense side only) ----

    override fun readBoardVersion(address: Int) {
        runInstruct("getVersion(addr=$address)") {
            MotorSerialPortKit.getMotorInstruct()?.getVersion(address)
        }
    }

    /**
     * Fire-and-forget dispense. [channelType] null = the SDK default (spiral).
     * See [dispenseBlocking] for why this parameter exists.
     */
    override fun dispense(address: Int, slot: Int, channelType: Int?) {
        val label = "setShipments(addr=$address, slot=$slot, " +
            "channelType=${channelType?.toString() ?: "<sdk default>"})"
        runInstruct(label) {
            val instruct = MotorSerialPortKit.getMotorInstruct()
            if (channelType == null) {
                instruct?.setShipments(address, slot, 0L)
            } else {
                instruct?.setShipments(
                    address = address,
                    channelNoId = slot,
                    orderId = 0L,
                    channelType = channelType,
                )
            }
        }
    }

    // ---- blocking dispense (for payment coupling) ----
    // onVendApproved (on the Marshall SDK thread) needs the motor result before
    // returning true/false to the terminal. This fires setShipments and waits
    // for the dispense ack (parsed in the receiver callback), with a timeout.

    private val dispenseLatch = java.util.concurrent.atomic.AtomicReference<java.util.concurrent.CountDownLatch?>()
    @Volatile private var lastDispenseForLatch: DispenseResult? = null
    private val tempLatch = java.util.concurrent.atomic.AtomicReference<java.util.concurrent.CountDownLatch?>()
    @Volatile private var lastTempForLatch: EnergyReading.Temperature? = null

    /**
     * Fire a dispense and BLOCK until the board acks (or [timeoutMs] elapses).
     * Returns the parsed [DispenseResult]. On timeout, outcome = UNKNOWN.
     * Must NOT be called on the main thread.
     */
    /**
     * @param channelType the SDK's `setShipments` channelType. NULL means "don't
     *   pass it" — the SDK default, which is what every spiral machine has always
     *   used. A direct-push lane may need a different value: the board reported
     *   0x01 (open circuit) for a lane that vends fine under the Weimi app, which
     *   points at the command rather than the wiring. The SDK exposes the
     *   parameter as a bare Int with no named constants, so the mapping has to be
     *   found empirically (or from Weimi) — hence exposing it rather than
     *   guessing a value here.
     */
    fun dispenseBlocking(
        address: Int,
        slot: Int,
        timeoutMs: Long = 8000,
        channelType: Int? = null,
    ): DispenseResult {
        val latch = java.util.concurrent.CountDownLatch(1)
        lastDispenseForLatch = null
        dispenseLatch.set(latch)
        try {
            emit(
                "dispenseBlocking: setShipments(addr=$address, slot=$slot" +
                    (channelType?.let { ", channelType=$it" } ?: ", channelType=<sdk default>") +
                    ") — waiting up to ${timeoutMs}ms",
            )
            val instruct = MotorSerialPortKit.getMotorInstruct()
            if (channelType == null) {
                instruct?.setShipments(address, slot, 0L)
            } else {
                instruct?.setShipments(
                    address = address,
                    channelNoId = slot,
                    orderId = 0L,
                    channelType = channelType,
                )
            }
            val acked = latch.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
            return if (acked) {
                lastDispenseForLatch ?: DispenseResult(
                    DispenseResult.Outcome.UNKNOWN, null, null, "ack latch released but no result",
                )
            } else {
                DispenseResult(
                    DispenseResult.Outcome.NO_RESPONSE, null, null,
                    "dispense timed out after ${timeoutMs}ms (no board ack)",
                )
            }
        } catch (t: Throwable) {
            emit("dispenseBlocking threw: ${t.message}")
            return DispenseResult(DispenseResult.Outcome.UNKNOWN, null, null, "threw: ${t.message}")
        } finally {
            dispenseLatch.set(null)
        }
    }

    // ---- alternative shipment commands (direct-push investigation) ----
    /**
     * The SDK exposes several shipment commands besides setShipments. We have
     * only ever used setShipments, which on this board runs a FIXED-LENGTH
     * stroke — fine when the product sits at the front of the tray, useless
     * when the next one is a centimetre back. The Weimi app drives the same
     * lanes correctly, so a command that does the right thing exists; these are
     * the candidates, exposed for testing rather than guessed at in the vend
     * path.
     */
    fun goBackShipment(address: Int, slot: Int, orderId: Long = 0L) {
        runInstruct("goBackShipment(addr=$address, slot=$slot)") {
            MotorSerialPortKit.getMotorInstruct()?.goBackShipment(address, slot, orderId)
        }
    }

    /** Whole-layer shipment — the shape a direct-push shelf is built in. */
    fun goBackLayerShipment(address: Int, layer: Int, orderId: Long = 0L) {
        runInstruct("goBackLayerShipment(addr=$address, layer=$layer)") {
            MotorSerialPortKit.getMotorInstruct()?.goBackLayerShipment(address, layer, orderId)
        }
    }

    override fun queryDropSensor(address: Int) {
        runInstruct("queryInfrared(addr=$address)") {
            MotorSerialPortKit.getMotorInstruct()?.queryInfrared(address)
        }
    }

    // ---- drop-sensor mode (board-level infrared on/off) ----
    /**
     * Turn the board's infrared drop sensor on or off. `false` stops fast-drop
     * faults on machines that don't want the sensor. SDK default params fill in
     * devicePath/delayTime. isOpen is sent as 1/0.
     */
    override fun setInfraredState(open: Boolean, address: Int) {
        runInstruct("setInfraredState(addr=$address, open=$open)") {
            MotorSerialPortKit.getMotorInstruct()?.setInfraredState(address, if (open) 1 else 0)
        }
    }

    // ---- channel-status query (blocking, collects raw frames) ----
    // Used by the backend command `query_channel_status`. We don't yet know the
    // exact reply shape, so we COLLECT every channel-status frame that arrives
    // in a short window and return the raw data strings verbatim.

    @Volatile private var collectingChannelStatus = false
    private val channelStatusFrames = java.util.concurrent.CopyOnWriteArrayList<String>()

    /**
     * Fire queryAllChannelStatus and collect raw reply frames for [windowMs].
     * Returns the raw data strings exactly as the board sent them. Must NOT be
     * called on the main thread (it blocks for the window).
     */
    fun queryAllChannelStatusBlocking(address: Int = 0, windowMs: Long = 2500): List<String> {
        channelStatusFrames.clear()
        collectingChannelStatus = true
        try {
            emit("queryAllChannelStatus(addr=$address) — collecting ${windowMs}ms")
            MotorSerialPortKit.getMotorInstruct()?.queryAllChannelStatus(address)
            Thread.sleep(windowMs)
        } catch (t: Throwable) {
            emit("queryAllChannelStatus threw: ${t.message}")
        } finally {
            collectingChannelStatus = false
        }
        return channelStatusFrames.toList()
    }

    override fun sendNayaxPriceRaw(
        address: Int,
        slot: Int,
        arg3: Int,
        amount: Long,
        orderId: String,
        arg6: Int,
    ) {
        runInstruct("NAYAX sendPrice(addr=$address, slot=$slot, arg3=$arg3, amount=$amount, order=$orderId, arg6=$arg6)") {
            MotorSerialPortKit.getNayaxInstruct()
                ?.sendPrice(address, slot, arg3, amount, orderId, arg6)
        }
    }

    override fun cancelNayaxPriceRaw(address: Int, amount: Long, orderId: String, arg4: Int) {
        runInstruct("NAYAX cancelPrice(addr=$address, amount=$amount, order=$orderId, arg4=$arg4)") {
            MotorSerialPortKit.getNayaxInstruct()
                ?.cancelPrice(address, amount, orderId, arg4)
        }
    }

    override fun nayaxGetCardInfo(address: Int, str: String, arg3: Int) {
        runInstruct("NAYAX getCardMdbInfo(addr=$address, str=$str, arg3=$arg3)") {
            MotorSerialPortKit.getNayaxInstruct()?.getCardMdbInfo(address, str, arg3)
        }
    }

    override fun nayaxResponseReadCard(address: Int, str: String, arg3: Int) {
        runInstruct("NAYAX responseReadCard(addr=$address, str=$str, arg3=$arg3)") {
            MotorSerialPortKit.getNayaxInstruct()?.responseReadCard(address, str, arg3)
        }
    }

    override fun nayaxResponseAgree(address: Int, amount: Long, str: String, arg4: Int) {
        runInstruct("NAYAX responseAgree(addr=$address, amount=$amount, str=$str, arg4=$arg4)") {
            MotorSerialPortKit.getNayaxInstruct()?.responseAgree(address, amount, str, arg4)
        }
    }

    override fun nayaxSendPriceEnd(address: Int, arg2: Int, arg3: Int, str: String, arg5: Int) {
        runInstruct("NAYAX sendPriceEnd(addr=$address, a2=$arg2, a3=$arg3, str=$str, a5=$arg5)") {
            MotorSerialPortKit.getNayaxInstruct()?.sendPriceEnd(address, arg2, arg3, str, arg5)
        }
    }

    override fun nayaxSendOutGoodResult(
        address: Int, arg2: Int, arg3: Int, amount: Long, str: String, arg6: Int,
    ) {
        runInstruct("NAYAX sendOutGoodResult(addr=$address, a2=$arg2, a3=$arg3, amount=$amount, str=$str, a6=$arg6)") {
            MotorSerialPortKit.getNayaxInstruct()
                ?.sendOutGoodResult(address, arg2, arg3, amount, str, arg6)
        }
    }

    // ---- keep-alive poller (the V00 experiment) ----

    @Volatile private var keepAliveActive = false

    override fun startNayaxKeepAlive(address: Int, str: String, arg3: Int, periodMs: Long) {
        if (keepAliveActive) {
            emit("keep-alive already running")
            return
        }
        keepAliveActive = true
        emit("▶ keep-alive START: getCardMdbInfo every ${periodMs}ms (addr=$address, str=$str)")
        keepAliveThread = Thread {
            var n = 0
            while (keepAliveActive) {
                try {
                    MotorSerialPortKit.getNayaxInstruct()?.getCardMdbInfo(address, str, arg3)
                    n++
                    if (n % 10 == 0) emit("keep-alive: $n polls sent")
                } catch (t: Throwable) {
                    emit("keep-alive poll threw: ${t.message}")
                }
                try {
                    Thread.sleep(periodMs)
                } catch (e: InterruptedException) {
                    break
                }
            }
            emit("■ keep-alive STOPPED after $n polls")
        }.also { it.isDaemon = true; it.start() }
    }

    override fun stopNayaxKeepAlive() {
        keepAliveActive = false
        keepAliveThread?.interrupt()
        keepAliveThread = null
    }

    // ---- energy / cooling board (read-only probe) ----

    override fun readTemperature(address: Int) {
        // ctlTemp(address, mode, temp): mode 0 = read, mode 1 = write.
        runInstruct("readTemperature(addr=$address)") {
            MotorSerialPortKit.getEnergyInstruct()?.ctlTemp(address, 0, 0)
        }
    }

    override fun readPower(address: Int) {
        runInstruct("readPower(addr=$address)") {
            MotorSerialPortKit.getEnergyInstruct()?.getEleInfo(address)
        }
    }

    override fun readEnergyStatus(address: Int) {
        runInstruct("readEnergyStatus(addr=$address)") {
            MotorSerialPortKit.getEnergyInstruct()?.getAllDeviceStatus(address)
        }
    }

    /**
     * Fire a temperature read and block until the board's CTL_TEMP reply is
     * decoded, or [timeoutMs] elapses. Returns the parsed reading, or null if
     * the port isn't started / no reply arrived. Reused by the Diagnostics
     * probe and (later) the periodic temperature reporter.
     */
    fun readTemperatureBlocking(address: Int = 0, timeoutMs: Long = 3000): EnergyReading.Temperature? {
        if (!started) return null
        val latch = java.util.concurrent.CountDownLatch(1)
        lastTempForLatch = null
        tempLatch.set(latch)
        try {
            readTemperature(address)
            latch.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (t: Throwable) {
            emit("readTemperatureBlocking threw: ${t.message}")
        } finally {
            tempLatch.set(null)
        }
        return lastTempForLatch
    }

    // ---- cooling control (writes — best-guess params, confirm on a machine) ----

    /**
     * Write the cooling setpoint. `ctlTemp` mode 1 = write; the setpoint is in
     * WHOLE degrees (confirmed live — a 40 write set the board to 40°C). Note
     * the read decodes current temp in tenths, but the setpoint write/read is
     * whole degrees.
     */
    fun setTemperature(address: Int, tempC: Double) {
        val whole = Math.round(tempC).toInt()
        runInstruct("setTemperature(addr=$address, ${tempC}°C → $whole)") {
            MotorSerialPortKit.getEnergyInstruct()?.ctlTemp(address, 1, whole)
        }
    }

    /**
     * Turn the compressor (cooling) on/off via `ctrlCompressor`. From the SDK
     * bytecode the data frame is [mode, 0, 18, value, 0, 0] — mode=1 (write) in
     * slot 0, the on/off VALUE in slot 3. (Earlier this put the flag in slot 0
     * and left slot 3 = 0, so it always sent OFF.)
     */
    fun setCompressor(address: Int, on: Boolean) {
        runInstruct("setCompressor(addr=$address, on=$on)") {
            MotorSerialPortKit.getEnergyInstruct()?.ctrlCompressor(address, 1, if (on) 1 else 0)
        }
    }

    /**
     * Trigger a defrost cycle via `ctrlDefrost`. Data frame [mode, 0, 5, value,
     * 0, 0] — mode=1 (write), value=1 (start), same slot convention as the
     * compressor command.
     */
    fun triggerDefrost(address: Int) {
        runInstruct("triggerDefrost(addr=$address)") {
            MotorSerialPortKit.getEnergyInstruct()?.ctrlDefrost(address, 1, 1)
        }
    }

    // ---- internals ----

    private inline fun runInstruct(label: String, block: () -> Unit) {
        if (!started) {
            emit("ignored [$label] — serial not started")
            return
        }
        try {
            emit("→ $label")
            block()
        } catch (t: Throwable) {
            Log.e(TAG, "instruct failed: $label", t)
            emit("✗ $label threw: ${t.message}")
        }
    }

    /**
     * Single receiver for all board replies. We don't fully decode every
     * response here — at this stage we surface the cmd + raw data so we
     * can read it live at the machine. Decoding gets refined once we know
     * what the real responses look like.
     */
    private val receiverCallback = object : ISerialportResponseCallback {
        override fun onResponse(protocolBean: ReceiverBean, devicePath: String) {
            val cmd = protocolBean.cmd
            val data = protocolBean.data

            // Dispense acks get fully decoded into an outcome on the
            // motor-mechanical axis (drop sensor is disabled fleet-wide,
            // so its readings are ignored — see DispenseResult).
            if (cmd == MotorInstructCode.INSTRUCT_SHIPMENTS) {
                val result = DispenseResult.parse(data)
                _status.update { it.copy(lastDispenseResult = result) }
                emit("← dispense: ${result.outcome} — ${result.detail}  [raw=$data]")
                // Release any blocking dispense waiter.
                lastDispenseForLatch = result
                dispenseLatch.get()?.countDown()
                return
            }

            // Energy/cooling board replies — decode to readable values.
            if (cmd == MotorInstructCode.INSTRUCT_CTL_TEMP) {
                val t = EnergyReading.parseTemperature(data)
                emit("← temperature: ${t.detail}  [raw=$data]")
                lastTempForLatch = t
                tempLatch.get()?.countDown()
                return
            }
            if (cmd == MotorInstructCode.INSTRUCT_GET_ELE_INFO) {
                val p = EnergyReading.parsePower(data)
                emit("← power: ${p.detail}  [raw=$data]")
                return
            }
            if (cmd == MotorInstructCode.INSTRUCT_GET_ALL_DEVICE_STATUS) {
                emit("← energy status: [raw=$data]")
                return
            }

            // Channel-status replies — collect raw frames when a
            // queryAllChannelStatusBlocking window is open.
            if (cmd == MotorInstructCode.INSTRUCT_INQUIRE_ALL_CHANNEL ||
                cmd == MotorInstructCode.INSTRUCT_INQUIRE_ONE_CHANNEL) {
                if (collectingChannelStatus && data != null) {
                    channelStatusFrames.add(data)
                }
                emit("← channel status: [raw=${data ?: "null"}]")
                return
            }

            val label = when (cmd) {
                MotorInstructCode.INSTRUCT_GET_VERSION -> "version reply"
                MotorInstructCode.INSTRUCT_INFRARED_CHECK -> "infrared/drop result"
                MotorInstructCode.INSTRUCT_INQUIRE_ONE_CHANNEL -> "channel status"
                MotorInstructCode.INSTRUCT_NAYAX_AGREE_PAY -> "NAYAX approved"
                MotorInstructCode.INSTRUCT_NAYAX_REFUSED -> "NAYAX declined"
                MotorInstructCode.INSTRUCT_NAYAX_READ_CARD -> "NAYAX card read"
                MotorInstructCode.INSTRUCT_NAYAX_SEND_PRICE -> "NAYAX price ack"
                MotorInstructCode.INSTRUCT_NAYAX_SEND_PRICE_END -> "NAYAX settle ack"
                MotorInstructCode.INSTRUCT_NAYAX_CANCEL -> "NAYAX cancel ack"
                MotorInstructCode.INSTRUCT_NAYAX_INFO -> "NAYAX card/status info"
                MotorInstructCode.INSTRUCT_NAYAX_END -> "NAYAX end"
                MotorInstructCode.INSTRUCT_NAYAX_OUT_GOOD_RESULT -> "NAYAX vend-result ack"
                MotorInstructCode.INSTRUCT_NAYAX_RUFUND_RESULT -> "NAYAX refund result"
                else -> "cmd=$cmd"
            }
            // Log EVERY reply with its raw data string — essential for protocol RE.
            emit("← $label  cmd=$cmd  raw=[${data ?: "null"}]")
        }
    }

    private fun emit(line: String) {
        Log.i(TAG, line)
        _status.update { it.copy(lastEvent = line, eventSeq = it.eventSeq + 1) }
    }

    companion object {
        private const val TAG = "WeimiHardware"
    }
}
