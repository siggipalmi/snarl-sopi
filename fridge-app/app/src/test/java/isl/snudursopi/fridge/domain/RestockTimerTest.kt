package isl.snudursopi.fridge.domain

import isl.snudursopi.fridge.domain.RestockTimer.End
import isl.snudursopi.fridge.domain.RestockTimer.IDLE_MS
import isl.snudursopi.fridge.domain.RestockTimer.MAX_MS
import isl.snudursopi.fridge.domain.RestockTimer.UNTOUCHED_MS
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RestockTimerTest {
    private val t0 = 1_000_000L

    @Test fun `someone working keeps the restock open past the old five minutes`() {
        // 25 minutes in, last basket change 3 minutes ago.
        assertNull(RestockTimer.shouldEnd(t0 + 25 * 60_000, t0, t0 + 22 * 60_000))
    }

    @Test fun `ten still minutes after some work end it - a door left open`() {
        val worked = t0 + 60_000
        assertNull(RestockTimer.shouldEnd(worked + IDLE_MS - 1, t0, worked))
        assertEquals(End.IDLE, RestockTimer.shouldEnd(worked + IDLE_MS, t0, worked))
        assertEquals(End.IDLE, RestockTimer.shouldEnd(t0 + 30 * 60_000, t0, t0 + 20 * 60_000))
    }

    // Lava Show, 2026-11-05: unlock at 15:22:38, nobody reached the door in time, the screen sat on
    // "restocking" until the 10-minute rule. Untouched now ends at UNTOUCHED_MS.
    @Test fun `nothing moved since the unlock ends it after the untouched window`() {
        val sent = t0 - 500   // the unlock goes out just before the bolt reports releasing
        assertNull(RestockTimer.shouldEnd(sent + UNTOUCHED_MS - 1, t0, sent, sent))
        assertEquals(End.UNTOUCHED, RestockTimer.shouldEnd(sent + UNTOUCHED_MS, t0, sent, sent))
    }

    @Test fun `a basket change after the unlock means someone is working - not untouched`() {
        val sent = t0 - 500
        assertNull(RestockTimer.shouldEnd(sent + UNTOUCHED_MS + 60_000, t0, t0 + 30_000, sent))
    }

    @Test fun `pressing open again restarts the untouched clock`() {
        val again = t0 + 6 * 60_000
        // Work done before the second press does not count as touching the new unlock...
        assertNull(RestockTimer.shouldEnd(again + UNTOUCHED_MS - 1, t0, t0 + 60_000, again))
        assertEquals(End.UNTOUCHED, RestockTimer.shouldEnd(again + UNTOUCHED_MS, t0, t0 + 60_000, again))
    }

    @Test fun `an hour ends it whatever the scales say`() =
        assertEquals(End.MAX, RestockTimer.shouldEnd(t0 + MAX_MS, t0, t0 + MAX_MS - 1000))

    @Test fun `20 g on any basket is activity, less is noise`() {
        val a = mapOf(0 to 1000, 1 to 500)
        assertFalse(RestockTimer.changed(a, mapOf(0 to 1012, 1 to 495)))
        assertTrue(RestockTimer.changed(a, mapOf(0 to 1000, 1 to 545)))
        assertTrue(RestockTimer.changed(a, mapOf(0 to 960, 1 to 500)))
        assertFalse(RestockTimer.changed(null, a))
    }
}
