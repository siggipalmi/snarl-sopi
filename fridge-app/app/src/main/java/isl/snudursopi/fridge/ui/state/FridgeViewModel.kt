package isl.snudursopi.fridge.ui.state

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import isl.snudursopi.fridge.domain.Planogram
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
        // The idle animation draws a single or a double from this, so it must
        // follow the config rather than a build flag.
        _ui.value = _ui.value.copy(
            cabinetCount = p.spec.cabinets.size.coerceAtLeast(1),
            operatorName = p.operatorName,
            supportEmail = p.supportEmail,
        )
    }

    /** Most recent resting weights, refreshed while the machine sits idle. */
    /** When the session's unlock went out, so door frames can be timed against it. */
    private var unlockedAt: Long = 0L

    private var idleWeights: Map<Int, Int> = emptyMap()

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
        defaultLanguage = default
        _ui.value = _ui.value.copy(
            language = default,
            availableLanguages = available.ifEmpty { listOf(default) },
        )
    }

    fun startIdleWatch() {
        viewModelScope.launch {
            while (true) {
                // Skip the read entirely while a backend command owns the bus.
                if (_ui.value.phase == FridgePhase.IDLE && !busQuiet) {
                    hardware.readWeightsFresh()?.let { idleWeights = it }
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
                val snapshot = idleWeights.ifEmpty {
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
            val closed = try {
                withTimeoutOrNull(RESTOCK_MAX_MS) {
                    var sawUnlocked = false
                    hardware.doorState.first { ds ->
                        // *** NOT MATCHED TO `cabinet`. A double drives one
                        // lock for both doors, so the report only ever arrives
                        // under one cabinet number; requiring a match meant
                        // restock on the other cabinet never completed — it sat
                        // the full 15 minutes while the nudger hammered the
                        // board. Any real unlock-then-lock is the transition we
                        // are waiting for.
                        if (ds == null) return@first false
                        if (!ds.locked) {
                            sawUnlocked = true
                            false
                        } else {
                            sawUnlocked
                        }
                    }
                    true
                }
            } finally {
                nudger.cancel()
            }

            if (closed == null) {
                // NEVER STRAND THE MACHINE. Sitting in RESTOCK forever means it
                // stops earning and — because commands defer while it's busy —
                // can't be recovered remotely either. Fall back to idle, but
                // re-read the baseline on the way out so we can't sell against
                // stale weights if something was in fact moved.
                android.util.Log.e(
                    "FridgeFlow",
                    "restock on cabinet $cabinet TIMED OUT with no door-close — " +
                        "returning to idle and re-reading the baseline anyway",
                )
            }
            finishRestock(cabinet)
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
            while (_ui.value.phase == FridgePhase.RESTOCK) {
                val weights = hardware.readWeightsFresh()
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
        return (1..Planogram.BASKETS_PER_CABINET).map { n ->
            val tray = (cabinet - 1) * Planogram.BASKETS_PER_CABINET + (n - 1)
            val basket = planogram.basketAt(tray)
            val grams = weights?.get(tray)
            val faulted = faults.containsKey(tray)
            // Units come from the basket's OWN measured unit weight, never a
            // shared assumption — that per-basket figure is the whole basis of
            // charging, so the operator should be shown the same arithmetic.
            val units = if (basket != null && basket.unitWeightG > 0 && grams != null) {
                ((grams.toFloat() / basket.unitWeightG) + 0.5f).toInt().coerceAtLeast(0)
            } else {
                null
            }
            val state = when {
                faulted -> RestockCellState.FAULT
                basket == null || !basket.enabled || basket.productId == null ->
                    RestockCellState.DISABLED
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
            )
        }
    }

    private suspend fun finishRestock(cabinet: Int) {
        val fresh = hardware.readWeightsFresh()
        if (fresh != null) {
            idleWeights = fresh
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
            "UNLOCK issued for cabinets ${planogram.spec.lockIndices} " +
                "(hold defaults to the SDK minimum of 6s)",
        )
        planogram.spec.lockIndices.forEach { hardware.openLock(it) }
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

            // Only STOCKED baskets can be taken from, so only they need polling.
            // A full 16-tray read costs the board's full ~2.4s cadence; reading
            // just the stocked span returns much faster, so the tentative cart
            // keeps up with the customer instead of lagging ~5s behind. Empty
            // fridges fall back to a full read. Fewer trays = LESS bus load, so
            // this never violates the pacing rule. Span is contiguous (the SDK
            // reads firstTray..firstTray+count), which is fine — a few extra
            // empty trays inside the span cost little and still beat all 16.
            val stockedBaskets = planogram.baskets
                .filter { it.enabled && it.productId != null }
                .map { it.trayIndex }
            val firstTray: Int
            val trayCount: Int
            if (stockedBaskets.isEmpty()) {
                firstTray = 0
                trayCount = 0 // sentinel: use the full read
            } else {
                firstTray = stockedBaskets.min()
                trayCount = stockedBaskets.max() - stockedBaskets.min() + 1
            }

            val narrowed = trayCount in 1 until FULL_TRAY_COUNT
            // Full reads keep the board's safe ~2.4s cadence; a narrowed read is
            // cheaper and can cycle at the faster floor without starving the bus.
            val pollDelayMs = if (narrowed) SHOPPING_POLL_MS else FULL_READ_POLL_MS

            suspend fun readActive(): Map<Int, Int>? =
                if (narrowed) {
                    hardware.readTraysFresh(firstTray, trayCount)
                } else {
                    hardware.readWeightsFresh()
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
                    "read ${now - readStart}ms for ${if (narrowed) trayCount else FULL_TRAY_COUNT} trays" +
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
                        totalIsk = tiles.sumOf { it.priceIsk * it.quantity },
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

                delay(pollDelayMs)
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
            val extraReads = if (movedTrays.isEmpty()) {
                emptyList()
            } else {
                val firstTray = movedTrays.min()
                val count = movedTrays.max() - movedTrays.min() + 1
                List(2) {
                    hardware.readTraysFresh(firstTray, count) ?: emptyMap()
                }
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
            autoReturnToIdle()
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
    private var idleReturnJob: Job? = null

    private fun autoReturnToIdle(afterMs: Long = 6000) {
        idleReturnJob?.cancel()
        idleReturnJob = viewModelScope.launch {
            delay(afterMs)
            _ui.value = FridgeUiState(machineLabel = _ui.value.machineLabel)
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
        _ui.value = FridgeUiState(machineLabel = _ui.value.machineLabel)
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
 * NOTE HOW THIS SCALES, because it gets worse as the fridge fills: the span is
 * contiguous (firstTray..firstTray+count), so stocking baskets further apart
 * widens it even if few are stocked, and a full 16 falls back to the ~2.4s full
 * read. Responsiveness therefore degrades as stock is added — worth re-measuring
 * once more baskets are loaded rather than assuming this number still holds.
 */
private const val SHOPPING_POLL_MS = 200L

/**
 * Delay between polls when we've fallen back to a FULL 16-tray read (a fully
 * stocked fridge). The board only answers a full read every ~2.4s, so this
 * stays at the proven-safe cadence rather than the faster narrowed-read floor.
 */
private const val FULL_READ_POLL_MS = 2500L

/** Full complement of trays on a single cabinet — the narrowed-read fallback. */
private const val FULL_TRAY_COUNT = 16

/**
 * A tray has to move by more than this for us to count it as the customer
 * doing something. Matches the settlement noise floor: thermal drift on these
 * load cells runs to about +/-15g over hours.
 */
private const val STABILITY_THRESHOLD_G = 15

/** Quiet period after the last movement before we call shopping finished. */
private const val STABLE_AFTER_CHANGE_MS = 10_000L

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
 * Hard ceiling on a restock. Reached only if the door never closes; we then
 * re-baseline and return to idle rather than leaving the machine unsellable
 * and unreachable.
 */
/**
 * Gap between restock grid refreshes.
 *
 * A full 16-tray read already takes ~2.4s, so a 2s gap meant near back-to-back
 * reads on the same bus the LOCK frames travel on — starving both the unlock and
 * the door-close notification. An operator placing stock doesn't need sub-second
 * feedback; the bus needs the clear air far more.
 */
private const val RESTOCK_GRID_POLL_MS = 4_000L

/**
 * *** WAS 15 MINUTES, WHICH IS A MACHINE OUT OF SERVICE FOR A QUARTER OF AN HOUR.
 *
 * If the door never reports closing — a silent cabinet, a failed sensor — the
 * restock flow used to sit here for the full quarter hour with the phase stuck
 * on RESTOCK, refusing customers the whole time. Five minutes is longer than any
 * real restock and short enough that a fault does not take the machine out of
 * service for the afternoon.
 */
private const val RESTOCK_MAX_MS = 5L * 60L * 1000L
