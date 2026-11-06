package isl.snudursopi.fridge.domain

import kotlin.math.abs

/**
 * When a restock ends, other than the door closing (2026-10-16, Siggi).
 *
 * The old rule was one 5-minute ceiling for everything. At Nordic Hostel a real restock took longer:
 * the machine went back to idle mid-restock and recorded the stock half filled. The two cases a
 * timeout exists for are different and get different limits:
 *
 *  - The bolt never releases (a silent lock, a failed command). Nothing will happen, so give up
 *    after [UNLOCK_WAIT_MS] — the same window the app keeps re-issuing the unlock for.
 *  - The bolt released and someone is working. Follow the scales: the restock lasts until the door
 *    closes, and ends early only if no basket changes for [IDLE_MS] (a door left open), or after
 *    [MAX_MS] whatever happens (a lock that never reports closing).
 */
object RestockTimer {
    const val UNLOCK_WAIT_MS = 2L * 60L * 1000L
    const val IDLE_MS = 10L * 60L * 1000L
    const val MAX_MS = 60L * 60L * 1000L

    /**
     * Nobody touched it (Lava Show, 2026-11-05). The bolt is held for two minutes; an operator who
     * pressed "open" from elsewhere arrives to a locked door, and the board did not report the
     * re-lock — so the screen sat on "restocking" for the full [IDLE_MS] while she pulled at the
     * door. With no basket change since the last unlock was sent, the restock ends after the hold
     * plus two minutes' grace, and records nothing.
     */
    const val UNTOUCHED_MS = 4L * 60L * 1000L

    /** A change this large on any basket counts as someone working (the same 20 g as a sale). */
    const val ACTIVITY_G = 20

    enum class End { UNTOUCHED, IDLE, MAX }

    /**
     * Pure: should an open restock end now? null = keep waiting for the door to close.
     *
     * [unlockedAtMs] is when the bolt first released; [lastUnlockSentMs] is when the unlock was last
     * sent (a repeated "open" press sends it again and restarts the untouched clock). Activity at or
     * before [lastUnlockSentMs] does not count as someone working.
     */
    fun shouldEnd(nowMs: Long, unlockedAtMs: Long, lastActivityMs: Long, lastUnlockSentMs: Long = unlockedAtMs): End? = when {
        nowMs - unlockedAtMs >= MAX_MS -> End.MAX
        lastActivityMs <= lastUnlockSentMs && nowMs - lastUnlockSentMs >= UNTOUCHED_MS -> End.UNTOUCHED
        nowMs - maxOf(lastActivityMs, unlockedAtMs) >= IDLE_MS -> End.IDLE
        else -> null
    }

    /** Pure: did any basket change by at least [ACTIVITY_G] between two reads? */
    fun changed(prev: Map<Int, Int>?, cur: Map<Int, Int>?): Boolean {
        if (prev == null || cur == null) return false
        return cur.any { (tray, g) -> prev[tray]?.let { abs(g - it) >= ACTIVITY_G } == true }
    }
}
