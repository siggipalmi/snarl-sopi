package isl.snudursopi.vending.hardware.nayax

import android.util.Log
import com.bitmick.marshall.models.vmc_configuration
import com.bitmick.marshall.vmc.vmc_framework
import com.bitmick.marshall.vmc.vmc_link
import com.bitmick.marshall.vmc.vmc_vend_t

/**
 * Drives a card payment through the real Nayax Marshall SDK, with our app as
 * the host (serial via [AndroidMarshallSerial] on ttyS3).
 *
 * STAGE 1 (this version): charge only. On approval we do NOT dispense — we just
 * accept the charge and settle. This proves the money half end-to-end with a
 * real card before we couple dispensing.
 *
 * Lifecycle:
 *   connect()  -> SDK opens ttyS3, handshake, onReady (host up, V00 clears)
 *   charge(amount) -> session_start -> [customer taps] onSessionBegin ->
 *                     vend_request(amount) -> onVendApproved (return true) ->
 *                     onSettlement(true) -> result callback APPROVED
 *   declined  -> onVendDenied -> result DECLINED
 *   cancel()  -> session_cancel
 *
 * One session per basket TOTAL (not per item).
 */
class MarshallPaymentController(
    private val portPath: String = "/dev/ttyS3",
    private val baud: Int = 115200,
    private val log: (String) -> Unit,
) {
    companion object { private const val TAG = "MarshallPay" }

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
    var onCardDetected: (() -> Unit)? = null

    fun connect(onReady: () -> Unit = {}) {
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
            cfg.multi_session_support = true
            // price_not_final = true makes preselection behave like
            // pre-authorization: we authorize a total, then capture the ACTUAL
            // (possibly lower) amount at session_close. This is how we charge
            // only for items that actually dispensed (partial settlement).
            cfg.price_not_final_support = true
            cfg.reader_always_on = false
            cfg.always_idle = true
            cfg.vend_denied_policy = vmc_configuration.vend_denied_policy_cancel
            cfg.explicit_vend_success = false
            cfg.mifare_approved_by_vmc_support = false
            cfg.mag_card_approved_by_vmc_support = false
            cfg.dump_packets_level = vmc_configuration.debug_level_dump_moderate
            cfg.debug = true

            m.link.set_lowlevel(AndroidMarshallSerial())
            m.link.configure(cfg)
            m.link.set_events(object : vmc_link.vmc_link_events_t {
                override fun onReady(config: vmc_link.vpos_config_t) {
                    state = State.READY
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
                    // always_idle mode: price already sent via vend_request in
                    // charge(); this is just the "card detected" notification.
                    emit("card detected (onSessionBegin funds=$sessionType)")
                    onCardDetected?.invoke()
                }
                override fun onTransactionInfo(data: vmc_vend_t.vend_session_data_t?) {
                    emit("transaction info received")
                }
                override fun onVendApproved(session: vmc_vend_t.vend_session_t?): Boolean {
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
                        emit("✅ onVendApproved — STAGE 1: accepting charge, NO dispense")
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
        } catch (t: Throwable) {
            state = State.ERROR
            Log.e(TAG, "connect failed", t)
            emit("connect threw: ${t.message}")
        }
    }

    /** Begin a charge for [amountIsk] (whole krónur; decimal_place=0). */
    fun charge(amountIsk: Int, onResult: (Result) -> Unit) {
        if (state != State.READY) {
            onResult(Result.Failed("not ready (state=$state)"))
            return
        }
        pendingAmount = amountIsk
        resultCb = onResult
        try {
            // always_idle mode: send the price directly. The VPOS displays the
            // amount immediately and the customer taps ONCE to pay it. No
            // session_start / wait-for-tap step.
            state = State.VENDING
            val amt = amountIsk.toShort()
            val session = vmc_vend_t.vend_session_t(
                amt,                                  // total_amount
                amountIsk,                            // funds_avail
                vmc_vend_t.unit_of_measure_general,   // unit
                amt,                                  // vend_amount
            )
            vmc?.vend?.vend_request(session)
            emit("vend_request sent for $amountIsk kr — VPOS should show amount; tap card ONCE")
        } catch (t: Throwable) {
            state = State.READY
            emit("charge threw: ${t.message}")
            onResult(Result.Failed(t.message ?: "charge error"))
        }
    }

    fun cancel() {
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
        state = State.READY
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

    private fun emit(s: String) {
        Log.i(TAG, s)
        log(s)
    }
}
