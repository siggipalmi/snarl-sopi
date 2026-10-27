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

    /** A change this large on any basket counts as someone working (the same 20 g as a sale). */
    const val ACTIVITY_G = 20

    enum class End { IDLE, MAX }

    /** Pure: should an open restock end now? null = keep waiting for the door to close. */
    fun shouldEnd(nowMs: Long, unlockedAtMs: Long, lastActivityMs: Long): End? = when {
        nowMs - unlockedAtMs >= MAX_MS -> End.MAX
        nowMs - maxOf(lastActivityMs, unlockedAtMs) >= IDLE_MS -> End.IDLE
        else -> null
    }

    /** Pure: did any basket change by at least [ACTIVITY_G] between two reads? */
    fun changed(prev: Map<Int, Int>?, cur: Map<Int, Int>?): Boolean {
        if (prev == null || cur == null) return false
        return cur.any { (tray, g) -> prev[tray]?.let { abs(g - it) >= ACTIVITY_G } == true }
    }
}
