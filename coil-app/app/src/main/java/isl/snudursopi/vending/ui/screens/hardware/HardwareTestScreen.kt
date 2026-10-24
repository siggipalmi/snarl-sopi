package isl.snudursopi.vending.ui.screens.hardware

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.vending.hardware.HardwareController
import isl.snudursopi.vending.hardware.WeimiHardwareController
import isl.snudursopi.vending.ui.theme.AppColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import isl.snudursopi.vending.ui.theme.AppFonts

/**
 * Debug-only screen for driving the Weimi hardware SDK by hand, following
 * the safe test sequence in hardware-testing-prep.md:
 *
 *   1. configure port + baud, start serial
 *   2. read board version (proves comms — zero risk)
 *   3. query a channel's status (does the slot exist)
 *   4. dispense a slot (turns a coil — costs one item)
 *   5. query the drop sensor (did something fall)
 *
 * Payment is intentionally NOT here. We confirm the Nayax topology
 * (Step 0) before writing any payment calls. Every SDK reply is shown
 * raw in the event log so we can read protocol responses live.
 *
 * Gated behind BuildConfig.DEBUG at the call site — never in a release.
 */
@Composable
fun HardwareTestScreen(
    onExit: () -> Unit,
    directPushRows: String = "",
    onSaveDirectPushRows: (String) -> Unit = {},
    dropSensorOverride: String = "",
    onSaveDropSensorOverride: (String) -> Unit = {},
) {
    val context = LocalContext.current

    var portPath by remember { mutableStateOf("/dev/ttyS1") }
    var baudText by remember { mutableStateOf("9600") }
    // Second port for the Marshall/VMC stack (ttyS3). When set, opened
    // alongside the motor port so the SDK service runs Marshall on it.
    var nayaxPortPath by remember { mutableStateOf("/dev/ttyS3") }
    var nayaxBaudText by remember { mutableStateOf("115200") }
    var openBothPorts by remember { mutableStateOf(true) }
    var addressText by remember { mutableStateOf("0") }
    var slotText by remember { mutableStateOf("1") }
    // Empty = don't pass channelType at all (SDK default, what spirals use).
    // Set it to sweep values on a direct-push lane.
    var channelTypeText by remember { mutableStateOf("") }
    var directPushText by remember { mutableStateOf(directPushRows) }
    var directPushSaved by remember { mutableStateOf(false) }
    var dropOverride by remember { mutableStateOf(dropSensorOverride) }
    // Nayax experimental fields — raw SDK params, meanings unconfirmed
    var nyArg3 by remember { mutableStateOf("0") }
    var nyAmount by remember { mutableStateOf("100") }
    var nyOrder by remember { mutableStateOf("TEST0001") }
    var nyArg6 by remember { mutableStateOf("0") }

    // Marshall SDK probe (the real Nayax Java SDK as our own host)
    val marshallLog = remember { mutableStateListOf<String>() }
    // Thread-safe logger: the SDK logs from its OWN background thread, motor
    // callbacks + the dispense thread also log. Mutating the Compose
    // SnapshotStateList from multiple threads races (size check vs removeAt) and
    // crashes with IndexOutOfBounds. Route ALL log writes onto the main thread.
    val mainHandler = remember { android.os.Handler(android.os.Looper.getMainLooper()) }
    val hwScope = rememberCoroutineScope()
    val logLine: (String) -> Unit = remember {
        { line ->
            mainHandler.post {
                marshallLog.add(0, line)
                while (marshallLog.size > 40) marshallLog.removeAt(marshallLog.size - 1)
            }
        }
    }
    var marshallProbe by remember { mutableStateOf<isl.snudursopi.vending.hardware.nayax.MarshallProbe?>(null) }

    // Stage 1: charge-only payment test (no dispense)
    var payController by remember { mutableStateOf<isl.snudursopi.vending.hardware.nayax.MarshallPaymentController?>(null) }
    var payAmountText by remember { mutableStateOf("50") }
    // Stage 2: dispense coupling — a motor controller on ttyS1 + slot to dispense
    var stage2Motor by remember { mutableStateOf<WeimiHardwareController?>(null) }
    var stage2Slot by remember { mutableStateOf("1") }
    // Stage 3a: multi-vend partial settlement — 3 items (2 good + 1 dead slot)
    var mvSlotA by remember { mutableStateOf("8") }
    var mvSlotB by remember { mutableStateOf("8") }
    var mvSlotC by remember { mutableStateOf("99") }
    var mvPrice by remember { mutableStateOf("10") }

    // The controller is created when serial is started, so the port/baud
    // fields are honored. Held in state so the same instance persists.
    var controller by remember { mutableStateOf<HardwareController?>(null) }
    val status = controller?.status?.collectAsState()

    // Make sure we close the serial port when leaving the screen.
    DisposableEffect(controller) {
        onDispose { controller?.stop() }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AppColors.Cream)
            .imePadding(),
    ) {
        // Simple header (no StatusBar — this is an internal tool)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "vélbúnaðarpróf",
                fontFamily = AppFonts.Cormorant,
                fontWeight = FontWeight.Medium,
                fontSize = 28.sp,
                color = AppColors.Ink,
            )
            Box(
                modifier = Modifier
                    .border(0.5.dp, AppColors.MutedSoft, RoundedCornerShape(20.dp))
                    .clickable(onClick = onExit)
                    .padding(horizontal = 18.dp, vertical = 8.dp),
            ) {
                Text("loka", fontFamily = AppFonts.Geist, fontSize = 13.sp, color = AppColors.MutedSoft)
            }
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp),
        ) {
            // ---- connection config ----
            SectionLabel("tenging")
            LabeledField("port (mótor)", portPath, { portPath = it }, KeyboardType.Text)
            LabeledField("baud", baudText, { baudText = it }, KeyboardType.Number)

            // Second port: the Marshall/VMC (Nayax) link. The cold-launch log
            // showed the SDK service opens ttyS3 itself and runs Marshall when
            // it's in the config. Toggle to include it.
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "opna líka nayax port (marshall)",
                    fontFamily = AppFonts.Geist,
                    fontSize = 13.sp,
                    color = AppColors.Ink,
                )
                Switch(checked = openBothPorts, onCheckedChange = { openBothPorts = it })
            }
            if (openBothPorts) {
                LabeledField("nayax port", nayaxPortPath, { nayaxPortPath = it }, KeyboardType.Text)
                LabeledField("nayax baud", nayaxBaudText, { nayaxBaudText = it }, KeyboardType.Number)
            }

            val isStarted = status?.value?.started == true
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TestButton(
                    label = if (isStarted) "endurræsa" else "opna port",
                    primary = true,
                    modifier = Modifier.weight(1f),
                ) {
                    controller?.stop()
                    val baud = baudText.toIntOrNull() ?: 9600
                    val c = if (openBothPorts) {
                        WeimiHardwareController(
                            context.applicationContext, portPath, baud,
                            nayaxPortPath = nayaxPortPath,
                            nayaxBaud = nayaxBaudText.toIntOrNull() ?: 115200,
                        )
                    } else {
                        WeimiHardwareController(context.applicationContext, portPath, baud)
                    }
                    controller = c
                    c.start { /* result surfaced via status.lastEvent */ }
                }
                TestButton(
                    label = "loka porti",
                    primary = false,
                    enabled = isStarted,
                    modifier = Modifier.weight(1f),
                ) {
                    controller?.stop()
                }
            }

            Spacer(Modifier.height(20.dp))

            // ---- safe sequence ----
            SectionLabel("prófun · örugg röð")

            TestButton(
                label = "1 · lesa útgáfu (sannar tengingu)",
                primary = false,
                enabled = isStarted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                controller?.readBoardVersion(addressText.toIntOrNull() ?: 0)
            }
            Spacer(Modifier.height(6.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                LabeledFieldCompact("addr", addressText, { addressText = it }, Modifier.weight(1f))
                LabeledFieldCompact("slot", slotText, { slotText = it }, Modifier.weight(1f))
                LabeledFieldCompact("chType", channelTypeText, { channelTypeText = it }, Modifier.weight(1f))
            }
            Spacer(Modifier.height(6.dp))

            TestButton(
                label = "2 · skammta hólf (snýr spírali)",
                primary = true,
                enabled = isStarted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                controller?.dispense(
                    addressText.toIntOrNull() ?: 0,
                    slotText.toIntOrNull() ?: 1,
                    channelTypeText.trim().toIntOrNull(),
                )
            }
            Spacer(Modifier.height(6.dp))

            LabeledFieldCompact(
                "beinar raðir (t.d. 5,6)",
                directPushText,
                { directPushText = it; directPushSaved = false },
                Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(6.dp))
            TestButton(
                label = if (directPushSaved) "vistað ✓" else "vista beinar raðir",
                primary = false,
                enabled = true,
                modifier = Modifier.fillMaxWidth(),
            ) {
                // Rows listed here are direct-push. On those rows a 0x05
                // ("turned <1 turn") means the pusher delivered, so the charge
                // is captured. On every other row 0x05 stays a failure.
                onSaveDirectPushRows(directPushText)
                directPushSaved = true
                logLine("direct-push rows saved: $directPushText")
            }
            Spacer(Modifier.height(6.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TestButton(
                    label = "goBack hólf",
                    primary = false,
                    enabled = isStarted,
                    modifier = Modifier.weight(1f),
                ) {
                    (controller as? WeimiHardwareController)?.goBackShipment(
                        addressText.toIntOrNull() ?: 0,
                        slotText.toIntOrNull() ?: 1,
                    )
                }
                TestButton(
                    label = "goBack röð",
                    primary = false,
                    enabled = isStarted,
                    modifier = Modifier.weight(1f),
                ) {
                    // "layer" here is the row number, not a raw slot.
                    (controller as? WeimiHardwareController)?.goBackLayerShipment(
                        addressText.toIntOrNull() ?: 0,
                        channelTypeText.trim().toIntOrNull() ?: 5,
                    )
                }
            }
            Spacer(Modifier.height(6.dp))

            TestButton(
                label = "spyrja borðið: allar rásir",
                primary = false,
                enabled = isStarted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                // Ask the board to enumerate every channel it knows about. This
                // is the authority on numbering: if the bottom layers appear
                // under different channel numbers than our (row-1)*10+(9-col)
                // arithmetic produces, that is why slot 58 reads as an open
                // circuit while the Weimi app vends the same lane happily.
                hwScope.launch(Dispatchers.IO) {
                    val motor = controller as? WeimiHardwareController
                    if (motor == null) {
                        logLine("no motor controller")
                        return@launch
                    }
                    val frames = motor.queryAllChannelStatusBlocking(
                        address = addressText.toIntOrNull() ?: 0,
                        windowMs = 4000,
                    )
                    logLine("channel frames: ${frames.size}")
                    frames.forEach { logLine(it) }
                }
            }
            Spacer(Modifier.height(6.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TestButton(
                    label = if (dropOverride == "on") "skynjari á ✓" else "skynjari á",
                    primary = false,
                    enabled = isStarted,
                    modifier = Modifier.weight(1f),
                ) {
                    // Persist as well as apply. Config re-sends its own value on
                    // every poll, so without the stored override the sensor is
                    // switched back off within about two minutes.
                    controller?.setInfraredState(true, addressText.toIntOrNull() ?: 0)
                    onSaveDropSensorOverride("on")
                    dropOverride = "on"
                    logLine("drop sensor ON saved as local override")
                }
                TestButton(
                    label = if (dropOverride == "off") "skynjari af ✓" else "skynjari af",
                    primary = false,
                    enabled = isStarted,
                    modifier = Modifier.weight(1f),
                ) {
                    controller?.setInfraredState(false, addressText.toIntOrNull() ?: 0)
                    onSaveDropSensorOverride("off")
                    dropOverride = "off"
                    logLine("drop sensor OFF saved as local override")
                }
            }
            Spacer(Modifier.height(6.dp))

            TestButton(
                label = "3 · lesa skynjara (datt eitthvað?)",
                primary = false,
                enabled = isStarted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                controller?.queryDropSensor(addressText.toIntOrNull() ?: 0)
            }

            Spacer(Modifier.height(20.dp))

            // ---- EXPERIMENTAL: Nayax via Weimi SDK ----
            SectionLabel("marshall sdk · beintenging (raunprófun)")
            Text(
                text = "keyrir alvöru nayax marshall sdk sem hýsil. lokaðu posa-forriti fyrst. " +
                    "smelltu á start og fylgstu með hvort 'onReady' birtist (þá hreinsast V00).",
                fontFamily = AppFonts.Cormorant,
                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                fontSize = 13.sp,
                color = AppColors.MutedSoft,
                modifier = Modifier.padding(bottom = 10.dp),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TestButton(
                    label = "▶ start marshall sdk",
                    primary = true,
                    modifier = Modifier.weight(1f),
                ) {
                    marshallProbe?.stop()
                    marshallLog.clear()
                    val probe = isl.snudursopi.vending.hardware.nayax.MarshallProbe(
                        portPath = nayaxPortPath,
                        baud = nayaxBaudText.toIntOrNull() ?: 115200,
                        log = { line ->
                            logLine(line)
                        },
                    )
                    marshallProbe = probe
                    probe.start()
                }
                TestButton(
                    label = "■ stop",
                    primary = false,
                    modifier = Modifier.weight(1f),
                ) {
                    marshallProbe?.stop()
                }
            }
            if (marshallLog.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(AppColors.CreamShadow, RoundedCornerShape(10.dp))
                        .padding(12.dp),
                ) {
                    marshallLog.forEach { line ->
                        Text(
                            text = line,
                            fontFamily = AppFonts.Geist,
                            fontSize = 12.sp,
                            color = AppColors.Ink,
                            modifier = Modifier.padding(vertical = 1.dp),
                        )
                    }
                }
            }
            Spacer(Modifier.height(20.dp))

            SectionLabel("marshall sdk · greiðsluprófun (STIG 1 — engin skömmtun)")
            Text(
                text = "hleður kort en SKAMMTAR EKKI vöru. notar lágt verð. " +
                    "connect fyrst (bíð eftir onReady), svo charge og leggðu kort á posann.",
                fontFamily = AppFonts.Cormorant,
                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                fontSize = 13.sp,
                color = AppColors.MutedSoft,
                modifier = Modifier.padding(bottom = 10.dp),
            )
            LabeledField("upphæð (kr)", payAmountText, { payAmountText = it }, KeyboardType.Number)
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TestButton(
                    label = "1 · connect",
                    primary = true,
                    modifier = Modifier.weight(1f),
                ) {
                    payController?.disconnect()
                    marshallLog.clear()
                    val pc = isl.snudursopi.vending.hardware.nayax.MarshallPaymentController(
                        portPath = nayaxPortPath,
                        baud = nayaxBaudText.toIntOrNull() ?: 115200,
                        log = { line ->
                            logLine(line)
                        },
                    )
                    payController = pc
                    pc.connect()
                }
                TestButton(
                    label = "2 · charge",
                    primary = true,
                    modifier = Modifier.weight(1f),
                ) {
                    payController?.charge(payAmountText.toIntOrNull() ?: 50) { result ->
                        logLine("RESULT: $result")
                    }
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TestButton(
                    label = "hætta við",
                    primary = false,
                    modifier = Modifier.weight(1f),
                ) { payController?.cancel() }
                TestButton(
                    label = "aftengja",
                    primary = false,
                    modifier = Modifier.weight(1f),
                ) { payController?.disconnect() }
            }
            Spacer(Modifier.height(20.dp))

            SectionLabel("marshall sdk · STIG 2 — greiðsla + skömmtun (báðir portar)")
            Text(
                text = "opnar mótor (ttyS1) OG marshall (ttyS3) samtímis. við samþykkt greiðslu " +
                    "skammtar hólf; mótor snýst → true (rukkað), annars false (endurgreitt). " +
                    "PRÓFAR alvöru kort OG alvöru vöru.",
                fontFamily = AppFonts.Cormorant,
                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                fontSize = 13.sp,
                color = AppColors.MutedSoft,
                modifier = Modifier.padding(bottom = 10.dp),
            )
            LabeledField("hólf (slot)", stage2Slot, { stage2Slot = it }, KeyboardType.Number)
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TestButton(
                    label = "1 · opna báða + connect",
                    primary = true,
                    modifier = Modifier.weight(1f),
                ) {
                    // open motor controller on ttyS1
                    stage2Motor?.stop()
                    val motor = WeimiHardwareController(context.applicationContext, "/dev/ttyS1", 9600)
                    stage2Motor = motor
                    motor.start { ok -> logLine("motor ttyS1 open=$ok") }
                    // connect marshall on ttyS3
                    payController?.disconnect()
                    val pc = isl.snudursopi.vending.hardware.nayax.MarshallPaymentController(
                        portPath = nayaxPortPath,
                        baud = nayaxBaudText.toIntOrNull() ?: 115200,
                        log = { line ->
                            logLine(line)
                        },
                    )
                    // couple dispense: on approval, dispense the slot and judge motor axis
                    pc.onApprovedDispense = { _ ->
                        val slot = stage2Slot.toIntOrNull() ?: 1
                        val res = motor.dispenseBlocking(
                            address = 0,
                            slot = slot,
                            timeoutMs = 8000,
                            channelType = channelTypeText.trim().toIntOrNull(),
                        )
                        logLine("dispense outcome=${res.outcome} (${res.detail})")
                        // CAPTURE ONLY on confirmed motor success (VENDED).
                        // Everything else — MOTOR_FAILED, NO_RESPONSE (timeout),
                        // ORDER_REJECTED, UNKNOWN — VOIDS the charge. Never charge
                        // without a confirmed motor turn.
                        res.outcome == isl.snudursopi.vending.hardware.DispenseResult.Outcome.VENDED
                    }
                    payController = pc
                    pc.connect()
                }
                TestButton(
                    label = "2 · charge + dispense",
                    primary = true,
                    modifier = Modifier.weight(1f),
                ) {
                    payController?.charge(payAmountText.toIntOrNull() ?: 50) { result ->
                        logLine("RESULT: $result")
                    }
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TestButton(
                    label = "aftengja báða",
                    primary = false,
                    modifier = Modifier.weight(1f),
                ) {
                    payController?.disconnect()
                    stage2Motor?.stop()
                }
            }
            Spacer(Modifier.height(20.dp))

            SectionLabel("marshall sdk · STIG 3a — fjölkaup + hlutgreiðsla")
            Text(
                text = "3 vörur (2 virk hólf + 1 dautt) á sama verði. posi sýnir HEILDINA, " +
                    "tappar einu sinni. skammtar hvert; rukkar AÐEINS það sem skilaði sér. " +
                    "vænting: 2×verð rukkað, ekki 3×.",
                fontFamily = AppFonts.Cormorant,
                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                fontSize = 13.sp,
                color = AppColors.MutedSoft,
                modifier = Modifier.padding(bottom = 10.dp),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(Modifier.weight(1f)) { LabeledField("hólf A", mvSlotA, { mvSlotA = it }, KeyboardType.Number) }
                Box(Modifier.weight(1f)) { LabeledField("hólf B", mvSlotB, { mvSlotB = it }, KeyboardType.Number) }
                Box(Modifier.weight(1f)) { LabeledField("hólf C (dautt)", mvSlotC, { mvSlotC = it }, KeyboardType.Number) }
            }
            LabeledField("verð á vöru (kr)", mvPrice, { mvPrice = it }, KeyboardType.Number)
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TestButton(
                    label = "1 · opna báða + connect",
                    primary = true,
                    modifier = Modifier.weight(1f),
                ) {
                    stage2Motor?.stop()
                    val motor = WeimiHardwareController(context.applicationContext, "/dev/ttyS1", 9600)
                    stage2Motor = motor
                    motor.start { ok -> logLine("motor ttyS1 open=$ok") }
                    payController?.disconnect()
                    val pc = isl.snudursopi.vending.hardware.nayax.MarshallPaymentController(
                        portPath = nayaxPortPath,
                        baud = nayaxBaudText.toIntOrNull() ?: 115200,
                        log = { line ->
                            logLine(line)
                        },
                    )
                    // per-item dispense: motor turns → true (counts toward capture)
                    pc.onDispenseItem = { item ->
                        val res = motor.dispenseBlocking(address = 0, slot = item.slot, timeoutMs = 8000)
                        logLine("  slot ${item.slot}: ${res.outcome}")
                        res.outcome == isl.snudursopi.vending.hardware.DispenseResult.Outcome.VENDED
                    }
                    payController = pc
                    pc.connect()
                }
                TestButton(
                    label = "2 · fjölkaup",
                    primary = true,
                    modifier = Modifier.weight(1f),
                ) {
                    val price = mvPrice.toIntOrNull() ?: 10
                    val items = listOf(
                        isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Item(
                            code = 0, slot = mvSlotA.toIntOrNull() ?: 1, priceIsk = price),
                        isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Item(
                            code = 1, slot = mvSlotB.toIntOrNull() ?: 1, priceIsk = price),
                        isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Item(
                            code = 2, slot = mvSlotC.toIntOrNull() ?: 99, priceIsk = price),
                    )
                    payController?.chargeBasket(items) { result ->
                        logLine("RESULT: $result")
                    }
                }
            }
            Spacer(Modifier.height(20.dp))

            SectionLabel("tilraun · nayax gegnum sdk")
            Text(
                text = "óstaðfest: SDK skjölun vantar fyrir nayax. prófaðu með " +
                    "lágri upphæð, posa-forrit lokað. fylgstu með hvort posinn vaknar.",
                fontFamily = AppFonts.Cormorant,
                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                fontSize = 13.sp,
                color = AppColors.MutedSoft,
                modifier = Modifier.padding(bottom = 10.dp),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                LabeledFieldCompact("arg3", nyArg3, { nyArg3 = it }, Modifier.weight(1f))
                LabeledFieldCompact("amount", nyAmount, { nyAmount = it }, Modifier.weight(1f))
                LabeledFieldCompact("arg6", nyArg6, { nyArg6 = it }, Modifier.weight(1f))
            }
            Spacer(Modifier.height(6.dp))
            LabeledField("orderId", nyOrder, { nyOrder = it }, KeyboardType.Text)
            Spacer(Modifier.height(6.dp))

            TestButton(
                label = "senda verð á posa (sendPrice)",
                primary = true,
                enabled = isStarted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                controller?.sendNayaxPriceRaw(
                    address = addressText.toIntOrNull() ?: 0,
                    slot = slotText.toIntOrNull() ?: 1,
                    arg3 = nyArg3.toIntOrNull() ?: 0,
                    amount = nyAmount.toLongOrNull() ?: 0L,
                    orderId = nyOrder,
                    arg6 = nyArg6.toIntOrNull() ?: 0,
                )
            }
            Spacer(Modifier.height(6.dp))
            TestButton(
                label = "hætta við (cancelPrice)",
                primary = false,
                enabled = isStarted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                controller?.cancelNayaxPriceRaw(
                    address = addressText.toIntOrNull() ?: 0,
                    amount = nyAmount.toLongOrNull() ?: 0L,
                    orderId = nyOrder,
                    arg4 = nyArg6.toIntOrNull() ?: 0,
                )
            }
            Spacer(Modifier.height(6.dp))

            // --- keep-alive experiment (the V00 test) ---
            Text(
                text = "lyklaprófun: heldur posanum lifandi? (V00). str = nota /dev/ttyS3.",
                fontFamily = AppFonts.Cormorant,
                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                fontSize = 13.sp,
                color = AppColors.MutedSoft,
                modifier = Modifier.padding(vertical = 6.dp),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                TestButton(
                    label = "▶ start keep-alive",
                    primary = true,
                    enabled = isStarted,
                    modifier = Modifier.weight(1f),
                ) {
                    controller?.startNayaxKeepAlive(
                        address = addressText.toIntOrNull() ?: 0,
                        str = nyOrder,
                        arg3 = nyArg3.toIntOrNull() ?: 0,
                        periodMs = 200L,
                    )
                }
                TestButton(
                    label = "■ stop",
                    primary = false,
                    enabled = isStarted,
                    modifier = Modifier.weight(1f),
                ) {
                    controller?.stopNayaxKeepAlive()
                }
            }
            Spacer(Modifier.height(6.dp))
            TestButton(
                label = "lesa kortastöðu (getCardMdbInfo)",
                primary = false,
                enabled = isStarted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                controller?.nayaxGetCardInfo(
                    address = addressText.toIntOrNull() ?: 0,
                    str = nyOrder,
                    arg3 = nyArg3.toIntOrNull() ?: 0,
                )
            }

            Spacer(Modifier.height(20.dp))

            // ---- energy / cooling board probe (read-only) ----
            SectionLabel("orkubretti · lestur (kæling)")
            Text(
                text = "óstaðfest: aðeins lestur. virkar bara ef vélin er með orkubretti " +
                    "(kæling). prófaðu á kældri vél.",
                fontFamily = AppFonts.Cormorant,
                fontStyle = androidx.compose.ui.text.font.FontStyle.Italic,
                fontSize = 13.sp,
                color = AppColors.MutedSoft,
                modifier = Modifier.padding(bottom = 10.dp),
            )
            TestButton(
                label = "lesa hitastig",
                primary = false,
                enabled = isStarted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                controller?.readTemperature(addressText.toIntOrNull() ?: 0)
            }
            Spacer(Modifier.height(6.dp))
            TestButton(
                label = "lesa orkunotkun (volt/amper)",
                primary = false,
                enabled = isStarted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                controller?.readPower(addressText.toIntOrNull() ?: 0)
            }
            Spacer(Modifier.height(6.dp))
            TestButton(
                label = "lesa stöðu orkubúnaðar",
                primary = false,
                enabled = isStarted,
                modifier = Modifier.fillMaxWidth(),
            ) {
                controller?.readEnergyStatus(addressText.toIntOrNull() ?: 0)
            }

            Spacer(Modifier.height(20.dp))

            // ---- live event log ----
            SectionLabel("svör frá borði")
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(AppColors.White, RoundedCornerShape(10.dp))
                    .border(0.5.dp, AppColors.Line, RoundedCornerShape(10.dp))
                    .padding(16.dp),
            ) {
                Text(
                    text = status?.value?.lastEvent ?: "(port ekki opnað)",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    color = AppColors.Ink,
                )
            }
            Spacer(Modifier.height(8.dp))
            Text(
                text = "athugið: nayax-hlutinn er tilraun. niðurstaðan segir okkur " +
                    "hvort greiðsla virkar gegnum sdk eða þarf aðra leið.",
                fontFamily = AppFonts.Cormorant,
                fontSize = 13.sp,
                color = AppColors.MutedSoft,
            )

            Spacer(Modifier.height(24.dp))
        }
    }
}

// ---- small components ----

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text.uppercase(),
        fontFamily = AppFonts.Geist,
        fontSize = 11.sp,
        letterSpacing = 1.5.sp,
        fontWeight = FontWeight.Medium,
        color = AppColors.MutedSoft,
        modifier = Modifier.padding(top = 4.dp, bottom = 10.dp),
    )
}

@Composable
private fun LabeledField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    keyboardType: KeyboardType,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
        Text(label, fontFamily = AppFonts.Geist, fontSize = 11.sp, color = AppColors.MutedSoft)
        Spacer(Modifier.height(4.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(AppColors.White, RoundedCornerShape(8.dp))
                .border(0.5.dp, AppColors.Line, RoundedCornerShape(8.dp))
                .padding(horizontal = 14.dp, vertical = 12.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onChange,
                singleLine = true,
                textStyle = TextStyle(
                    fontFamily = FontFamily.Monospace,
                    fontSize = 15.sp,
                    color = AppColors.Ink,
                ),
                keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun LabeledFieldCompact(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier) {
        Text(label, fontFamily = AppFonts.Geist, fontSize = 11.sp, color = AppColors.MutedSoft)
        Spacer(Modifier.height(4.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(AppColors.White, RoundedCornerShape(8.dp))
                .border(0.5.dp, AppColors.Line, RoundedCornerShape(8.dp))
                .padding(horizontal = 14.dp, vertical = 12.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onChange,
                singleLine = true,
                textStyle = TextStyle(
                    fontFamily = FontFamily.Monospace,
                    fontSize = 15.sp,
                    color = AppColors.Ink,
                ),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun TestButton(
    label: String,
    primary: Boolean,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val bg = when {
        !enabled -> AppColors.Clay
        primary -> AppColors.Ink
        else -> AppColors.Cream
    }
    val fg = when {
        !enabled -> AppColors.Cream
        primary -> AppColors.Cream
        else -> AppColors.Ink
    }
    Box(
        modifier = modifier
            .height(50.dp)
            .background(bg, RoundedCornerShape(25.dp))
            .then(
                if (!primary && enabled) Modifier.border(0.5.dp, AppColors.MutedSoft, RoundedCornerShape(25.dp))
                else Modifier
            )
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontFamily = AppFonts.Geist, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = fg)
    }
}
