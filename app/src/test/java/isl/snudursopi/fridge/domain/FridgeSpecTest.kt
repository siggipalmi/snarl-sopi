package isl.snudursopi.fridge.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class FridgeSpecTest {

    @Test
    fun singleHasSixteenBasketsAtAddressesZeroToFifteen() {
        val slots = FridgeSpec("GR-WM22Z680", listOf(Cabinet.A), 16).physicalBaskets
        assertEquals(16, slots.size)
        assertEquals(Triple(Cabinet.A, 1, 0), slots.first())
        assertEquals(Triple(Cabinet.A, 16, 15), slots.last())
    }

    @Test
    fun doubleCabinetBStartsAtAddressTwenty() {
        val slots = FridgeSpec("GR-WM22Z1260", listOf(Cabinet.A, Cabinet.B), 32).physicalBaskets
        assertEquals(32, slots.size)
        assertEquals((0..15) + (20..35), slots.map { it.third })
        assertEquals(Triple(Cabinet.B, 1, 20), slots[16])
    }
}
