package isl.snudursopi.fridge.hardware.nayax

import android.util.Log
import com.bitmick.marshall.models.vmc_configuration
import com.bitmick.marshall.vmc.vmc_framework
import com.bitmick.marshall.vmc.vmc_link
import com.bitmick.marshall.vmc.vmc_vend_t

/**
 * Drives a card payment through the real Nayax Marshall SDK, with our app as
 * the host (serial via [AndroidMarshallSerial] on ttyS4).
 *
 * STAGE 1 (this version): charge only. On approval we do NOT dispense — we just
 * accept the charge and settle. This proves the money half end-to-end with a
 * real card before we couple dispensing.
 *
 * Lifecycle:
 *   connect()  -> SDK opens ttyS4, handshake, onReady (host up, V00 clears)
 *   charge(amount) -> session_start -> [customer taps] onSessionBegin ->
 *                     vend_request(amount) -> onVendApproved (return true) ->
 *                     onSettlement(true) -> result callback APPROVED
 *   declined  -> onVendDenied -> result DECLINED
 *   cancel()  -> session_cancel
 *
 * One session per basket TOTAL (not per item).
 */
class MarshallPaymentController(
    /**
     * Var, not val: the port is settable at runtime so it can be tried from the
     * dashboard without a rebuild. Read fresh on every connect.
     */
    private var portPath: String = "/dev/ttyS4",
    private val baud: Int = 115200,
    /**
     * always_idle describes a PRICE-FIRST machine: the VMC sends the amount,
     * the reader displays it, the customer taps once. That's coil.
     *
     * The fridge is CARD-FIRST: the customer taps, a session opens, and the
     * price only arrives ~10s later once we know what was taken. That's the
     * ordinary MDB session flow, so this should be false here. With it true,
     * the first vend_request after the reader is enabled comes back DENIED
     * (0x06) and only the second session of a run succeeds.
     */
    private val alwaysIdle: Boolean = false,
    /** Keep the reader live so a tap can start a sale at any moment. */
    private val readerAlwaysOn: Boolean = true,
    private val log: (String) -> Unit,
) {
    companion object {
        private const val TAG = "MarshallPay"

        /**
         * How long to wait for onReady before restarting the link.
         *
         * 90s: a healthy handshake completes in under a second, so anything
         * approaching this means the reader is not answering. Long enough not
         * to thrash a terminal that is mid-boot after a firmware load.
         */
        private const val READY_TIMEOUT_MS = 90_000L

        /**
         * Product code sent with every fridge charge. The amount goes in the
         * price field; the code must be one the Nayax terminal accepts. 0 is
         * what the coil basket path uses and the reader accepts it. If the
         * terminal is later configured with a strict product list, set this to
         * a code that exists in it.
         */
        private const val FRIDGE_PRODUCT_CODE: Short = 0
    }

    enum class State { IDLE, CONNECTING, READY, AWAITING_CARD, VENDING, ERROR }

    sealed class Result {
        data class Approved(val amount: Int) : Result()
        data class Declined(val reason: String) : Result()
        data class Failed(val reason: String) : Result()
        object Cancelled : Result()
    }

    @Volatile var state: State = State.IDLE
        private set

    private var vmc: vmc_framework? = null
    /** True once the vend layer is ready for a NEW vend. Reset on cancel() and
     *  re-set when the SDK fires vend onReady — lets the app wait for the
     *  terminal to actually return to idle after a cancel before re-charging a
     *  changed amount (otherwise the new request races the cancel and the
     *  terminal never prices it). */
    @Volatile var vendReady = false

    private var pendingAmount: Int = 0
    private var resultCb: ((Result) -> Unit)? = null

    /** True while the reader has a card session open awaiting a price. Set in
     *  onSessionBegin, cleared in finish()/cancel(). Lets charge() send a
     *  vend_request into an already-open card session (card-first flow). */
    @Volatile private var sessionOpen = false

    /**
     * Nayax's own transaction id for the last approved vend, read from
     * vend_session_data_t.transaction_id. This is the reference that shows up
     * in Nayax's settlement reporting, so it's what the backend wants as
     * `nayaxRef` — it's what joins a disputed charge back to the card
     * transaction. Null until a vend is approved; cleared when a new session
     * begins so a stale id can never be attached to a later sale.
     */
    @Volatile var lastTransactionId: String? = null
        private set

    // STAGE 1 toggle: when false, onVendApproved returns true WITHOUT dispensing.
    // Stage 2 will set a dispense callback here.
    var onApprovedDispense: ((amountIsk: Int) -> Boolean)? = null

    /** Fired when the reader link comes up (true) or drops (false). Lets the
     *  app show/auto-clear a "reader unavailable" screen. */
    var onReaderStateChanged: ((ready: Boolean) -> Unit)? = null

    /** Fired when a card is actually presented to the reader (session begins).
     *  Lets the app tell a real, tapped-then-declined card apart from a
     *  no-card-tap, so it never re-arms (and churns the bus) on a phantom
     *  decline. */
    var onCardDetected: ((fundsAvail: Int) -> Unit)? = null

    /** Optional extra sink for log lines (the debug screen mirrors them). */
    var onLogLine: ((String) -> Unit)? = null

    /**
     * *** THE LINK MUST RECOVER BY ITSELF.
     *
     * link.start() runs once and then waits for onReady forever. If the Nayax
     * terminal restarts — a firmware load, a power cut, a settings push — our
     * side never notices: it is still waiting on a handshake attempted against
     * a device that has since rebooted. The machine looks fine and silently
     * cannot take payment.
     *
     * Machine 8626020716 sat in exactly that state through a whole afternoon on
     * 2026-09-04, and the only remedies were adb or somebody at the machine —
     * neither of which exists for a fridge in a hotel lobby.
     *
     * So: if onReady has not arrived within [READY_TIMEOUT_MS], tear the link
     * down and start it again, indefinitely. A payment link that needs a human
     * to notice it is down is not a payment link.
     */
    private var readyWatchdog: Thread? = null

    private fun armReadyWatchdog() {
        // *** NEVER INTERRUPT OURSELVES.
        //
        // The watchdog thread calls connect(), and connect() calls this. So on
        // a retry, readyWatchdog IS the running thread — interrupting it set
        // its own interrupt flag mid-connect, and the SDK's blocking startup
        // then threw. The result on machine 8626020716 was a link that tore
        // itself down after 90s and never came back: strictly worse than no
        // watchdog at all, because the first attempt was destroyed too.
        readyWatchdog?.takeIf { it != Thread.currentThread() }?.interrupt()
        readyWatchdog = Thread {
            try {
                Thread.sleep(READY_TIMEOUT_MS)
                if (state == State.READY || state == State.AWAITING_CARD ||
                    state == State.VENDING
                ) {
                    return@Thread
                }
                emit("no onReady in ${READY_TIMEOUT_MS / 1000}s — restarting the link")
                runCatching { disconnect() }
                Thread.sleep(2_000)
                state = State.IDLE
                // Clear any stray interrupt before re-entering the SDK, whose
                // startup blocks and would abort on a set flag.
                Thread.interrupted()
                runCatching { connect(lastOnReady) }
                    .onFailure {
                        // connect() arms the next watchdog itself on success.
                        // If it threw, nothing would — and the retry loop would
                        // die silently after one attempt, which is the failure
                        // this whole mechanism exists to prevent.
                        emit("reconnect failed: ${it.message} — will retry")
                        armReadyWatchdog()
                    }
            } catch (_: InterruptedException) {
                // Superseded by a newer attempt; nothing to do.
            }
        }.apply { isDaemon = true; start() }
    }

    private var lastOnReady: () -> Unit = {}

    /** Change the serial port. Takes effect on the next connect. */
    fun setPortPath(path: String) {
        if (path == portPath) return
        emit("port changed $portPath -> $path (applies on next connect)")
        portPath = path
    }

    fun connect(onReady: () -> Unit = {}) {
        lastOnReady = onReady
        if (state != State.IDLE && state != State.ERROR) {
            emit("connect ignored — state=$state")
            return
        }
        state = State.CONNECTING
        try {
            val m = vmc_framework.getInstance()
            vmc = m
            emit("marshall sdk ${vmc_framework.get_version()} — connecting on $portPath")

            // Route the SDK's internal logging (incl. packet dumps showing the
            // actual amount sent) into our log view for diagnostics.
            try {
                com.bitmick.utils.logger.level(com.bitmick.utils.logger.LOG_LEVEL_EVERYTHING)
                com.bitmick.utils.logger.aux(object : com.bitmick.utils.logger.log_aux_i {
                    override fun log(line: String?) {
                        if (line != null) emit("SDK: $line")
                    }
                })
            } catch (t: Throwable) {
                emit("logger hook failed: ${t.message}")
            }

            val cfg = vmc_configuration()
            cfg.port_vpos = portPath
            cfg.port_vpos_baud = baud
            cfg.machine_type = vmc_configuration.machine_type_type_beverage
            cfg.model = "snarl-sopi"
            cfg.serial = "01234567"
            cfg.sw_ver = vmc_framework.get_version()
            cfg.hw_ver = "wm55"
            cfg.manuf_code = "agv"
            cfg.multi_vend_support = false
            // SINGLE session, FINAL price. The fridge computes the exact total
            // (weight-based settlement) BEFORE it ever sends vend_request, so
            // there is no need for pre-authorization or partial capture.
            //
            // price_not_final=true (docx [163]) makes the device treat the
            // vend as a PRE-AUTHORIZATION and defer the real capture "a couple
            // of days" - which is exactly the ~1hr-deferred settlement seen in
            // the Nayax portal. With a known final price we want a real-time
            // capture, so this must be FALSE. Per docx [157-160] price_not_final
            // and multi_session go together and both need DCS config; we want
            // neither. This is the fix for the deferred-settlement problem.
            cfg.multi_session_support = false
            cfg.price_not_final_support = false
            cfg.reader_always_on = readerAlwaysOn
            cfg.always_idle = alwaysIdle
            cfg.vend_denied_policy = vmc_configuration.vend_denied_policy_cancel
            cfg.explicit_vend_success = false
            cfg.mifare_approved_by_vmc_support = false
            cfg.mag_card_approved_by_vmc_support = false
            cfg.dump_packets_level = vmc_configuration.debug_level_dump_moderate
            cfg.debug = true

            emit("config: always_idle=$alwaysIdle reader_always_on=$readerAlwaysOn price_not_final=${cfg.price_not_final_support} multi_session=${cfg.multi_session_support}")
            m.link.set_lowlevel(AndroidMarshallSerial())
            m.link.configure(cfg)
            m.link.set_events(object : vmc_link.vmc_link_events_t {
                override fun onReady(config: vmc_link.vpos_config_t) {
                    state = State.READY
                    // Handshake landed — stop the retry timer.
                    readyWatchdog?.interrupt()
                    readyWatchdog = null
                    emit("✅ link onReady — host up. decimal_place=${config.decimal_place} default_credit=${config.default_credit}")
                    onReaderStateChanged?.invoke(true)
                    onReady()
                }
                override fun onCommError() {
                    state = State.ERROR
                    emit("⚠ onCommError")
                    onReaderStateChanged?.invoke(false)
                }
            })

            m.vend.register_callbacks(object : vmc_vend_t.vend_callbacks_t {
                override fun onReady(session: vmc_vend_t.vend_session_t?) {
                    vendReady = true
                    emit("vend layer ready")
                }
                override fun onSessionBegin(sessionType: Int) {
                    // Card-first: the reader opened a session and is waiting for
                    // us to send a price. Mark the session open so charge() will
                    // send into it even though state != READY.
                    sessionOpen = true
                    lastTransactionId = null
                    emit("card detected (onSessionBegin funds=$sessionType)")
                    lastFundsAvail = sessionType
                    onCardDetected?.invoke(sessionType)
                }
                override fun onTransactionInfo(data: vmc_vend_t.vend_session_data_t?) {
                    emit("transaction info received")
                }
                override fun onVendApproved(session: vmc_vend_t.vend_session_t?): Boolean {
                    // Grab Nayax's transaction id while the session object is
                    // in hand — this is the only place it's exposed to us.
                    runCatching {
                        session?.data?.transaction_id?.let { id ->
                            val text = id.toString()
                            if (text.isNotBlank() && text != "0") {
                                lastTransactionId = text
                                emit("nayax transaction_id: $text")
                            }
                        }
                    }
                    // BASKET path (price-not-final, single session). Follow
                    // Weimi's proven pattern: APPROVE IMMEDIATELY (return true
                    // fast — do NOT block the SDK callback thread), then dispense
                    // + session_close on a background thread. Blocking here (e.g.
                    // the 8s dead-slot timeout) collapses the preselection window.
                    if (basketItems.isNotEmpty() && onDispenseItem != null) {
                        val sessionForClose = session ?: basketSession
                        emit("✅ onVendApproved (basket) — approving now; dispensing in background")
                        Thread {
                            dispenseBasketAndClose(sessionForClose)
                        }.apply { isDaemon = true }.start()
                        return true
                    }

                    // MULTI-VEND path (kept for reference/diagnostics).
                    if (pendingItems.isNotEmpty() && onDispenseItem != null) {
                        val disp = onDispenseItem!!
                        var capturedSum = 0
                        var vendedCount = 0
                        for (item in pendingItems) {
                            val ok = try { disp(item) } catch (t: Throwable) {
                                emit("dispense item slot=${item.slot} threw: ${t.message}"); false
                            }
                            if (ok) { capturedSum += item.priceIsk; vendedCount++ }
                            emit("item slot=${item.slot} ${if (ok) "VENDED (+${item.priceIsk})" else "FAILED"}")
                        }
                        val s = session ?: multiSession
                        if (s != null) s.vend_amount = capturedSum.toShort()
                        pendingAmount = capturedSum
                        emit("multi-vend: $vendedCount/${pendingItems.size} vended → capturing $capturedSum kr")
                        return capturedSum > 0
                    }

                    // SINGLE-item path (Stage 1/2).
                    val dispenser = onApprovedDispense
                    return if (dispenser == null) {
                        // Charge-only (the fridge: goods already taken). Approving
                        // is NOT the end of it — the session has to be CLOSED for
                        // the reader to actually settle, or it sits there having
                        // approved a vend that never completes. Same pattern as
                        // the proven basket path: return true fast so we don't
                        // block the SDK callback thread, close on a background
                        // thread.
                        emit("✅ onVendApproved — accepting charge, closing session")
                        val toClose = session
                        val amount = pendingAmount
                        Thread {
                            try {
                                if (toClose != null) {
                                    toClose.vend_amount = amount.toShort()
                                    toClose.total_amount = amount.toShort()
                                    toClose.funds_avail = amount
                                    if (toClose.products_list != null &&
                                        toClose.products_list.isNotEmpty()
                                    ) {
                                        val p = toClose.products_list[0]
                                        p.price = amount.toShort()
                                        p.qty = 1
                                    }
                                    toClose.session_status = vmc_vend_t.session_status_ok_e
                                    vmc?.vend?.session_close(toClose)
                                    emit("session_close → completing $amount kr")
                                } else {
                                    emit("onVendApproved: no session object to close")
                                }
                            } catch (t: Throwable) {
                                emit("session_close threw: ${t.message}")
                            }
                            // The reader does NOT reliably send onSettlement for
                            // this charge-only path (confirmed: session 3 closed
                            // fine but no onSettlement, so state stayed VENDING
                            // and denied the NEXT vend). Resolve + reset here so
                            // the controller is READY for the next sale rather
                            // than waiting on a callback that never comes.
                            finish(Result.Approved(amount))
                        }.apply { isDaemon = true }.start()
                        true
                    } else {
                        emit("✅ onVendApproved — dispensing…")
                        val ok = try { dispenser(pendingAmount) } catch (t: Throwable) {
                            emit("dispense threw: ${t.message}"); false
                        }
                        emit(if (ok) "dispense OK → confirming vend" else "dispense FAILED → will report failure")
                        ok
                    }
                }
                override fun onVendDenied(session: vmc_vend_t.vend_session_t?) {
                    emit("❌ onVendDenied — card declined")
                    finish(Result.Declined("declined"))
                }
                override fun onSettlement(success: Boolean) {
                    emit("onSettlement success=$success")
                    // For basket (price-not-final), session_close already ran in
                    // dispenseBasketAndClose; capturedAmount holds the real total.
                    if (basketItems.isNotEmpty() || capturedAmount > 0) {
                        if (success) finish(Result.Approved(capturedAmount))
                        else finish(Result.Failed("settlement failed"))
                        return
                    }
                    if (success) finish(Result.Approved(pendingAmount))
                    else finish(Result.Failed("settlement failed"))
                }
                override fun onSessionTimeout(type: Int) {
                    emit("⏱ onSessionTimeout type=$type")
                    finish(Result.Failed("timeout"))
                }
                override fun onStatus(status: Int, data: ByteArray?) {
                    emit("vpos status=$status ${data?.let { String(it) } ?: ""}")
                }
                override fun onOpenedSessions(sessions: ShortArray?) {}
                override fun onReaderState(enabled: Boolean) { emit("reader state enabled=$enabled") }
                override fun onRemoteVend(p1: Short, p2: Short, p3: Int) {}
                override fun onReceipt(type: Int, content: String?) {}
            })

            m.link.start()
            emit("link.start() — waiting for onReady")
            armReadyWatchdog()
        } catch (t: Throwable) {
            state = State.ERROR
            Log.e(TAG, "connect failed", t)
            emit("connect threw: ${t.message}")
        }
    }

    /** Begin a charge for [amountIsk] (whole krónur; decimal_place=0). */
    fun charge(amountIsk: Int, onResult: (Result) -> Unit) {
        // In the card-first fridge flow the customer has already tapped, so a
        // session is open and state is NOT READY. Refusing here (as the coil
        // code did) sends no vend_request and the reader hangs forever on
        // "please select a product". Allow the charge whenever the link is up
        // and either idle (READY) or already in a card session.
        if (state != State.READY && !sessionOpen) {
            emit("charge REFUSED — link not ready and no open session (state=$state)")
            onResult(Result.Failed("not ready (state=$state)"))
            return
        }
        emit("charge → sending vend_request for $amountIsk kr (state=$state, sessionOpen=$sessionOpen)")
        pendingAmount = amountIsk
        resultCb = onResult
        try {
            state = State.VENDING
            val amt = amountIsk.toShort()
            // Build the session from an EXPLICIT vend_item_t, exactly like the
            // proven basket path. The 4-arg vend_session_t(amt, funds, unit,
            // amt) constructor packs the amount into the PRODUCT CODE slot too,
            // so the reader received product=658 and its product list rejected
            // it (portal showed "Unknown (-1)"). 658 always denied, 295 always
            // approved — it was the CODE, not the amount or the state. Here we
            // send a FIXED valid product code (0) and put the money only in the
            // price field.
            val list = ArrayList<vmc_vend_t.vend_item_t>()
            list.add(
                vmc_vend_t.vend_item_t(
                    FRIDGE_PRODUCT_CODE,                  // code (fixed, valid)
                    amt,                                  // price = the charge
                    1,                                    // qty
                    vmc_vend_t.unit_of_measure_general,
                )
            )
            val session = vmc_vend_t.vend_session_t(list)
            session.total_amount = amt
            session.vend_amount = amt
            session.funds_avail = amountIsk
            vmc?.vend?.vend_request(session)
            emit("vend_request sent for $amountIsk kr — VPOS should show amount; tap card ONCE")
        } catch (t: Throwable) {
            state = State.READY
            emit("charge threw: ${t.message}")
            onResult(Result.Failed(t.message ?: "charge error"))
        }
    }

    fun cancel() {
        sessionOpen = false
        try {
            vendReady = false   // wait for the next vend onReady before re-charging
            vmc?.vend?.session_cancel()
            emit("session_cancel")
        } catch (_: Throwable) {}
        finish(Result.Cancelled)
    }

    // ---- multi-vend (basket) with partial settlement ----

    /** One basket line for multi-vend: which slot, its price, mapped to a code. */
    data class Item(val code: Int, val slot: Int, val priceIsk: Int)

    private var pendingItems: List<Item> = emptyList()
    // Per-item dispense callback: given the item, dispense and return true if
    // the motor turned (item delivered). Set by the caller (Stage 3a/3b).
    var onDispenseItem: ((Item) -> Boolean)? = null
    private var multiSession: vmc_vend_t.vend_session_t? = null

    // Option 3: price-not-final single-session basket
    private var basketItems: List<Item> = emptyList()
    private var basketTotal: Int = 0
    private var capturedAmount: Int = 0
    private var basketSession: vmc_vend_t.vend_session_t? = null

    // ---- fridge mode: approve, then HOLD the session open while the customer
    // shops, and capture the settled total later via vend_amount + close.
    // (Coil dispenses inside onVendApproved and closes immediately; the fridge
    // cannot, because the real total isn't known until the door shuts.)
    /** Funds the reader reported when the card opened the session. */
    @Volatile var lastFundsAvail: Int = 0
        private set

    // NOTE: there is deliberately no "pre-authorise then hold" path. Returning
    // true from onVendApproved IS the settlement in MDB — a vend_request for a
    // ceiling charges that ceiling. The fridge therefore opens the door on the
    // card's session_begin (funds already confirmed by the reader) and only
    // sends the vend_request once settlement knows the real total.

    /**
     * Charge a basket as a single multi-vend session (pre-auth). The VPOS
     * shows the TOTAL; customer taps once. On approval we dispense each item;
     * we then capture ONLY the sum of items that vended (partial settlement
     * via vend_amount). Requires multi_vend_support + VPOS pre-auth mode.
     */
    /**
     * Runs on a BACKGROUND thread after onVendApproved returns true. Dispenses
     * each basket item, computes the vended sum, sets the session's final
     * amount, and closes the session to capture only that amount (price-not-
     * final). Matches Weimi's "approve fast, then outGoodResult→session_close".
     */
    private fun dispenseBasketAndClose(session: vmc_vend_t.vend_session_t?) {
        val disp = onDispenseItem
        if (disp == null) { emit("no dispense hook"); return }
        var capturedSum = 0
        var vendedCount = 0
        for (item in basketItems) {
            val ok = try { disp(item) } catch (t: Throwable) {
                emit("dispense item slot=${item.slot} threw: ${t.message}"); false
            }
            if (ok) { capturedSum += item.priceIsk; vendedCount++ }
            emit("item slot=${item.slot} ${if (ok) "VENDED (+${item.priceIsk})" else "FAILED"}")
        }
        capturedAmount = capturedSum
        pendingAmount = capturedSum
        emit("basket: $vendedCount/${basketItems.size} vended → final $capturedSum kr (auth was $basketTotal)")
        try {
            if (session != null) {
                // Set the final (possibly reduced) amount to capture. Keep
                // quantity = 1; only adjust the price + session amounts so the
                // SDK computes price*qty = capturedSum (not *30).
                session.vend_amount = capturedSum.toShort()
                session.total_amount = capturedSum.toShort()
                session.funds_avail = capturedSum
                if (session.products_list != null && session.products_list.isNotEmpty()) {
                    val p = session.products_list[0]
                    p.price = capturedSum.toShort()
                    p.qty = 1
                }
                session.session_status =
                    if (capturedSum > 0) vmc_vend_t.session_status_ok_e
                    else vmc_vend_t.session_status_fail_to_dispense_e
                vmc?.vend?.session_close(session)
                emit("session_close → capturing $capturedSum kr (qty 1)")
            }
        } catch (t: Throwable) {
            emit("dispenseBasketAndClose close threw: ${t.message}")
        }
        // Result is finalized in onSettlement (the SDK signals completion).
    }

    /**
     * Option 3: charge a basket as a SINGLE session with price-not-final.
     * Authorizes the total; the VPOS shows the total and the customer taps
     * once. On approval we dispense all items and capture ONLY the vended sum
     * via session_close (partial settlement). Requires price_not_final_support
     * + multi_session_support (and matching DCS config: Preselection Enabled,
     * choose-product-timeout 0).
     */
    fun chargeBasket(items: List<Item>, onResult: (Result) -> Unit) {
        if (state != State.READY) {
            onResult(Result.Failed("not ready (state=$state)"))
            return
        }
        if (items.isEmpty()) {
            onResult(Result.Failed("empty basket"))
            return
        }
        basketItems = items
        resultCb = onResult
        try {
            state = State.VENDING
            val total = items.sumOf { it.priceIsk }
            basketTotal = total
            pendingAmount = total
            // Build the session from an EXPLICIT single product with quantity=1,
            // so the SDK doesn't derive a wrong quantity (the (SIBS) ctor in
            // 0.1.5.25 produced quantity=total → price*qty mismatch). One item
            // priced at the basket total; we reduce its price at close.
            val list = ArrayList<vmc_vend_t.vend_item_t>()
            list.add(
                vmc_vend_t.vend_item_t(
                    0.toShort(),            // code
                    total.toShort(),        // price = basket total
                    1,                      // qty = 1 (explicit!)
                    vmc_vend_t.unit_of_measure_general,
                )
            )
            val session = vmc_vend_t.vend_session_t(list)
            session.total_amount = total.toShort()
            session.vend_amount = total.toShort()
            session.funds_avail = total
            basketSession = session
            vmc?.vend?.vend_request(session)
            emit("basket vend_request: ${items.size} items, total $total kr (1 product, qty 1) — tap ONCE")
        } catch (t: Throwable) {
            state = State.READY
            emit("chargeBasket threw: ${t.message}")
            onResult(Result.Failed(t.message ?: "chargeBasket error"))
        }
    }

    fun chargeMulti(items: List<Item>, onResult: (Result) -> Unit) {
        if (state != State.READY) {
            onResult(Result.Failed("not ready (state=$state)"))
            return
        }
        if (items.isEmpty()) {
            onResult(Result.Failed("empty basket"))
            return
        }
        pendingItems = items
        resultCb = onResult
        try {
            state = State.VENDING
            val list = ArrayList<vmc_vend_t.vend_item_t>()
            for (it in items) {
                list.add(
                    vmc_vend_t.vend_item_t(
                        it.code.toShort(),       // code
                        it.priceIsk.toShort(),   // price
                        1,                        // qty (int)
                        vmc_vend_t.unit_of_measure_general,
                    )
                )
            }
            val session = vmc_vend_t.vend_session_t(list)
            multiSession = session
            val total = items.sumOf { it.priceIsk }
            pendingAmount = total
            vmc?.vend?.vend_request(session)
            emit("multi vend_request: ${items.size} items, total $total kr — VPOS shows total; tap ONCE")
        } catch (t: Throwable) {
            state = State.READY
            emit("chargeMulti threw: ${t.message}")
            onResult(Result.Failed(t.message ?: "chargeMulti error"))
        }
    }

    private fun finish(result: Result) {
        // Idempotent: the charge-only path calls finish() itself after
        // session_close, and a late onSettlement may call it again. Once the
        // result callback is gone the transaction is already resolved, so a
        // second call must NOT stomp the state of whatever session is running
        // now.
        if (resultCb == null && state == State.READY) return
        state = State.READY
        sessionOpen = false
        pendingItems = emptyList()
        multiSession = null
        basketItems = emptyList()
        basketSession = null
        capturedAmount = 0
        basketTotal = 0
        val cb = resultCb
        resultCb = null
        cb?.invoke(result)
    }

    fun disconnect() {
        try {
            vmc?.link?.stop()
            vmc?.stop()
        } catch (_: Throwable) {}
        state = State.IDLE
        vendReady = false
        vmc = null
        emit("disconnected")
    }

    /**
     * *** ONE LOG LINE PER EVENT.
     *
     * This used to call BOTH Log.i(TAG, ...) and log(...) — and NayaxLink
     * passes log = { Log.i("MarshallPay", it) }, so every line appeared twice
     * under the same tag at the same millisecond.
     *
     * That cost real time on 2026-09-04: exactly duplicated lines are the
     * documented signature of two MarshallPaymentControllers fighting over
     * ttyS4 (see NayaxLink), so a payment fault was read as a second controller
     * for half an hour. A diagnostic that mimics a known bug is worse than no
     * diagnostic.
     *
     * *** BUT DROPPING Log.i HERE WAS WORSE. v0.49.2 removed it and left only
     * the injected [log] sink — and the Marshall lines vanished from the relay
     * entirely, on the one machine whose payment link we were trying to
     * diagnose. Losing the evidence is a bigger failure than logging it twice.
     *
     * Log.i is the reliable path and stays. The duplicate is removed at the
     * INJECTION SITE instead: NayaxLink now passes a no-op sink.
     */
    private fun emit(s: String) {
        Log.i(TAG, s)
        log(s)
        onLogLine?.invoke(s)
    }
}
