package isl.snudursopi.fridge

import isl.snudursopi.fridge.domain.LightPolicy
import isl.snudursopi.fridge.domain.Lighting
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

class LightingTest {
    private val zone = ZoneId.of("Atlantic/Reykjavik")
    private fun at(h: Int, m: Int = 0) = ZonedDateTime.of(2026, 10, 2, h, m, 0, 0, zone).toInstant().toEpochMilli()
    private val night = LightPolicy.NightWindow(LocalTime.of(22, 0), LocalTime.of(8, 0), 0, zone)
    private val sched = LightPolicy(mode = "schedule", night = night)

    @Test fun `on by default`() = assertTrue(Lighting.decide(LightPolicy(), at(12), true, false).on)

    @Test fun `mode off is dark`() = assertFalse(Lighting.decide(LightPolicy(mode = "off"), at(12), true, false).on)

    @Test fun `brightness 0 is off, anything above is on`() {
        assertFalse(Lighting.decide(LightPolicy(brightness = 0), at(12), true, false).on)
        assertTrue(Lighting.decide(LightPolicy(brightness = 5), at(12), true, false).on)
    }

    @Test fun `a window that wraps midnight applies on both sides of it`() {
        assertFalse(Lighting.decide(sched, at(23), true, false).on)
        assertFalse(Lighting.decide(sched, at(3), true, false).on)
        assertFalse(Lighting.decide(sched, at(7, 59), true, false).on)
        assertTrue(Lighting.decide(sched, at(8), true, false).on)
        assertTrue(Lighting.decide(sched, at(21, 59), true, false).on)
        assertFalse(Lighting.decide(sched, at(22), true, false).on)
    }

    @Test fun `a window that does not wrap`() {
        val day = sched.copy(night = night.copy(from = LocalTime.of(1, 0), to = LocalTime.of(5, 0)))
        assertFalse(Lighting.decide(day, at(2), true, false).on)
        assertTrue(Lighting.decide(day, at(6), true, false).on)
    }

    @Test fun `no night window until the clock is proven`() {
        val d = Lighting.decide(sched, at(3), clockProven = false, customerHere = false)
        assertTrue(d.on)
        assertEquals("day level until the clock is proven", d.reason)
    }

    @Test fun `a customer lights it even when off or at night`() {
        assertTrue(Lighting.decide(LightPolicy(mode = "off"), at(12), true, customerHere = true).on)
        assertTrue(Lighting.decide(sched, at(3), true, customerHere = true).on)
        val noWake = LightPolicy(mode = "off", wake = LightPolicy.Wake(enabled = false))
        assertFalse(Lighting.decide(noWake, at(12), true, customerHere = true).on)
    }

    @Test fun `the night window only applies in schedule mode`() =
        assertTrue(Lighting.decide(LightPolicy(mode = "on", night = night), at(3), true, false).on)
}
