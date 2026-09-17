package isl.snudursopi.fridge

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import isl.snudursopi.fridge.domain.Basket
import isl.snudursopi.fridge.domain.Cabinet
import isl.snudursopi.fridge.domain.FridgeSpec
import isl.snudursopi.fridge.domain.Planogram
import isl.snudursopi.fridge.hardware.FakeFridgeHardware
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.pointer.pointerInput
import isl.snudursopi.fridge.hardware.MotorFridgeHardware
import isl.snudursopi.fridge.hardware.PriceTagSync
import isl.snudursopi.fridge.ui.state.isCustomerSession
import isl.snudursopi.fridge.update.OtaScheduler
import isl.snudursopi.fridge.update.UpdateResult
import isl.snudursopi.fridge.hardware.TtyPermissions
import isl.snudursopi.fridge.data.backend.FridgeBackend
import isl.snudursopi.fridge.data.FridgeIdentityStore
import isl.snudursopi.fridge.BuildConfig
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import java.time.Instant
import isl.snudursopi.fridge.hardware.nayax.FakePaymentGateway
import isl.snudursopi.fridge.hardware.nayax.NayaxLink
import isl.snudursopi.fridge.ui.screens.PaymentTestScreen
import isl.snudursopi.fridge.ui.screens.WeightTestScreen
import isl.snudursopi.fridge.ui.screens.FridgeFlowScreen
import isl.snudursopi.fridge.ui.state.FridgeViewModel
import isl.snudursopi.fridge.ui.state.FridgeViewModelFactory
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.SnudurSopiTheme
import androidx.core.view.WindowCompat
import android.content.Intent

/**
 * Runs the whole purchase flow against real hardware and real payment, or
 * against the fakes in the emulator, behind the same ViewModel.
 *
 * *** BuildConfig.DEBUG IS NOT A PRODUCTION GUARD ON THIS FLEET.
 *
 * This comment used to say the dev control strip "is compiled only into debug
 * and disappears in release", which was true of the mechanism and false of the
 * deployment: Device Owner binds to the `.debug` applicationId, so every field
 * machine runs the debug variant and every DEBUG-gated affordance was live in
 * front of customers. That cost us a dev strip on the complaint screen and,
 * until v0.39.2, a payment test harness one double-tap from the idle screen.
 *
 * Anything a customer must not reach is gated on [DevBarPrefs], a runtime
 * setting behind the admin PIN, defaulting to off. Add new debug affordances
 * the same way.
 */
class MainActivity : ComponentActivity() {

    // A small demo planogram so the fake flow has products + images to show.
    private val fakeHardware = FakeFridgeHardware(
        initialWeights = mapOf(1 to 510, 2 to 680, 3 to 240, 4 to 500)
    )

    /** Real weight/lock bus (ttyS3 @ 9600). */
    private val realHardware by lazy {
        MotorFridgeHardware(
            appContext = applicationContext,
            // Starting value only — corrected from the planogram's spec as soon
            // as it arrives. A double reports 32.
            trayCount = 16,
            onLog = { android.util.Log.i("WeightHW", it) },
        )
    }

    /** Real Nayax on ttyS4 — the ONE shared link (see NayaxLink). */
    private val realPayment get() = NayaxLink.payment

    /**
     * Planogram in, settlements out. Fail-soft by design: unprovisioned or
     * offline machines fall back to the cached planogram and queue their
     * settlements rather than refusing to sell.
     */
    private val backend by lazy { FridgeBackend(applicationContext) }

    /**
     * Periodic self-update. Gated on the UI phase so we never replace the app
     * mid-purchase, and on an un-metered network so we don't pull an APK over a
     * machine's SIM.
     */
    private val ota by lazy {
        OtaScheduler(
            appContext = applicationContext,
            isSessionActive = {
                viewModel.ui.value.phase != isl.snudursopi.fridge.ui.state.FridgePhase.IDLE
            },
        )
    }

    /**
     * Keeps the basket LED price tags in step with the planogram. Gated on the
     * UI phase so a tag write never competes with a live customer session for
     * the weight bus.
     */
    private val priceTags by lazy {
        PriceTagSync(
            hardware = realHardware,
            isSessionActive = {
                viewModel.ui.value.phase != isl.snudursopi.fridge.ui.state.FridgePhase.IDLE
            },
        )
    }

    private val viewModel: FridgeViewModel by viewModels {
        FridgeViewModelFactory(realHardware, realPayment) { backend.complaints.value }
    }

    /**
     * *** PROVISIONING MUST WORK ON A RUNNING APP.
     *
     * MainActivity is singleTask, so `am start ... --es deviceCode ...` against
     * an app that is already up does NOT re-run onCreate — Android routes the
     * intent here instead, and without this override the extras were silently
     * discarded. adb even says so, in a line easy to miss:
     * "Activity not started, intent has been delivered to currently running
     * top-most instance."
     *
     * That matters far beyond one bench machine. On a provisioned unit the
     * watchdog keeps the app running, so the fleet procedure would have
     * appeared to succeed on all 46 while doing nothing on any of them.
     */
    override fun onNewIntent(newIntent: Intent) {
        super.onNewIntent(newIntent)
        setIntent(newIntent)
        val dc = newIntent.getStringExtra("deviceCode")?.takeIf { it.isNotBlank() } ?: return
        val mk = newIntent.getStringExtra("machineKey")?.takeIf { it.isNotBlank() } ?: return
        lifecycleScope.launch { applyIntentIdentity(dc, mk) }
    }

    /**
     * Write a new identity and restart the backend against it.
     *
     * The restart is the point: clients, the config cache scope and the command
     * poller are all bound to the old deviceCode, so writing the store alone
     * would leave the machine authenticating as its previous identity until
     * something happened to restart it.
     */
    private suspend fun applyIntentIdentity(deviceCode: String, machineKey: String) {
        val store = FridgeIdentityStore(applicationContext)
        val previous = runCatching { store.deviceCode() }.getOrNull()
        runCatching { store.set(deviceCode, machineKey) }
        android.util.Log.i("FridgeBackend", "provisioned deviceCode=$deviceCode (intent)")
        if (previous != null && previous != deviceCode) {
            android.util.Log.w(
                "FridgeBackend",
                "identity changed $previous -> $deviceCode — restart the app to " +
                    "rebuild clients and drop the old machine's cached planogram",
            )
        }
    }

    override fun onResume() {
        super.onResume()
        Liveness.markAlive(applicationContext)
        // Re-assert lockdown every time we come forward: if anything ever
        // managed to surface over us, this pulls the machine back. No-op when
        // the unit isn't Device Owner, so dev tablets behave normally.
        // Not while an operator has deliberately left kiosk mode — otherwise
        // returning from Settings would slam the door behind them and the admin
        // escape would be useless.
        if (!KioskManager.suspendedByOperator) KioskManager.enableLockTask(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // *** LET COMPOSE SEE THE KEYBOARD.
        //
        // The manifest sets adjustResize, but on this board the window was not
        // shrinking for the soft keyboard — it simply slid over the complaint
        // form and buried the send button. Opting out of the framework's own
        // inset handling means the IME inset is dispatched to Compose instead,
        // where ComplaintForm's imePadding() can act on it. With the fix in
        // place the layout stays above the keyboard whether or not the resize
        // happens.
        //
        // Safe here specifically because these kiosk boards ship with no
        // navigation bar and no status bar: there are no system bars for the
        // content to slide under, so nothing else moves.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Say which build this is, first thing. With OTA in play, "which version
        // is actually on this machine" stops being obvious — and after a silent
        // install or an auto-revert the only witness is the log.
        android.util.Log.i(
            "FridgeBoot",
            "snarl-fridge ${BuildConfig.VERSION_NAME} (versionCode ${BuildConfig.VERSION_CODE})",
        )

        // FIRST, before anything touches the serial ports: reclaim them. The
        // ports are root-only and lose their permissions on every boot, so
        // realHardware (a `by lazy` realised via the viewModel just below) would
        // otherwise come up with a dead weight bus and refuse to open the door.
        // Bounded internally so a cold start can't stall here.
        val ttyOutcome = runCatching { TtyPermissions.ensureAccess() }.getOrNull()
        android.util.Log.i("FridgeBoot", "tty access: $ttyOutcome")

        // Self-healing nets. Watchdog is armed here as well as from
        // BootReceiver, because a plain app restart never sees a boot broadcast.
        Watchdog.schedule(applicationContext)
        Liveness.markAlive(applicationContext)

        // Demo planogram is only a bootstrap so the machine is usable before
        // the first config poll lands (or on an unprovisioned unit). The
        // backend overwrites it as soon as it has anything real.
        viewModel.setPlanogram(demoPlanogram())

        // Provisioning. Two sources, in priority order, both written BEFORE the
        // backend starts so the first poll already has credentials:
        //   1. adb intent extras (one-off override):
        //        adb shell am start -n isl.snudursopi.fridge.debug/isl.snudursopi.fridge.MainActivity \
        //            -e deviceCode <CODE> -e machineKey <KEY>
        //   2. BuildConfig from local.properties (TEST_MACHINE_DEVICE_CODE /
        //      TEST_MACHINE_KEY) — the coil app's pattern; keeps the secret out
        //      of shell history and out of git (local.properties is gitignored).
        // Intent extras win so a single machine can be re-pointed without a
        // rebuild. Only ever WRITES when both values are present, so a build
        // with empty BuildConfig fields never clobbers a good stored identity.
        lifecycleScope.launch {
            // *** PRECEDENCE: INTENT > STORED > BuildConfig. THE ORDER MATTERS.
            //
            // This used to be intent > BuildConfig, written unconditionally on
            // every launch — so a machine provisioned by intent reverted to the
            // build's baked-in identity the moment anything relaunched the app
            // without extras: the watchdog, a power cycle, a tap on the icon.
            //
            // Seen on machine #2 (2026-08-27): provisioned as 8626020716, ran
            // correctly as a 2-cabinet double, then a restart four minutes later
            // silently re-stamped it as 8626020618 and it loaded the hostel
            // machine's single-cabinet planogram. Two machines sharing one
            // identity, settlements landing against the wrong record, and
            // nothing on screen to say so.
            //
            // A STORED identity is the machine's own and must win over whatever
            // happened to be compiled in. BuildConfig is a first-run convenience
            // for a bench build, nothing more. The intent still overrides both,
            // deliberately, so a machine can be re-pointed without a rebuild.
            val store = FridgeIdentityStore(applicationContext)
            val intentDc = intent?.getStringExtra("deviceCode")?.takeIf { it.isNotBlank() }
            val intentMk = intent?.getStringExtra("machineKey")?.takeIf { it.isNotBlank() }

            if (intentDc != null && intentMk != null) {
                applyIntentIdentity(intentDc, intentMk)
            } else if (!runCatching { store.isProvisioned() }.getOrDefault(false)) {
                // Nothing stored yet — fall back to the build, if it carries one.
                val dc = BuildConfig.TEST_MACHINE_DEVICE_CODE.takeIf { it.isNotBlank() }
                val mk = BuildConfig.TEST_MACHINE_KEY.takeIf { it.isNotBlank() }
                if (dc != null && mk != null) {
                    runCatching { store.set(dc, mk) }
                    android.util.Log.i("FridgeBackend", "provisioned deviceCode=$dc (build)")
                }
            } else {
                val dc = runCatching { store.deviceCode() }.getOrNull()
                android.util.Log.i("FridgeBackend", "provisioned deviceCode=$dc (stored)")
            }
            backend.start(lifecycleScope)
        }

        // Diagnostics for the admin sheet: which machine this is, and when it
        // last actually reached the backend. Invisible until v0.47.1, which is
        // why a clock-skew outage looked like a healthy machine.
        lifecycleScope.launch {
            backend.provisionedAs.collect { viewModel.setDeviceCode(it) }
        }
        lifecycleScope.launch {
            backend.lastPollOkMs.collect { viewModel.setLastPollOk(it) }
        }

        lifecycleScope.launch {
            backend.planogram.collect { p ->
                if (p != null && p.baskets.isNotEmpty()) {
                    android.util.Log.i(
                        "FridgeBackend",
                        "planogram applied: ${p.baskets.size} baskets, " +
                            "${p.spec.cabinets.size} cabinet(s) [${p.spec.model}]",
                    )
                    // *** WIDEN THE WEIGHT POLL FOR A DOUBLE BEFORE ANYTHING
                    // ELSE USES IT. 16 trays per cabinet; a double is 32. Left
                    // at 16, cabinet B never reports a weight change and every
                    // item taken from it is free — with cabinet A behaving
                    // perfectly, so nothing looks broken.
                    // *** THE READ RANGE MUST SPAN THE ADDRESS BLOCKS, NOT THE
                    // BASKET COUNT. Cabinet B is addressed from 20, so a double
                    // reaches to tray 35 — asking for 32 would stop four short
                    // and miss cabinet B's last four baskets entirely.
                    val cabinets = p.spec.cabinets.size.coerceAtLeast(1)
                    // Apply the backend's payment port before anything uses the
                    // link, so a machine wired differently is corrected without
                    // a rebuild — and stays corrected across reinstalls.
                    // Cabinet count picks the default; an explicit config value
                    // still wins. Both may trigger a reconnect.
                    val nayax = isl.snudursopi.fridge.hardware.nayax.NayaxLink
                    val portChanged = if (p.paymentSerialPort != null) {
                        nayax.setPortPathExplicit(p.paymentSerialPort!!)
                    } else {
                        nayax.applyForCabinets(p.spec.cabinets.size)
                    }
                    if (portChanged) {
                        android.util.Log.w("MarshallPay", "payment port now ${nayax.portPath}")
                        lifecycleScope.launch {
                            runCatching {
                                realPayment.disconnect()
                                kotlinx.coroutines.delay(1_000)
                                realPayment.connect()
                            }
                        }
                    }
                    realHardware.setTrayCount(
                        (cabinets - 1) * Planogram.ADDRESS_BLOCK_PER_CABINET +
                            Planogram.BASKETS_PER_CABINET,
                    )
                    viewModel.setPlanogram(p)
                    // Machine-level language settings ride the planogram, so
                    // apply them here rather than plumbing a second channel.
                    viewModel.setLanguageOptions(p.defaultLanguage, p.availableLanguages)
                    // Bring the shelf-edge LED tags in line with the prices we
                    // just received. Launched separately because sync() can wait
                    // out a whole customer session — blocking the collector would
                    // hold up the NEXT planogram update behind it. Overlapping
                    // syncs are serialised by a mutex inside. A failure here must
                    // never disturb the purchase flow.
                    lifecycleScope.launch {
                        runCatching { priceTags.sync(p) }
                            .onFailure {
                                android.util.Log.w("PriceTagSync", "sync failed: ${it.message}")
                            }
                    }
                }
            }
        }

        // Every completed session goes to the backend. Never blocks the flow.
        viewModel.onSettlementReport = { event ->
            lifecycleScope.launch {
                backend.reportSettlement(
                    orderId = event.orderId,
                    startedAtIso = Instant.ofEpochMilli(event.startedAtMs).toString(),
                    closedAtIso = Instant.ofEpochMilli(event.closedAtMs).toString(),
                    planogramUsed = event.planogram,
                    cabinetsOpened = event.cabinetsOpened,
                    outcome = event.outcome,
                    nayaxRef = event.nayaxRef,
                    result = event.result,
                )
            }
        }

        ota.start(lifecycleScope)

        // Backend command queue: restock and remote scale control. The gates live
        // here because they belong to the view model — never act while a customer
        // is mid-purchase, and silence the weight poll before touching a scale.
        backend.startCommands(
            scope = lifecycleScope,
            hardware = realHardware,
            // Customer sessions only — a restock must NOT block commands, or a
            // stuck restock locks out the very commands that would recover it.
            isSessionActive = { viewModel.ui.value.phase.isCustomerSession },
            withBusQuiet = { block -> viewModel.withBusQuiet(block) },
            beginRestock = { cabinet -> viewModel.beginRestock(cabinet) },
            // Lets the backend say "check for an update now" — the only remote
            // trigger there is, since a locked-down machine can't be restarted
            // over adb.
            onCheckUpdate = { ota.checkOnce(manual = true).toString() },
            // force=true bypasses the lastPushed cache, which is what makes this
            // able to FIX a wrong tag rather than only report one.
            onSyncPriceTags = { force ->
                val plan = backend.planogram.value
                if (plan == null) "no planogram" else priceTags.sync(plan, force = force)
            },
            onProbeAddresses = {
                realHardware.probeAddresses()
                // ~18s of serial traffic: 32 queries at 300ms, plus the
                // board's own ~4.6s retry tail on any silent module. Wait it
                // out so the command result carries the answer, not "started".
                kotlinx.coroutines.delay(20_000)
                realHardware.lastProbeResult()
            },
            // *** RESTART FROM THE DASHBOARD. Schedules a relaunch, then kills
            // the process — the same proven path the admin sheet uses when it
            // leaves for Settings, so the machine always comes back.
            onRestartApp = { delayMs ->
                lifecycleScope.launch {
                    kotlinx.coroutines.delay(delayMs)
                    android.util.Log.w("FridgeBoot", "restart_app — relaunching in 2s")
                    scheduleAppRelaunch(applicationContext, 2_000L, RESTART_REQUEST_CODE)
                    finishAndRemoveTask()
                    kotlin.system.exitProcess(0)
                }
            },
            onSetPaymentPort = { path ->
                isl.snudursopi.fridge.hardware.nayax.NayaxLink.setPortPathExplicit(path)
                realPayment.disconnect()
                kotlinx.coroutines.delay(1_000)
                realPayment.connect()
                "payment port set to $path — reconnecting, watch for onReady"
            },
            onClearDeviceOwner = {
                KioskManager.clearDeviceOwner(applicationContext)
            },
            // *** REPORT FIRST, THEN REBOOT. The result is returned immediately
            // and the reboot fires a few seconds later, because this process
            // does not survive the reboot to post anything afterwards. Without
            // the delay the command sits pending forever and the dashboard
            // shows a dead machine at the exact moment someone is watching to
            // see whether it came back up.
            onRestartMachine = {
                lifecycleScope.launch {
                    kotlinx.coroutines.delay(5_000)
                    KioskManager.rebootDevice(applicationContext)
                }
                "rebooting the board in 5s"
            },
            onLaunchSupport = {
                val pm = packageManager
                val intent = pm.getLaunchIntentForPackage(TEAMVIEWER_QS_PKG)
                if (intent == null) {
                    "TeamViewer QuickSupport is not installed on this machine"
                } else {
                    KioskManager.disableLockTask(this@MainActivity)
                    scheduleAppRelaunch(applicationContext, SUPPORT_RETURN_MS, RESTART_REQUEST_CODE)
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { startActivity(intent) }
                    "QuickSupport opened — the operator must accept the session"
                }
            },
            onReadTemp = {
                realHardware.readTemperature()
                kotlinx.coroutines.delay(2_000)
                realHardware.cabinetTempC.value?.let { t ->
                    "cabinet %.1f C".format(t) +
                        (realHardware.setpointC.value?.let { ", setpoint $it C" } ?: "")
                }
            },
            telemetry = { client ->
                isl.snudursopi.fridge.data.backend.TelemetryLoop(
                    client = client,
                    readNow = { realHardware.readTemperature() },
                    currentTemp = { realHardware.cabinetTempC.value },
                    currentSetpoint = { realHardware.setpointC.value },
                    isSessionActive = {
                        viewModel.ui.value.phase != isl.snudursopi.fridge.ui.state.FridgePhase.IDLE
                    },
                )
            },
        )

        // Tell RecoveryGuard this build is sound once it has actually run for a
        // while. Until this fires, a restart counts as a failed boot and three of
        // those roll the machine back to the last known-good APK — so the delay is
        // the whole safety mechanism, not a formality.
        lifecycleScope.launch {
            kotlinx.coroutines.delay(HEALTHY_AFTER_MS)
            RecoveryGuard.confirmHealthy(application)
        }

        // keep a warm resting snapshot so a card tap unlocks instantly
        viewModel.startIdleWatch()

        // Bring the hardware up: weight bus, then the reader. A card tap is
        // what starts a purchase, so route it into the state machine.
        realHardware.start { ok -> android.util.Log.i("WeightHW", "weight bus start ok=$ok") }
        realPayment.onCardPresented = {
            runOnUiThread { viewModel.onCardTapped() }
        }
        realPayment.connect { android.util.Log.i("MarshallPay", "reader ready") }

        // Foreground heartbeat. The watchdog reads this: a stale stamp means the
        // app is dead OR wedged (a wedged app is invisible to crash recovery, so
        // the heartbeat is what catches it).
        lifecycleScope.launch {
            while (true) {
                Liveness.markAlive(applicationContext)
                kotlinx.coroutines.delay(HEARTBEAT_MS)
            }
        }

        setContent {

            SnudurSopiTheme {
                Surface(Modifier.fillMaxSize(), color = AppColors.Cream) {
                    val ui by viewModel.ui.collectAsState()
                    var showWeightTest by remember { mutableStateOf(false) }
                    // Last manual update-check result, shown in the DevBar. Without this the
                    // button looks broken: it's the only one with no on-screen effect.
                    var updateStatus by remember { mutableStateOf("") }
                    var showPaymentTest by remember { mutableStateOf(false) }

                    if (showPaymentTest) {
                        // Nayax bring-up on /dev/ttyS4 — separate bus from weights.
                        PaymentTestScreen { showPaymentTest = false }
                    } else if (showWeightTest) {
                        // Real weight hardware on /dev/ttyS3 — the on-machine instrument.
                        // Reuse the single shared controller — opening a second
                        // one on ttyS3 would hit the SDK's "already started"
                        // no-op and silently stop reads.
                        WeightTestScreen(realHardware) { showWeightTest = false }
                    } else {
                        Box(
                            Modifier
                                .fillMaxSize()
                                .pointerInput(Unit) {
                                    // *** CUSTOMER-REACHABLE UNTIL v0.39.2.
                                    //
                                    // Long-press opened the weight instrument
                                    // and double-tap the payment test harness,
                                    // anywhere on the screen. Gated on
                                    // BuildConfig.DEBUG, which is always true
                                    // in the field because Device Owner binds
                                    // to the .debug applicationId — so a guest
                                    // idly double-tapping the idle screen got a
                                    // payment test screen. Same root cause as
                                    // the dev bar.
                                    //
                                    // Now behind the same admin toggle: off by
                                    // default, enabled from the PIN sheet when
                                    // someone is actually servicing the machine.
                                    //
                                    // NOTE this is NOT the admin escape hatch.
                                    // That is the long-press on the clock in
                                    // AdminClock, it is the only way into
                                    // Settings on a panel with no navigation
                                    // bar, and it must never be gated behind
                                    // anything.
                                    detectTapGestures(
                                        onLongPress = {
                                            if (BuildConfig.DEBUG &&
                                                DevBarPrefs.isVisible(this@MainActivity)
                                            ) {
                                                showWeightTest = true
                                            }
                                        },
                                        onDoubleTap = {
                                            if (BuildConfig.DEBUG &&
                                                DevBarPrefs.isVisible(this@MainActivity)
                                            ) {
                                                showPaymentTest = true
                                            }
                                        },
                                    )
                                }
                        ) {
                            FridgeFlowScreen(
                                state = ui,
                                onCycleLanguage = { viewModel.cycleLanguage() },
                                onOpenInfo = { viewModel.setInfoOpen(true) },
                                onCloseInfo = { viewModel.setInfoOpen(false) },
                                onComplaintOpen = { viewModel.openComplaint() },
                                onComplaintToggleLine = { viewModel.toggleComplaintLine(it) },
                                onComplaintReason = { viewModel.setComplaintReason(it) },
                                onComplaintNote = { viewModel.setComplaintNote(it) },
                                onComplaintEmail = { viewModel.setComplaintEmail(it) },
                                onComplaintCancel = { viewModel.cancelComplaint() },
                                onComplaintSend = { viewModel.sendComplaint() },
                            )
                            // Runtime toggle, not BuildConfig.DEBUG: field
                            // machines run the debug variant because Device
                            // Owner is bound to the .debug applicationId, so
                            // the old guard showed the bar to customers.
                            if (BuildConfig.DEBUG && DevBarPrefs.isVisible(this@MainActivity)) {
                                DevBar(
                                    Modifier.align(Alignment.BottomCenter),
                                    onTap = { viewModel.onCardTapped() },
                                    onTake = {
                                        fakeHardware.take(basket = 1, unitWeightG = 170, count = 1)
                                    },
                                    onClose = { viewModel.onDoorClosed() },
                                    onWeightTest = { showWeightTest = true },
                                    onPaymentTest = { showPaymentTest = true },
                                    // Manual update check. Once a machine is
                                    // Device Owner + Lock Task, adb can't even
                                    // force-stop it, so without this there is no
                                    // way for a technician standing at a machine
                                    // to make it look for an update.
                                    updateStatus = updateStatus,
                                    onTempProbe = { realHardware.readTemperature() },
                                    onCheckUpdate = {
                                        updateStatus = "checking…"
                                        lifecycleScope.launch {
                                            val r = runCatching { ota.checkOnce(manual = true) }
                                                .getOrElse { UpdateResult.Error(it.message ?: "failed") }
                                            android.util.Log.i("OtaScheduler", "manual check: $r")
                                            updateStatus = r.toString()
                                        }
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    private fun demoPlanogram(): Planogram {
        val spec = FridgeSpec.fromModel("GR-WM22Z680")!!
        val baskets = listOf(
            Basket(Cabinet.A, 1, "L1", "p-skyr", "engjaþykkni", null, 329, 170, 15, 1, true),
            Basket(Cabinet.A, 2, "L1", "p-kok", "kók 330ml", null, 295, 330, 15, 1, true),
            Basket(Cabinet.A, 3, "L1", "p-bar", "prótín bar", null, 389, 60, 12, 1, true),
            Basket(Cabinet.A, 4, "L1", "p-vatn", "vatn 500ml", null, 250, 500, 15, 1, true),
        )
        return Planogram(spec, baskets)
    }
}

@androidx.compose.runtime.Composable
private fun DevBar(
    modifier: Modifier = Modifier,
    onTap: () -> Unit,
    onTake: () -> Unit,
    onClose: () -> Unit,
    onWeightTest: () -> Unit = {},
    onPaymentTest: () -> Unit = {},
    onCheckUpdate: () -> Unit = {},
    onTempProbe: () -> Unit = {},
    updateStatus: String = "",
) {
    Row(
        modifier
            .background(AppColors.Ink)
            .padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Button(onClick = onTap) { Text("tap card") }
        Button(onClick = onTempProbe) { Text("temp") }
        Button(onClick = onTake) { Text("take item") }
        Button(onClick = onClose) { Text("close door") }
        Button(onClick = onWeightTest) { Text("weights") }
        Button(onClick = onPaymentTest) { Text("payment") }
        Button(onClick = onCheckUpdate) { Text("update") }
        if (updateStatus.isNotBlank()) {
            Text(updateStatus, color = AppColors.Cream)
        }
    }
}

/**
 * How often the foreground app stamps its liveness. Comfortably inside the
 * watchdog's 3-minute stale threshold, so a healthy app is never mistaken for a
 * wedged one.
 */
private const val HEARTBEAT_MS = 30_000L

/**
 * How long a freshly-installed build must run before RecoveryGuard accepts it as
 * healthy. Matches the coil app's ~25s: long enough to have got through startup,
 * hardware bring-up and a first render, short enough that a genuinely healthy
 * build isn't left one restart away from being rolled back.
 */
private const val HEALTHY_AFTER_MS = 25_000L

/** Distinct from the Settings relaunch alarm so the two cannot cancel each other. */
private const val RESTART_REQUEST_CODE = 4711

/** QuickSupport's package, and how long the app waits before taking the screen back. */
private const val TEAMVIEWER_QS_PKG = "com.teamviewer.quicksupport.market"
private const val SUPPORT_RETURN_MS = 15L * 60L * 1000L
