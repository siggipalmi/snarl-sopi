package isl.snudursopi.fridge.hardware

import android.util.Log
import isl.snudursopi.fridge.domain.Basket
import isl.snudursopi.fridge.domain.Planogram
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Keeps the baskets' LED price tags in step with the planogram.
 *
 * The tags share the weight/lock bus, so this is deliberately unhurried: one
 * tag at a time, spaced out, and never while a customer session is running. A
 * wrong price on a shelf edge is worse than a slow one, and a starved bus is
 * worse than both — the board answers a full tray read only about every 2.4s,
 * and flooding it once made tare fail ~85% of the time.
 *
 * Only changed tags are re-sent, so the routine 60s config poll costs nothing
 * when nothing has moved.
 */
class PriceTagSync(
    private val hardware: FridgeHardwareController,
    /** True while a customer is mid-purchase; pushes wait for it to clear. */
    private val isSessionActive: () -> Boolean,
) {
    /** TRAY -> the text last successfully sent to that tag. Keyed by tray, not
     *  basket number: numbers repeat per cabinet, so on a double the same number
     *  in cabinet B would be mistaken for already-pushed. */
    private val lastPushed = mutableMapOf<Int, String>()
    private val lock = Mutex()

    /**
     * Push any tag whose text has changed. Safe to call on every planogram
     * emission; serialised, so overlapping calls queue rather than interleave
     * on the bus.
     */
    /**
     * Returns "pushed N, skipped M" so a caller — notably the sync_price_tags
     * command — can report what actually happened rather than just claiming
     * success. A tag that silently failed to write is a customer reading the
     * wrong price.
     *
     * *** [force] IGNORES THE lastPushed CACHE, AND IT IS THE POINT OF THE
     * REMOTE COMMAND. The cache records what we BELIEVE is on each tag. If a
     * write was recorded but never landed on the LED — which is exactly the
     * state we are debugging, a shelf showing an old price — then every
     * subsequent sync sees "unchanged" and skips it forever. force re-writes
     * regardless, so a wrong tag can be corrected from a dashboard instead of a
     * drive across town.
     */
    suspend fun sync(planogram: Planogram, force: Boolean = false): String =
        lock.withLock {
            var pushed = 0
            var skipped = 0
            // *** INSTRUMENTED BECAUSE A PRICE CHANGE DID NOT REACH THE SHELF.
            // A tag showing the wrong price is a customer being told the wrong
            // amount, so this needs to be diagnosable without standing at the
            // machine. Logs what it decided and why, not just what it wrote.
            Log.i(TAG, "sync called: ${planogram.baskets.size} basket(s)")
            for (basket in planogram.baskets.sortedBy { it.basket }) {
                val text = tagTextFor(basket)
                if (!force && lastPushed[basket.trayIndex] == text) {
                    skipped++
                    Log.i(
                        TAG,
                        "basket ${basket.basket} tray ${basket.trayIndex}: " +
                            "unchanged ('$text') — skipping",
                    )
                    continue
                }
                Log.i(
                    TAG,
                    "basket ${basket.basket} tray ${basket.trayIndex}: " +
                        "'${lastPushed[basket.trayIndex] ?: "<never>"}' -> '$text'",
                )

                // Hold off while someone is shopping — their live cart and the
                // settlement read both need the bus more than a tag does.
                //
                // *** BOUNDED. This used to be an unbounded wait, so a machine
                // stuck in any non-idle phase would never update a tag again and
                // would say nothing about it. A customer-facing price is worth
                // more than bus politeness: after the timeout we write anyway.
                var waited = 0L
                while (isSessionActive() && waited < SESSION_WAIT_MAX_MS) {
                    delay(SESSION_WAIT_MS)
                    waited += SESSION_WAIT_MS
                }
                if (waited >= SESSION_WAIT_MAX_MS) {
                    Log.w(TAG, "session still active after ${waited}ms — writing tag anyway")
                }

                val tray = basket.trayIndex
                hardware.setPriceTagDigits(tray, text)
                lastPushed[basket.trayIndex] = text
                pushed++
                delay(SPACING_MS)
            }
            Log.i(TAG, "sync done: pushed=$pushed skipped=$skipped force=$force")
            "pushed $pushed tag(s), skipped $skipped unchanged" +
                if (force) " (forced)" else ""
        }

    /**
     * What this basket's tag should read. Empty string blanks the tag.
     *
     * A tag that can't tell the truth is blanked rather than approximated: a
     * five-figure price won't fit four digits, and showing the last four would
     * display a tenth of the real amount on a customer-facing label. That's the
     * same class of error as the SDK's decimal formatting, and worse, because
     * it looks plausible.
     */
    private fun tagTextFor(basket: Basket): String {
        if (!basket.enabled || basket.productId == null) return ""
        val price = basket.priceIsk
        if (price <= 0) return ""
        if (price > MAX_TAG_PRICE) {
            Log.w(TAG, "basket ${basket.basket}: $price kr won't fit a 4-digit tag — blanking")
            return ""
        }
        return price.toString()
    }

    private companion object {
        const val TAG = "PriceTagSync"

        /** Gap between tag writes, to stay clear of the bus pacing limit. */
        const val SPACING_MS = 400L

        /** How long to wait before re-checking whether a session has ended. */
        const val SESSION_WAIT_MS = 1_500L

        /** Give up waiting for idle after two minutes and write regardless. */
        const val SESSION_WAIT_MAX_MS = 120_000L

        /** Four digits is the whole display. */
        const val MAX_TAG_PRICE = 9999
    }
}
