package isl.snudursopi.fridge.ui.state

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import isl.snudursopi.fridge.domain.Planogram
import isl.snudursopi.fridge.domain.RestockTimer
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.domain.LanguageCycle
import isl.snudursopi.fridge.domain.Settlement
import isl.snudursopi.fridge.hardware.FridgeHardwareController
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import isl.snudursopi.fridge.data.backend.ComplaintClient
import isl.snudursopi.fridge.data.backend.ReceiptResult
import isl.snudursopi.fridge.data.backend.ComplaintLine
import isl.snudursopi.fridge.data.backend.ComplaintResult
import isl.snudursopi.fridge.domain.ComplaintReason
import kotlinx.coroutines.Job

/**
 * The fridge purchase-flow state machine. Deliberately small and readable —
 * it orchestrates three collaborators and owns the phase transitions:
 *
 *   payment (Nayax pre-auth -> capture)   hardware (lock + weight)   settlement
 *
 * The happy path:
 *   IDLE
 *    -> (card tapped) AUTHORIZING           createSession / pre-auth hold
 *    -> (approved) snapshot weights, refuse if sensor fault
 *    -> UNLOCKED                            openLock(each cabinet)
 *    -> SHOPPING                            poll weights for tentative cart
 *    -> (door closed) CALCULATING           median-of-3 read
 *    -> settle -> capture actual amount     sendPrice(lines) / closeSession
 *    -> RECEIPT (or NOTHING_TAKEN)          post settlement record
 *
 * This first cut runs against [FakeFridgeHardware] and a fake payment stub so
 * the whole flow is exercisable in the emulator. The real Nayax controller and
 * serial hardware slot in behind the same calls without touching this class.
 */
class FridgeViewModel(
    private val hardware: FridgeHardwareController,
    private val payment: PaymentGateway,
    private val settlementSink: (Settlement.Result) -> Unit = {},
    /**
     * *** A PROVIDER, NOT THE CLIENT ITSELF. The ViewModel is constructed at
     * startup, before the machine has read its deviceCode and key from the
     * identity store, so a snapshot taken here would be null forever and every
     * complaint would silently fail to send. Read it at send time instead.
     */
    private val complaintClient: () -> ComplaintClient? = { null },
    /** Same reasoning as [complaintClient]: read when sending, not at construction. */
    private val receiptClient: () -> isl.snudursopi.fridge.data.backend.ReceiptClient? = { null },
    /** Same again: the stock reporter exists only once the machine is provisioned. */
    private val stockClient: () -> isl.snudursopi.fridge.data.backend.StockClient? = { null },
) : ViewModel() {

    private val _ui = MutableStateFlow(FridgeUiState())
    val ui: StateFlow<FridgeUiState> = _ui.asStateFlow()

    private var planogram: Planogram = Planogram.EMPTY
    private var origWeights: Map<Int, Int> = emptyMap()
    private var orderId: String = ""
    private var sessionStartedAtMs: Long = 0L

    /**
     * Called once per completed session so the backend can record it. Set by
     * MainActivity; never invoked on the hot path in a way that can block the
     * customer, and the backend side is fail-soft (queues when offline).
     */
    var onSettlementReport: ((FridgeSettlementEvent) -> Unit)? = null

    fun setPlanogram(p: Planogram) {
        planogram = p
        setMachineSettings(p)
    }

    /**
     * The parts of a config that describe the machine rather than what it sells.
     * Applied on every config, stocked or not — a machine mid-setup has no
     * baskets yet but still needs its logo, posters and cabinet count.
     */
    fun setMachineSettings(p: Planogram) {
        // The idle animation draws a single or a double from this, so it must
        // follow the config rather than a build flag.
        _ui.value = _ui.value.copy(
            cabinetCount = p.spec.cabinets.size.coerceAtLeast(1),
            operatorName = p.operatorName,
            supportEmail = p.supportEmail,
            logoUrl = p.logoUrl,
            posters = p.posters,
            showPosters = p.showPosters,
            outOfService = p.outOfService,
            outOfServiceReason = p.outOfServiceReason,
            adminPin = p.adminPin,
            idleTimeoutSeconds = p.idleTimeoutSeconds,
            receiptsEnabled = p.receiptsEnabled,
        )
    }

    /** The admin sheet's PIN results, for the backend: 'ok', or 'lockout' after five wrong. */
    fun reportAdminPinEvent(type: String) {
        viewModelScope.launch { runCatching { stockClient()?.adminPinEvent(type) } }
    }

    /** Most recent resting weights, refreshed while the machine sits idle. */
    /** When the session's unlock went out, so door frames can be timed against it. */
    private var unlockedAt: Long = 0L

    private var idleWeights: Map<Int, Int> = emptyMap()

    /** When [idleWeights] was measured, and when the last customer session ended. */
    private var idleWeightsAtMs = 0L
    private var lastSessionEndedAtMs = 0L

    /** Last reading seen during shopping — the settled value for any basket
     *  that didn't move, so we don't pay 2.4s to re-read it. */
    private var lastPolled: Map<Int, Int> = emptyMap()

    /**
     * Poll slowly while idle so a card tap can unlock IMMEDIATELY instead of
     * waiting ~2.4s for a "before" snapshot. The card session expires while we
     * settle, so every second before the door opens is a second stolen from
     * the customer's shopping time.
     */
    /**
     * Advance to the next language the machine offers. Driven by the globe pill.
     */
    fun setInfoOpen(open: Boolean) {
        _ui.value = _ui.value.copy(showInfo = open)
    }

    fun cycleLanguage() {
        val available = _ui.value.availableLanguages
        if (!LanguageCycle.isToggleEnabled(available)) return
        val next = LanguageCycle.next(_ui.value.language, available)
        _ui.value = _ui.value.copy(language = next)
    }

    /**
     * The machine's own default, from backend config. A customer's manual switch
     * is deliberately temporary: the next person to walk up should find the
     * machine in the language its location expects, not whatever the last
     * customer chose.
     */
    private var defaultLanguage: Language = Language.Icelandic

    fun setLanguageOptions(default: Language, available: List<Language>) {
        val offered = available.ifEmpty { listOf(default) }
        val changed = default != defaultLanguage || offered != _ui.value.availableLanguages
        defaultLanguage = default
        val current = _ui.value
        // Every config poll that brings a change (a price, a poster) lands here.
        // A customer mid-purchase keeps the language they picked unless it is no
        // longer offered; at idle the screen switches to the new default at once.
        val language = when {
            current.phase == FridgePhase.IDLE -> default
            current.language !in offered -> default
            else -> current.language
        }
        _ui.value = current.copy(language = language, availableLanguages = offered)
        if (changed) {
            android.util.Log.i(
                "FridgeFlow",
                "language: default=${default.code} available=${offered.joinToString(",") { it.code }} showing=${language.code}",
            )
        }
    }

    private var bootStockReported = false

    /**
     * What is in each assigned basket, by the scales, for the operator dashboard.
     * Units use the basket's own unit weight, the same arithmetic as charging;
     * a per-kg basket reports grams only. Fire-and-forget on the VM scope.
     */
    private fun reportStock(reason: String, cabinet: Int?, weights: Map<Int, Int>) {
        val client = stockClient() ?: return
        val baskets = planogram.baskets
            .filter { it.productId != null && (cabinet == null || it.cabinet.ordinal + 1 == cabinet) }
            .mapNotNull { b ->
                val grams = weights[b.trayIndex] ?: return@mapNotNull null
                val units = when {
                    b.soldByWeight -> null
                    b.unitWeightG > 0 -> ((grams.coerceAtLeast(0).toDouble() / b.unitWeightG) + 0.5).toInt()
                    else -> null
                }
                isl.snudursopi.fridge.data.backend.BasketStock(b.cabinet.name, b.basket, grams, units)
            }
        if (baskets.isEmpty()) return
        viewModelScope.launch { runCatching { client.report(reason, cabinet, baskets) } }
    }

    /**
     * The scale half of the self-test (SelfTestReporter), from the idle watch's latest read — no
     * extra bus traffic. Null unless idle, so a test never competes with a customer.
     *  - missing: baskets this machine should have that did not answer the last read
     *  - faults: baskets the board reports a sensor fault for
     *  - drift: a basket reading -30 g or less, or an unassigned basket off zero by 30 g or more —
     *    both mean its zero has moved and counts on it will be wrong
     */
    fun scaleSelfTest(): Map<String, Any?>? {
        if (_ui.value.phase != FridgePhase.IDLE) return null
        val expected = planogram.spec.physicalBaskets
        val w = idleWeights
        val label = { c: Any, b: Int -> "$c$b" }
        val assigned = planogram.baskets.filter { it.productId != null }.map { it.trayIndex }.toSet()
        return mapOf(
            "expected" to expected.size,
            "answered" to expected.count { it.third in w },
            "missing" to expected.filter { it.third !in w }.map { label(it.first, it.second) },
            "faults" to hardware.sensorFaults.value.mapNotNull { (tray, code) ->
                expected.find { it.third == tray }?.let { "${label(it.first, it.second)}:$code" }
            },
            "drift" to expected.mapNotNull { (c, b, t) ->
                val g = w[t] ?: return@mapNotNull null
                if (g <= -SELF_TEST_DRIFT_G || (t !in assigned && g >= SELF_TEST_DRIFT_G)) "${label(c, b)}:$g" else null
            },
            "readAgeS" to if (idleWeightsAtMs > 0) (System.currentTimeMillis() - idleWeightsAtMs) / 1000 else null,
        )
    }

    fun startIdleWatch() {
        viewModelScope.launch {
            while (true) {
                // Skip the read entirely while a backend command owns the bus.
                if (_ui.value.phase == FridgePhase.IDLE && !busQuiet) {
                    hardware.readWeightsFresh()?.let {
                        idleWeights = it
                        idleWeightsAtMs = System.currentTimeMillis()
                        // Once per app start (and again if it couldn't be sent yet),
                        // so the dashboard has stock before the first sale.
                        if (!bootStockReported && stockClient() != null && planogram.baskets.isNotEmpty()) {
                            bootStockReported = true
                            reportStock("boot", null, it)
                        }
                    }
                }
                delay(IDLE_POLL_MS)
            }
        }
    }

    /**
     * True while something else needs the weight bus to itself.
     *
     * Tare and calibrate are starved if the poll is running — tare succeeded
     * about 15% of the time at a fast poll and 100% with the poll stopped — so a
     * remote scale command has to be able to silence us first.
     */
    @Volatile
    private var busQuiet = false

    /**
     * Run [block] with the weight poll held off the bus.
     *
     * Waits [BUS_SETTLE_MS] after setting the flag so any read already in flight
     * has its reply back before we start; the board answers a full read only
     * about every 2.4s. Always clears the flag, including on failure — a stuck
     * flag would silently stop the idle snapshot and make the next card tap slow.
     */
    suspend fun <T> withBusQuiet(block: suspend () -> T): T {
        busQuiet = true
        return try {
            delay(BUS_SETTLE_MS)
            block()
        } finally {
            busQuiet = false
        }
    }

    /** Called when the customer taps a card on the idle screen. */
    fun onCardTapped() {
        if (_ui.value.phase != FridgePhase.IDLE) return
        // CLOSED FOR SALE: refuse the card and close the reader's session, so nothing is held and
        // the door stays shut. The closed screen is already telling the customer why.
        if (_ui.value.outOfService) {
            android.util.Log.i("FridgeFlow", "card refused — machine is out of service")
            runCatching { payment.cancel("closed") }
            return
        }
        orderId = "fr-" + System.currentTimeMillis()
        sessionStartedAtMs = System.currentTimeMillis()
        transition(FridgePhase.AUTHORIZING)

        payment.preAuthorize(orderId) { approved ->
            if (!approved) {
                reportSettlement(Settlement.Result(emptyList(), emptyList(), 0), "declined")
                transition(FridgePhase.DECLINED)
                autoReturnToIdle()
                return@preAuthorize
            }
            // Snapshot resting weights and check for a faulty cell BEFORE opening.
            viewModelScope.launch {
                // *** NEVER START FROM WEIGHTS OLDER THAN THE LAST SALE.
                //
                // The idle snapshot only refreshes while the idle screen shows,
                // every ~5s. A card tapped soon after the previous customer's
                // receipt got a snapshot from BEFORE that sale, so this
                // customer was charged for what the last one took (seen on
                // 8626020714, 2026-10-12: a B3-only purchase charged A7 too).
                // Settlement now hands its measured weights forward; anything
                // older than the last session is re-read, at the cost of one
                // ~2.4s read before the door opens.
                val fresh = idleWeights.isNotEmpty() && idleWeightsAtMs >= lastSessionEndedAtMs
                val snapshot = if (fresh) {
                    idleWeights
                } else {
                    android.util.Log.w("FridgeFlow", "baseline older than the last session — re-reading before unlock")
                    hardware.readWeightsFresh() ?: emptyMap()
                }
                origWeights = snapshot
                // A fault the board pushed for a basket we'd actually sell from,
                // a config gap, or a snapshot we never got -> refuse to unlock
                // rather than risk charging wrongly.
                val faultedSellable = hardware.sensorFaults.value.keys.any { tray ->
                    planogram.basketAt(tray)?.sellable == true
                }
                if (snapshot.isEmpty() || faultedSellable || planogram.hasWeightGaps) {
                    // A sellable basket with no usable unit weight -> we can't
                    // charge correctly. Refuse rather than risk a wrong charge.
                    payment.cancel(orderId)
                    reportSettlement(Settlement.Result(emptyList(), emptyList(), 0), "sensor_fault")
                    transition(FridgePhase.SENSOR_FAULT)
                    autoReturnToIdle()
                    return@launch
                }
                openDoors()
            }
        }
    }

    /** True once the board has confirmed the door physically opened this
     *  session. If it never does, the customer paid but never took anything. */
    private var sawDoorOpen = false

    /** True once the bolt has been released this session. The bolt only
     *  re-latches when the door is physically shut, so unlocked -> locked is
     *  our door-closed signal on hardware with no door sensor. */
    private var sawUnlocked = false

    /** Last time a basket changed during a restock (RestockTimer.ACTIVITY_G). */
    @Volatile
    private var restockActivityMs = 0L

    /** When the bolt released for the current restock. */
    @Volatile
    private var restockUnlockedAtMs = 0L

    private var doorLeftOpenJob: Job? = null

    /**
     * A restock timed out with the bolt still released: report the door as left open, then wait —
     * as long as it takes — for the bolt to latch and report it closed.
     */
    private fun watchDoorLeftOpen(cabinet: Int, sinceMs: Long) {
        doorLeftOpenJob?.cancel()
        doorLeftOpenJob = viewModelScope.launch {
            runCatching { stockClient()?.doorStatus(open = true, cabinet = cabinet, sinceMs = sinceMs) }
            hardware.doorState.first { ds -> ds != null && ds.locked }
            android.util.Log.i("FridgeFlow", "door on cabinet $cabinet latched after being left open")
            runCatching { stockClient()?.doorStatus(open = false, cabinet = cabinet, sinceMs = null) }
        }
    }

    /**
     * Watch the board's door pushes and settle automatically when the door goes
     * open -> closed. The board pushes on change (and every ~10s), so this is
     * the hands-free trigger; onDoorClosed() stays public for manual testing.
     */
    /**
     * Enter restocking for one cabinet, on the backend's instruction.
     *
     * The open-door command IS the trigger and the door CLOSING is the end —
     * no second command needed, and it reuses the bolt-latch event the purchase
     * flow already relies on. Only one door at a time (unlike a customer
     * session, where a double opens both).
     *
     * Charging is impossible while in this phase because onCardTapped() refuses
     * unless the phase is IDLE, and watchDoor() ignores anything that isn't a
     * shopping phase. So a customer tapping mid-restock is turned away rather
     * than starting a sale into an open fridge.
     */
    fun beginRestock(cabinet: Int) {
        if (_ui.value.phase != FridgePhase.IDLE) {
            android.util.Log.w("FridgeFlow", "restock refused — machine is busy (${_ui.value.phase})")
            return
        }
        android.util.Log.i("FridgeFlow", "restock: opening cabinet $cabinet")
        _ui.value = _ui.value.copy(restockCabinet = cabinet)
        transition(FridgePhase.RESTOCK)
        startRestockGrid(cabinet)

        viewModelScope.launch {
            // OPEN IMMEDIATELY, not behind withBusQuiet. That wrapper waits
            // BUS_SETTLE_MS before running its block, which put the very first
            // unlock 2.8s away — long enough for the wait below to finish and
            // cancel it, so the bolt never moved at all. It also buys nothing
            // here: the idle weight poll already stopped the moment the phase
            // left IDLE, so the bus is quiet.
            hardware.openLock(cabinet, RESTOCK_HOLD_S)

            // Hold the bolt open long enough for the operator to WALK to the
            // machine — they pressed the button wherever they happened to be.
            // *** STOP NUDGING THE MOMENT THE BOLT ACTUALLY MOVES.
            //
            // This used to re-issue openLock every 30s for the full two-minute
            // window no matter what, including long after the door was already
            // open. On machine #2 (2026-08-27) that hammered the energy board —
            // which also drives the lights and the compressor — and both cycled
            // off and on repeatedly. Confirmed by killing the app: the cycling
            // stopped and did not return.
            //
            // It only surfaced on a double because that model's two doors share
            // ONE lock BY DESIGN and open together — so there is no cabinet 2
            // lock to report a state, and nothing was going to cancel the loop.
            //
            // A solenoid held open for 120s at a time is a real electrical load,
            // so re-asserting it needlessly is not a harmless retry.
            val nudger = launch {
                val until = System.currentTimeMillis() + RESTOCK_OPEN_WINDOW_MS
                while (isActive && System.currentTimeMillis() < until) {
                    delay(RESTOCK_REISSUE_MS)
                    // Any cabinet reporting unlocked means the bolt moved.
                    // Deliberately NOT matched to `cabinet`: on a shared-lock
                    // machine the report arrives under the other cabinet number.
                    val ds = hardware.doorState.value
                    if (ds != null && !ds.locked) {
                        android.util.Log.i(
                            "FridgeFlow",
                            "restock: bolt already open — stopping re-issue",
                        )
                        break
                    }
                    hardware.openLock(cabinet, RESTOCK_HOLD_S)
                }
            }

            // *** WAIT FOR A REAL UNLOCKED -> LOCKED TRANSITION, never for a
            // bare "locked". doorState is a StateFlow, so first{} is handed its
            // CURRENT value straight away — and after any previous session that
            // value is "cabinet 1, locked". Matching on locked alone therefore
            // ended the restock in the same breath it started, before the door
            // had moved. Requiring the unlock first makes a retained value
            // harmless.
            // Two waits with their own limits (RestockTimer): first for the bolt to release at all,
            // then — someone is working — for it to latch again, following the scales.
            // *** A REAL UNLOCKED -> LOCKED TRANSITION, never a bare "locked": doorState is a
            // StateFlow, so first{} gets its CURRENT value at once, and after any earlier session
            // that is "locked". Waiting for the unlock first makes a retained value harmless.
            // *** NOT MATCHED TO `cabinet`: a double drives one lock for both doors, so the report
            // may arrive under the other cabinet number.
            var outcome = "closed"
            try {
                val unlocked = withTimeoutOrNull(RestockTimer.UNLOCK_WAIT_MS) {
                    hardware.doorState.first { ds -> ds != null && !ds.locked }
                    true
                }
                if (unlocked == null) {
                    outcome = "never_unlocked"
                } else {
                    val unlockedAtMs = System.currentTimeMillis()
                    restockUnlockedAtMs = unlockedAtMs
                    restockActivityMs = unlockedAtMs
                    while (true) {
                        val latched = withTimeoutOrNull(RESTOCK_CHECK_MS) {
                            hardware.doorState.first { ds -> ds != null && ds.locked }
                            true
                        }
                        if (latched != null) break
                        val end = RestockTimer.shouldEnd(System.currentTimeMillis(), unlockedAtMs, restockActivityMs)
                        if (end != null) { outcome = end.name.lowercase(); break }
                    }
                }
            } finally {
                nudger.cancel()
            }

            // NEVER STRAND THE MACHINE: whatever ended it, re-read the baseline and go back to
            // idle. Sitting in RESTOCK forever stops it earning and defers every command.
            when (outcome) {
                "never_unlocked" -> android.util.Log.e(
                    "FridgeFlow",
                    "restock on cabinet $cabinet: the bolt never released in " +
                        "${RestockTimer.UNLOCK_WAIT_MS / 1000}s — back to idle, no restock recorded",
                )
                "idle" -> android.util.Log.e(
                    "FridgeFlow",
                    "restock on cabinet $cabinet ended: no basket changed for " +
                        "${RestockTimer.IDLE_MS / 60000} min and the door never latched — is it left open?",
                )
                "max" -> android.util.Log.e(
                    "FridgeFlow",
                    "restock on cabinet $cabinet ended at the ${RestockTimer.MAX_MS / 60000}-min ceiling " +
                        "with the door never latched",
                )
            }
            // The machine goes back to selling with its bolt still released: say so, and say again
            // when it finally latches, so the alert clears by itself.
            if (outcome == "idle" || outcome == "max") watchDoorLeftOpen(cabinet, restockUnlockedAtMs)
            finishRestock(cabinet, recorded = outcome != "never_unlocked")
        }
    }

    /**
     * Keep the reference grid live while the door is open.
     *
     * A FULL read every time, deliberately: nothing else wants the bus during a
     * restock, and the operator is looking at all sixteen baskets at once rather
     * than a stocked subset. Slower per pass and entirely the right trade here.
     */
    private fun startRestockGrid(cabinet: Int) {
        viewModelScope.launch {
            var prev: Map<Int, Int>? = null
            while (_ui.value.phase == FridgePhase.RESTOCK) {
                val weights = hardware.readWeightsFresh()
                // Someone moving stock: keeps an open restock from timing out (RestockTimer).
                if (RestockTimer.changed(prev, weights)) restockActivityMs = System.currentTimeMillis()
                if (weights != null) prev = weights
                val faults = hardware.sensorFaults.value
                _ui.value = _ui.value.copy(
                    restockCells = buildRestockCells(cabinet, weights, faults),
                )
                delay(RESTOCK_GRID_POLL_MS)
            }
        }
    }

    private fun buildRestockCells(
        cabinet: Int,
        weights: Map<Int, Int>?,
        faults: Map<Int, Int>,
    ): List<RestockCell> {
        val letter = if (cabinet == 2) "B" else "A"
        // *** ADDRESS BLOCK (20), NOT THE BASKET COUNT. This used 16 as the
        // cabinet offset, so cabinet B's restock grid showed trays 16..31 —
        // the same mistake trayOf() once had. Cabinet B starts at 20.
        return (1..planogram.spec.basketsPerCabinet).map { n ->
            val tray = (cabinet - 1) * Planogram.ADDRESS_BLOCK_PER_CABINET + (n - 1)
            val basket = planogram.basketAt(tray)
            val grams = weights?.get(tray)
            val faulted = faults.containsKey(tray)
            // Units come from the basket's OWN measured unit weight, never a
            // shared assumption — that per-basket figure is the whole basis of
            // charging, so the operator should be shown the same arithmetic.
            val byWeight = basket?.soldByWeight == true
            val units = if (byWeight) {
                null
            } else if (basket != null && basket.unitWeightG > 0 && grams != null) {
                ((grams.toFloat() / basket.unitWeightG) + 0.5f).toInt().coerceAtLeast(0)
            } else {
                null
            }
            val state = when {
                faulted -> RestockCellState.FAULT
                basket == null || !basket.enabled || basket.productId == null ->
                    RestockCellState.DISABLED
                byWeight && (grams ?: 0) >= Settlement.BY_WEIGHT_MIN_G -> RestockCellState.STOCKED
                byWeight -> RestockCellState.EMPTY
                units == null || units <= 0 -> RestockCellState.EMPTY
                else -> RestockCellState.STOCKED
            }
            RestockCell(
                basket = n,
                label = "$letter%02d".format(n),
                name = basket?.name.orEmpty(),
                imageUrl = basket?.imageUrl,
                units = units,
                grams = grams,
                state = state,
                byWeight = byWeight,
            )
        }
    }

    private suspend fun finishRestock(cabinet: Int, recorded: Boolean = true) {
        val fresh = hardware.readWeightsFresh()
        if (fresh != null) {
            idleWeights = fresh
            idleWeightsAtMs = System.currentTimeMillis()
            // A door that never opened is not a restock: don't reset "sold since the last restock".
            if (recorded) reportStock("restock", cabinet, fresh)
            android.util.Log.i(
                "FridgeFlow",
                "restock done on cabinet $cabinet — baseline re-read (${fresh.size} trays)",
            )
        } else {
            // Loud, because the consequence is mis-charging real customers. The
            // idle watch will replace the baseline on its next successful read,
            // so this recovers on its own, but it should be visible.
            android.util.Log.e(
                "FridgeFlow",
                "restock done on cabinet $cabinet but the BASELINE RE-READ FAILED — " +
                    "next sale could mis-charge until the idle watch refreshes it",
            )
        }
        _ui.value = _ui.value.copy(restockCabinet = 0, restockCells = emptyList())
        transition(FridgePhase.IDLE)
    }

    private fun watchDoor() {
        viewModelScope.launch {
            hardware.doorState.collect { ds ->
                if (ds == null) return@collect
                // Every frame, with its offset from the unlock. If LOCKED lands
                // at ~6s with the door still open, the board is reporting the
                // SOLENOID rather than the bolt, and "locked" cannot mean
                // "door shut" — which would explain settling mid-session.
                android.util.Log.i(
                    "FridgeDoor",
                    "frame T+${if (unlockedAt > 0) System.currentTimeMillis() - unlockedAt else -1}ms " +
                        "cabinet=${ds.cabinet} locked=${ds.locked} doorOpen=${ds.doorOpen} " +
                        "phase=${_ui.value.phase}",
                )
                // Defence in depth: only this machine's own doors can end its
                // session. A single fridge has cabinet 1 only, so a frame for
                // any other door is about something else — or about nothing.
                if (ds.cabinet !in planogram.spec.doorIndices) {
                    android.util.Log.w(
                        "FridgeDoor",
                        "ignoring frame for cabinet ${ds.cabinet} — this machine has " +
                            "${planogram.spec.doorIndices}",
                    )
                    return@collect
                }

                val phase = _ui.value.phase
                if (phase != FridgePhase.SHOPPING &&
                    phase != FridgePhase.UNLOCKED &&
                    phase != FridgePhase.DOOR_OPEN_WARN
                ) return@collect

                // This board never reports doorOpen — but the BOLT only latches
                // when the door is physically shut, so unlocked -> locked IS
                // the door-closed event. Confirmed on the machine: unlock at
                // T+0, customer takes an item, "locked" appears the moment the
                // door is pushed to.
                if (!ds.locked) {
                    sawUnlocked = true
                } else if (sawUnlocked) {
                    android.util.Log.i(
                        "FridgeFlow",
                        "bolt re-latched ${if (unlockedAt > 0) System.currentTimeMillis() - unlockedAt else -1}ms " +
                            "after unlock — treating as door closed, settling",
                    )
                    onDoorClosed()
                    return@collect
                }

                // If a machine DOES report the door properly, use that too —
                // it's the same conclusion reached a moment earlier.
                if (ds.doorOpen) {
                    sawDoorOpen = true
                } else if (sawDoorOpen) {
                    android.util.Log.i("FridgeFlow", "door reported closed, settling")
                    onDoorClosed()
                }
            }
        }
    }

    private fun openDoors() {
        sawDoorOpen = false
        sawUnlocked = false
        watchDoor()
        unlockedAt = System.currentTimeMillis()
        android.util.Log.i(
            "FridgeDoor",
            "UNLOCK issued for cabinets ${planogram.spec.lockIndices} (hold ${CUSTOMER_HOLD_S}s)",
        )
        planogram.spec.lockIndices.forEach { hardware.openLock(it, CUSTOMER_HOLD_S) }
        _ui.value = _ui.value.copy(
            phase = FridgePhase.UNLOCKED,
            cabinetsOpen = planogram.spec.cabinets.map { it.name },
        )
        // Move to shopping shortly after the unlock confirmation.
        viewModelScope.launch {
            delay(1200)
            if (_ui.value.phase == FridgePhase.UNLOCKED) transition(FridgePhase.SHOPPING)
            pollWhileOpen()
        }
    }

    /**
     * Poll weights for the tentative cart, and decide when shopping has
     * finished.
     *
     * This machine's board never reports doorOpen — it only ever says
     * "closed / unlocked" then "closed / locked" (the bolt relocks on a timer,
     * even while the customer is still reaching in). So there is no usable
     * door-close event to settle on, and we infer the end of shopping from the
     * weights themselves:
     *
     *   - once something HAS moved, wait for [STABLE_AFTER_CHANGE_MS] of no
     *     further movement, then settle. Mid-lift transients (a tray reading
     *     120g between 363g and its empty 8g) keep resetting that timer, which
     *     is exactly what we want — we only settle once the hand is out.
     *   - if NOTHING ever moves, give up after [NO_ACTIVITY_TIMEOUT_MS] and
     *     settle as "nothing taken" (customer never opened, or changed mind).
     *   - [MAX_SHOPPING_MS] is the hard backstop, matching the vendor's 610s.
     *
     * The door-based trigger in watchDoor() is left in place: if a machine DOES
     * report the door properly, it settles sooner and this loop just stops.
     */
    private fun pollWhileOpen() {
        viewModelScope.launch {
            val startedAt = System.currentTimeMillis()
            var lastChangeAt = startedAt
            var sawAnyChange = false
            var previous: Map<Int, Int> = origWeights

            // *** ONE SPAN PER CABINET, READ IN TURN, NO EXTRA PAUSE.
            //
            // Only STOCKED baskets can be taken from, so each cabinet's span is
            // its stocked baskets (first..last). The board's read time grows
            // with the span (~0.15s per tray: ~2.4s for a full cabinet), and
            // that read IS the pacing, so between reads we leave only the small
            // head-room the narrowed path has always used.
            //
            // Measured on 8626020714 (2026-10-12), before this: a full read of
            // 2.4s, then a fixed 2.5s pause — the cart moved every ~4.9s. And
            // once the double's full read waited for both cabinets (v0.61.1),
            // ~7s. Reading the cabinets in turn and redrawing after each puts
            // a fresh number on screen every ~2.6s on a full fridge, and much
            // sooner on a partly stocked one.
            val stockedByCabinet = planogram.baskets
                .filter { it.enabled && it.productId != null }
                .map { it.trayIndex }
                .groupBy { it / Planogram.ADDRESS_BLOCK_PER_CABINET }
            val spans: List<Pair<Int, Int>> = if (stockedByCabinet.isNotEmpty()) {
                stockedByCabinet.toSortedMap().values.map { t -> t.min() to (t.max() - t.min() + 1) }
            } else {
                // Nothing stocked: watch every physical basket of each cabinet.
                planogram.spec.cabinets.map {
                    it.ordinal * Planogram.ADDRESS_BLOCK_PER_CABINET to planogram.spec.basketsPerCabinet
                }
            }
            var spanIndex = 0
            suspend fun readActive(): Map<Int, Int>? {
                val (first, count) = spans[spanIndex % spans.size]
                spanIndex++
                return hardware.readTraysFresh(first, count)
            }
            fun currentSpanLabel(): String {
                val (first, count) = spans[(spanIndex - 1).coerceAtLeast(0) % spans.size]
                return "$count trays from $first"
            }

            var lastReadFinishedAt = 0L
            while (_ui.value.phase == FridgePhase.SHOPPING ||
                _ui.value.phase == FridgePhase.DOOR_OPEN_WARN
            ) {
                // Timing, because "the cart feels slow" has two very different
                // causes and they need different fixes: a slow BOARD READ means
                // the bus, a long GAP with fast reads means the UI thread. The
                // log distinguishes them in one purchase.
                val readStart = System.currentTimeMillis()
                val live = readActive()
                val now = System.currentTimeMillis()
                android.util.Log.i(
                    "FridgePoll",
                    "read ${now - readStart}ms for ${currentSpanLabel()}" +
                        (if (lastReadFinishedAt > 0L) ", gap ${readStart - lastReadFinishedAt}ms" else "") +
                        ", cycle ${if (lastReadFinishedAt > 0L) now - lastReadFinishedAt else 0}ms",
                )
                lastReadFinishedAt = now

                if (live != null) {
                    val moved = live.any { (tray, grams) ->
                        val before = previous[tray]
                        before != null && kotlin.math.abs(grams - before) > STABILITY_THRESHOLD_G
                    }
                    if (moved) {
                        lastChangeAt = now
                        sawAnyChange = true
                    }
                    previous = live
                    lastPolled = live

                    val tiles = FridgeUiState.tentativeTiles(planogram.baskets, origWeights, live)
                    _ui.value = _ui.value.copy(
                        cart = tiles,
                        totalIsk = tiles.sumOf { it.amountIsk },
                        totalIsFinal = false,
                    )
                }

                val idleFor = now - lastChangeAt
                val elapsed = now - startedAt
                val settled = when {
                    elapsed >= MAX_SHOPPING_MS -> "max session time"
                    sawAnyChange && idleFor >= STABLE_AFTER_CHANGE_MS -> "weights stable"
                    !sawAnyChange && elapsed >= NO_ACTIVITY_TIMEOUT_MS -> "no activity"
                    else -> null
                }
                if (settled != null) {
                    // *** NEVER SETTLE WITH THE DOOR OPEN. These timers only say
                    // the WEIGHTS stopped moving; they say nothing about the
                    // door. Charging while it's still open means the customer
                    // can take more after being billed, and the "final" weights
                    // aren't final at all. The bolt latching is the only honest
                    // evidence the session is over.
                    if (!confirmLatched()) {
                        android.util.Log.i(
                            "FridgeFlow",
                            "$settled, but the bolt is NOT latched — waiting for the door",
                        )
                        // Don't re-check every cycle; the door will announce
                        // itself via watchDoor the moment it shuts.
                        delay(LATCH_RECHECK_MS)
                        continue
                    }
                    android.util.Log.i("FridgeFlow", "shopping finished — $settled")
                    onDoorClosed()
                    return@launch
                }

                delay(SHOPPING_POLL_MS)
            }
        }
    }

    /** Called when the door-close sensor fires (or the test screen simulates it). */
    /**
     * Is the bolt actually latched?
     *
     * Trusts a pushed LOCKED state if we have one, and otherwise ASKS — a
     * NOTIFY_LOCK_STATUS frame can be missed when the bus is busy, and without
     * the query a missed push would strand the session forever. Asking costs one
     * small frame and turns "probably done" into "the door is shut".
     *
     * On this board the bolt only latches when the door is physically closed,
     * so LOCKED is a trustworthy door-closed signal.
     */
    private suspend fun confirmLatched(): Boolean {
        if (hardware.doorState.value?.locked == true) return true
        planogram.spec.doorIndices.forEach { hardware.readDoorState(it) }
        // Give the reply a moment to land; the board answers cmd 25 promptly.
        repeat(LATCH_QUERY_TRIES) {
            delay(LATCH_QUERY_STEP_MS)
            if (hardware.doorState.value?.locked == true) return true
        }
        return false
    }

    fun onDoorClosed() {
        if (_ui.value.phase != FridgePhase.SHOPPING && _ui.value.phase != FridgePhase.DOOR_OPEN_WARN) return
        transition(FridgePhase.CALCULATING)
        planogram.spec.lockIndices.forEach { hardware.closeLock(it) }

        viewModelScope.launch {
            // ONE full fresh read first, then narrow.
            //
            // v0.9.3 decided which baskets to re-read from the last shopping
            // poll — but that poll only runs every 2.5s, so an item grabbed
            // just before the door shut is invisible to it. The app then saw
            // "nothing moved", concluded nothing was taken, and CANCELLED a
            // real sale (log: settle -> no vend_request -> 0x06). Never infer
            // what moved from a stale poll; measure it.
            val settleFirst = hardware.readWeightsFresh()
                ?: lastPolled.ifEmpty { origWeights }

            val movedTrays = planogram.baskets
                .map { it.trayIndex }
                .filter { tray ->
                    val before = origWeights[tray] ?: return@filter false
                    val now = settleFirst[tray] ?: return@filter false
                    kotlin.math.abs(now - before) > STABILITY_THRESHOLD_G
                }

            // Two more samples for the median, narrowed to what actually moved
            // (a 1-tray read is far quicker than all 16). Unchanged baskets
            // keep the value we just measured.
            // One span PER CABINET: a single span from A7 (6) to B3 (22) also
            // asks for 16..19, which exist on no machine, and the board retries
            // each six times — the settle after such a purchase took 11s.
            val spans = movedTrays
                .groupBy { it / Planogram.ADDRESS_BLOCK_PER_CABINET }
                .values
                .map { trays -> trays.min() to (trays.max() - trays.min() + 1) }
            val extraReads = List(if (spans.isEmpty()) 0 else 2) {
                val merged = HashMap<Int, Int>()
                for ((firstTray, count) in spans) {
                    hardware.readTraysFresh(firstTray, count)?.let { merged.putAll(it) }
                }
                merged
            }
            val reads = listOf(settleFirst) + extraReads

            val finalWeights = planogram.baskets.associate { b ->
                val samples = reads.mapNotNull { it[b.trayIndex] }
                val value = if (samples.isNotEmpty()) {
                    Settlement.medianOf3(samples)
                } else {
                    origWeights[b.trayIndex] ?: 0
                }
                b.trayIndex to value
            }
            val result = Settlement.settle(planogram, origWeights, finalWeights)
            settlementSink(result)

            // What moved, basket by basket, so a wrong charge can be explained
            // from the log alone: before -> after, and the unit weight it was
            // divided by.
            val moved = planogram.baskets.mapNotNull { b ->
                val before = origWeights[b.trayIndex] ?: return@mapNotNull null
                val after = finalWeights[b.trayIndex] ?: return@mapNotNull null
                if (kotlin.math.abs(after - before) <= STABILITY_THRESHOLD_G) return@mapNotNull null
                "${b.cabinet}${b.basket} ${before}g→${after}g " +
                    if (b.soldByWeight) "(${b.priceIsk} kr/kg)" else "(unit ${b.unitWeightG}g)"
            }
            android.util.Log.i(
                "FridgeFlow",
                "settle detail: ${if (moved.isEmpty()) "no basket moved" else moved.joinToString("; ")}",
            )

            // The weights just measured are the next customer's starting point.
            // The doors are shut and locked from here until the next tap.
            lastSessionEndedAtMs = System.currentTimeMillis()
            idleWeights = HashMap(settleFirst).apply { putAll(finalWeights) }
            idleWeightsAtMs = lastSessionEndedAtMs
            if (!result.nothingTaken) reportStock("sale", null, idleWeights)

            if (result.nothingTaken) {
                android.util.Log.i(
                    "FridgeFlow",
                    "settled: NOTHING TAKEN — cancelling session (no charge)",
                )
                payment.cancel(orderId)
                reportSettlement(result, outcome = "nothing_taken")
                transition(FridgePhase.NOTHING_TAKEN)
            } else {
                android.util.Log.i(
                    "FridgeFlow",
                    "settled: charging ${result.totalIsk} kr for ${result.lines.size} line(s)",
                )
                payment.capture(orderId, result.totalIsk) { captured ->
                    reportSettlement(
                        result,
                        outcome = if (captured) "charged" else "pending_offline",
                    )
                    val phase = if (captured) FridgePhase.RECEIPT else FridgePhase.PENDING_OFFLINE
                    _ui.value = _ui.value.copy(
                        phase = phase,
                        cart = FridgeUiState.tilesFrom(result.lines),
                        totalIsk = result.totalIsk,
                        totalIsFinal = true,
                        // Order identity for a possible complaint. Carried
                        // separately from `cart` because a CartTile is a display
                        // row and is also used for the tentative cart, where no
                        // order exists yet.
                        orderId = orderId,
                        receiptLines = result.lines.map {
                            ComplaintLine(
                                cabinet = it.basket.cabinet.ordinal + 1,
                                basket = it.basket.basket,
                                // Non-null by construction: Basket.sellable
                                // requires productId != null, so an unlinked
                                // basket is never sold and never reaches a
                                // receipt. If this ever throws, the planogram
                                // or the settle path is wrong and we want to
                                // know rather than invent an id.
                                productId = requireNotNull(it.basket.productId) {
                                    "settled line with no productId: " +
                                        "${it.basket.cabinet}/${it.basket.basket}"
                                },
                                quantity = it.quantity,
                                lineIsk = it.lineIsk,
                            )
                        },
                    )
                }
            }
            // The receipt screen stays up longer where an emailed receipt is on
            // offer: 6 s is enough to read the amount, not to notice a button,
            // decide and tap it.
            // (Decided before the capture callback lands, so a queued offline
            // charge gets the longer hold too — harmless, and it has no button.)
            val soldSomething = !result.nothingTaken
            autoReturnToIdle(afterMs = if (soldSomething && _ui.value.receiptsEnabled) RECEIPT_HOLD_MS else 6_000)
        }
    }

    /** Door-left-open nudge, called by a timer in the hardware layer. */
    fun onDoorOpenTooLong() {
        if (_ui.value.phase == FridgePhase.SHOPPING) transition(FridgePhase.DOOR_OPEN_WARN)
    }

    /**
     * One genuinely fresh sample. Must NOT use hardware.readWeights(), which
     * returns the cached snapshot instantly — three of those in a row would be
     * the same map and the median-of-3 would be meaningless.
     */
    private suspend fun readOnce(): Map<Int, Int> =
        hardware.readWeightsFresh() ?: emptyMap()

    /**
     * Hand one completed session to whoever is listening (MainActivity ->
     * FridgeBackend). Wrapped in runCatching: a reporting problem must never
     * break the purchase flow the customer is standing in front of.
     */
    private fun reportSettlement(result: Settlement.Result, outcome: String) {
        val cb = onSettlementReport ?: return
        runCatching {
            cb(
                FridgeSettlementEvent(
                    orderId = orderId,
                    startedAtMs = sessionStartedAtMs,
                    closedAtMs = System.currentTimeMillis(),
                    planogram = planogram,
                    cabinetsOpened = planogram.spec.cabinets.map { it.name },
                    outcome = outcome,
                    // Only meaningful when we actually charged.
                    nayaxRef = if (outcome == "charged") payment.lastReference() else null,
                    result = result,
                )
            )
        }.onFailure {
            android.util.Log.w("FridgeFlow", "settlement report hook threw: ${it.message}")
        }
    }

    private fun transition(phase: FridgePhase) {
        // Returning to idle ends the session, so drop any language the last
        // customer picked — the next person should find the machine in the
        // language its location expects.
        if (phase == FridgePhase.IDLE && _ui.value.language != defaultLanguage) {
            _ui.value = _ui.value.copy(phase = phase, language = defaultLanguage)
            return
        }
        _ui.value = _ui.value.copy(phase = phase)
    }

    /**
     * *** THE RECEIPT IS ONLY ON SCREEN FOR SIX SECONDS.
     *
     * That is right for a receipt and fatally wrong for a complaint: nobody
     * reads a total, spots the entry button, taps it and fills in a form in six
     * seconds, and the form would be wiped mid-sentence if they tried. So the
     * timer is held and CANCELLED the moment the customer enters the complaint
     * flow — see [openComplaint]. It is restarted, with a longer fuse, once the
     * complaint is done or abandoned.
     */
    /**
     * A clean idle state that keeps what describes the machine rather than the
     * customer. deviceCode is pushed once at startup and never re-sent, so
     * dropping it here made the admin sheet say ÓSKRÁÐ after the first sale.
     */
    private fun freshIdle() = _ui.value.let {
        // *** KEEP EVERYTHING THAT DESCRIBES THE MACHINE.
        //
        // Machine settings are pushed into this state only when the config
        // changes, so anything dropped here stays dropped until the next config
        // edit. This used to keep three fields: after the first sale a machine
        // lost its posters, logo, operator name, idle timeout and language
        // options, and fell back to Icelandic whatever its default.
        FridgeUiState(
            machineLabel = it.machineLabel,
            operatorName = it.operatorName,
            supportEmail = it.supportEmail,
            logoUrl = it.logoUrl,
            posters = it.posters,
            showPosters = it.showPosters,
            // A machine closed for sale stays closed after a restock (freshIdle runs then too).
            outOfService = it.outOfService,
            outOfServiceReason = it.outOfServiceReason,
            adminPin = it.adminPin,
            idleTimeoutSeconds = it.idleTimeoutSeconds,
            cabinetCount = it.cabinetCount,
            language = defaultLanguage,
            availableLanguages = it.availableLanguages,
            deviceCode = it.deviceCode,
            lastPollOkMs = it.lastPollOkMs,
            receiptsEnabled = it.receiptsEnabled,
        )
    }

    private var idleReturnJob: Job? = null

    private fun autoReturnToIdle(afterMs: Long = 6000) {
        idleReturnJob?.cancel()
        _ui.value = _ui.value.copy(idleReturnAtMs = System.currentTimeMillis() + afterMs)
        idleReturnJob = viewModelScope.launch {
            delay(afterMs)
            _ui.value = freshIdle()
        }
    }

    // ---------------------------------------------------------- email receipt

    fun openReceiptEmail() {
        if (!_ui.value.receiptsEnabled || _ui.value.orderId.isBlank()) return
        _ui.value = _ui.value.copy(phase = FridgePhase.RECEIPT_EMAIL, receipt = ReceiptDraft())
        // Someone who opens the form and walks away must not leave the machine
        // stuck on it; every keystroke restarts this.
        autoReturnToIdle(afterMs = RECEIPT_FORM_IDLE_MS)
    }

    fun setReceiptEmail(email: String) {
        val clean = email.replace(" ", "").take(254)
        _ui.value = _ui.value.copy(receipt = _ui.value.receipt.copy(email = clean, invalid = false, error = false))
        if (_ui.value.phase == FridgePhase.RECEIPT_EMAIL) autoReturnToIdle(afterMs = RECEIPT_FORM_IDLE_MS)
    }

    /** One-tap domain: replaces whatever follows the @, or appends it. */
    fun addReceiptDomain(domain: String) {
        val local = _ui.value.receipt.email.substringBefore('@')
        setReceiptEmail(local + domain)
    }

    /** Back to the receipt, with its timer restarted: they may still want to complain. */
    fun cancelReceiptEmail() {
        _ui.value = _ui.value.copy(phase = FridgePhase.RECEIPT, receipt = ReceiptDraft())
        autoReturnToIdle(afterMs = RECEIPT_HOLD_MS)
    }

    fun sendReceipt() {
        val state = _ui.value
        val d = state.receipt
        if (d.sending) return
        val email = d.email.trim()
        if (!EMAIL_SHAPE.matches(email)) {
            _ui.value = state.copy(receipt = d.copy(invalid = true))
            return
        }
        val client = receiptClient() ?: run {
            android.util.Log.e("FridgeFlow", "receipt send with no client wired")
            _ui.value = state.copy(receipt = d.copy(error = true))
            return
        }
        _ui.value = state.copy(receipt = d.copy(sending = true, invalid = false, error = false))
        viewModelScope.launch {
            val res = client.send(state.orderId, email, state.language.code)
            val cur = _ui.value
            // A slow network can outlast the form's idle timer; by then the
            // machine is back at idle and the next customer must not see this.
            if (cur.phase != FridgePhase.RECEIPT_EMAIL) return@launch
            when (res) {
                is ReceiptResult.Accepted, is ReceiptResult.Queued -> {
                    _ui.value = cur.copy(
                        phase = FridgePhase.RECEIPT_SENT,
                        receipt = cur.receipt.copy(sending = false, queued = res is ReceiptResult.Queued),
                    )
                    autoReturnToIdle(afterMs = 8_000)
                }
                is ReceiptResult.Rejected ->
                    _ui.value = cur.copy(receipt = cur.receipt.copy(sending = false, error = true))
            }
        }
    }

    // ------------------------------------------------------------- complaints

    /** Entry from the receipt. Stops the idle timer; nothing else may. */
    fun setDeviceCode(code: String?) {
        _ui.value = _ui.value.copy(deviceCode = code)
    }

    fun setLastPollOk(atMs: Long?) {
        _ui.value = _ui.value.copy(lastPollOkMs = atMs)
    }

    fun openComplaint() {
        idleReturnJob?.cancel()
        idleReturnJob = null
        _ui.value = _ui.value.copy(
            phase = FridgePhase.COMPLAINT,
            // Fresh draft every time, and every line pre-selected: the common
            // case is one item in the basket and a customer who wants to say
            // something about it. Pre-selecting saves the tap; deselecting is
            // easy when only some lines are wrong.
            complaint = ComplaintDraft(
                selectedLines = _ui.value.receiptLines.indices.toSet(),
            ),
        )
    }

    fun toggleComplaintLine(index: Int) {
        val d = _ui.value.complaint
        val next = if (index in d.selectedLines) d.selectedLines - index
        else d.selectedLines + index
        _ui.value = _ui.value.copy(complaint = d.copy(selectedLines = next))
    }

    fun setComplaintReason(reason: ComplaintReason) {
        _ui.value = _ui.value.copy(complaint = _ui.value.complaint.copy(reason = reason))
    }

    fun setComplaintNote(note: String) {
        _ui.value = _ui.value.copy(complaint = _ui.value.complaint.copy(note = note))
    }

    fun setComplaintEmail(email: String) {
        _ui.value = _ui.value.copy(complaint = _ui.value.complaint.copy(email = email))
    }

    /** Abandon: straight back to idle, no partial complaint sent. */
    fun cancelComplaint() {
        _ui.value = freshIdle()
    }

    /**
     * Send.
     *
     * A QUEUED complaint is shown to the customer as accepted, because from
     * where they are standing it has been: it is persisted and will be
     * delivered. Only an outright REJECTION keeps them on the form, and that is
     * a kiosk bug rather than anything they did.
     */
    fun sendComplaint() {
        val state = _ui.value
        val client = complaintClient() ?: run {
            android.util.Log.e("FridgeFlow", "complaint send with no client wired")
            return
        }
        val d = state.complaint
        if (d.sending || d.selectedLines.isEmpty()) return
        _ui.value = state.copy(complaint = d.copy(sending = true, error = false))

        viewModelScope.launch {
            val body = client.buildBody(
                orderId = state.orderId,
                lines = state.receiptLines.filterIndexed { i, _ -> i in d.selectedLines },
                reason = d.reason,
                note = d.note,
                customerEmail = d.email,
                timestampMs = System.currentTimeMillis(),
            )
            when (val res = client.send(body)) {
                is ComplaintResult.Sent -> finishComplaint(res.complaintId)
                is ComplaintResult.Queued -> finishComplaint("")
                is ComplaintResult.Rejected ->
                    _ui.value = _ui.value.copy(
                        complaint = _ui.value.complaint.copy(sending = false, error = true),
                    )
            }
        }
    }

    private fun finishComplaint(reference: String) {
        _ui.value = _ui.value.copy(
            phase = FridgePhase.COMPLAINT_DONE,
            complaint = _ui.value.complaint.copy(sending = false, reference = reference),
        )
        // Longer than the receipt's six seconds: there is a reference number on
        // this screen that someone may want to write down.
        autoReturnToIdle(afterMs = 15_000)
    }

    private companion object {
        /** Receipt screen when an emailed receipt is offered. Siggi chose 15 s on the mockup. */
        const val RECEIPT_HOLD_MS = 15_000L

        /** The address form returns to idle after this long with no typing. */
        const val RECEIPT_FORM_IDLE_MS = 60_000L

        /** Enough to catch a missing @ or domain; the backend has the final say. */
        val EMAIL_SHAPE = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$")
    }
}

/**
 * The payment surface the flow needs. Backed in production by the reused
 * Marshall controller (pre-auth via `price_not_final_support`, capture via
 * sendPrice at session close). A fake implementation drives the emulator.
 */
interface PaymentGateway {
    fun preAuthorize(orderId: String, onResult: (approved: Boolean) -> Unit)
    fun capture(orderId: String, amountIsk: Int, onResult: (captured: Boolean) -> Unit)
    fun cancel(orderId: String)

    /**
     * The payment processor's own reference for the last approved charge, for
     * the backend's `nayaxRef`. Defaulted so test/fake gateways need not care.
     */
    fun lastReference(): String? = null
}

/**
 * Delay BETWEEN shopping-cart polls.
 *
 * MEASURED ON THE MACHINE (4 stocked baskets): the narrowed read itself takes
 * ~660ms, so at the old 1200ms delay the cart could only update every ~1.9s —
 * which is what "the cart feels slow" was. THE READ ALREADY PACES US; this delay
 * is only head-room so the board's pushed lock-status frames aren't stuck behind
 * back-to-back reads. Measured again at 400ms: cycle 1108ms, matching the
 * projection exactly. Now 200ms, for a ~900ms cycle.
 *
 * THIS IS THE FLOOR WORTH TAKING. A lift lands at a random point in the cycle,
 * so the felt wait is about half a cycle plus a read — ~1.15s here, against
 * ~1.4s at 400ms. Going lower trades against the board's PUSHED lock-status
 * frame, which is what triggers settlement, so this is the first thing to walk
 * back if a door-close ever feels hesitant.
 *
 * NOTE HOW THIS SCALES: each cabinet's span is contiguous (first..last stocked
 * basket), so a full cabinet is a ~2.4s read. Since v0.61.2 that is ALSO the
 * full-fridge case — there is no longer a separate 2.5s pause for full reads,
 * which doubled the wait (measured cycle 4.9s on 8626020714, 2026-10-12).
 */
private const val SHOPPING_POLL_MS = 200L

/**
 * A tray has to move by more than this for us to count it as the customer
 * doing something. Matches the settlement noise floor: thermal drift on these
 * load cells runs to about +/-15g over hours.
 */
private const val STABILITY_THRESHOLD_G = 15

/** Quiet period after the last movement before we call shopping finished. */
private const val STABLE_AFTER_CHANGE_MS = 10_000L

/**
 * How long each door's bolt stays released after a card is accepted (0.69.2). Both doors unlock
 * together; a door nobody opens re-locks after this. It was the SDK minimum of 6 s, so a customer
 * who opened the right door found the left one already locked (Siggi, 2026-10-26: 15 s). The
 * purchase still ends 10 s after the last weight change, so this does not lengthen a sale.
 */
private const val CUSTOMER_HOLD_S = 15

/** If nothing ever moves, end the session as "nothing taken" after this. */
private const val NO_ACTIVITY_TIMEOUT_MS = 45_000L

/** Hard backstop, matching the vendor algorithm's 610s ceiling. */
private const val MAX_SHOPPING_MS = 610_000L

/**
 * How long to wait before re-testing the bolt after a settle trigger fired with
 * the door still open. Deliberately unhurried: watchDoor settles the instant the
 * bolt latches, so this path is only a backstop for a MISSED push, not the
 * normal route.
 */
private const val LATCH_RECHECK_MS = 3_000L

/** Poll steps while waiting for a queried lock-status reply. */
private const val LATCH_QUERY_TRIES = 8
private const val LATCH_QUERY_STEP_MS = 150L

/**
 * The hardware speaks TRAY numbers (0-15); the planogram speaks BASKET numbers
 * (1-16). Confirmed on the machine by putting a 500g weight on each basket in
 * turn: basket N is tray N-1.
 *
 * Everything above the hardware layer works in basket numbers, so weights are
 * translated the moment they cross the boundary. Getting this wrong charges the
 * NEIGHBOURING basket's product and quantity — it once billed 2 x skyr (658 kr)
 * for one kók (295 kr).
 */

/** How often to refresh the resting snapshot while the machine is idle. */
private const val IDLE_POLL_MS = 5_000L

/**
 * How long to wait after silencing the weight poll before using the bus for a
 * backend scale command. One full board cycle plus a margin, so a read issued
 * just before the pause has delivered its reply and won't collide with what
 * follows.
 */
private const val BUS_SETTLE_MS = 2_800L

/** How long to keep re-issuing the unlock so a walking operator finds it open. */
private const val RESTOCK_OPEN_WINDOW_MS = 2L * 60L * 1000L

/**
 * How long the bolt is asked to stay released for a restock, in seconds. The
 * SDK's unlock takes a timeout and clamps anything under 6 up to 6 — the old
 * hard-coded 0 therefore meant six seconds, which is why the first live restock
 * had re-locked before anyone reached the machine. One byte on the wire, so the
 * ceiling is 255.
 */
private const val RESTOCK_HOLD_S = 120

/** Re-issue interval across the open window, as insurance on the unit. */
private const val RESTOCK_REISSUE_MS = 30_000L

/**
 * Gap between restock grid refreshes.
 *
 * A full 16-tray read already takes ~2.4s, so a 2s gap meant near back-to-back
 * reads on the same bus the LOCK frames travel on — starving both the unlock and
 * the door-close notification. An operator placing stock doesn't need sub-second
 * feedback; the bus needs the clear air far more.
 */
private const val RESTOCK_GRID_POLL_MS = 4_000L

/** An empty basket this far from zero has drifted (self-test warning). */
private const val SELF_TEST_DRIFT_G = 30

/**
 * Restock limits live in RestockTimer. History: 15 minutes for everything kept a faulty machine out
 * of service for a quarter hour; the 5 minutes that replaced it cut real restocks short (Nordic
 * Hostel, 2026-10-16). Now: 2 min for the bolt to release, then 10 still minutes or an hour.
 *
 * How often an open restock checks its idle and hour limits (RestockTimer) while waiting. */
private const val RESTOCK_CHECK_MS = 15_000L
