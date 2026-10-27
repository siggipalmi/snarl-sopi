package isl.snudursopi.fridge.domain

import isl.snudursopi.fridge.domain.RestockTimer.End
import isl.snudursopi.fridge.domain.RestockTimer.IDLE_MS
import isl.snudursopi.fridge.domain.RestockTimer.MAX_MS
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

    @Test fun `ten still minutes end it - a door left open`() {
        assertNull(RestockTimer.shouldEnd(t0 + IDLE_MS - 1, t0, t0))
        assertEquals(End.IDLE, RestockTimer.shouldEnd(t0 + IDLE_MS, t0, t0))
        assertEquals(End.IDLE, RestockTimer.shouldEnd(t0 + 30 * 60_000, t0, t0 + 20 * 60_000))
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
