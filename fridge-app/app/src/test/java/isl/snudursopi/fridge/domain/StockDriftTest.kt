package isl.snudursopi.fridge.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The dashboard's count follows the scales between sales and restocks (0.70.15). */
class StockDriftTest {

    private fun basket(n: Int, unitG: Int = 0, byWeight: Boolean = false, product: Boolean = true) = Basket(
        cabinet = Cabinet.A, basket = n, serialLockNum = "", productId = if (product) "p$n" else null,
        name = "P$n", imageUrl = null, priceIsk = 299, unitWeightG = unitG, toleranceG = 15,
        measurementFlag = 1, enabled = product, soldByWeight = byWeight,
    )

    private val bar = basket(14, unitG = 50)
    private val meat = basket(2, byWeight = true)

    @Test fun `479 g of 50 g bars is ten, not zero`() = assertEquals(10, StockDrift.units(bar, 479))

    @Test fun `a negative reading is an empty basket`() = assertEquals(0, StockDrift.units(bar, -12))

    @Test fun `a per-kg basket has no count`() = assertNull(StockDrift.units(meat, 900))

    @Test fun `a basket filled since the last report differs`() {
        val reported = StockDrift.shown(listOf(bar), mapOf(bar.trayIndex to 3))
        val now = StockDrift.shown(listOf(bar), mapOf(bar.trayIndex to 479))
        assertEquals(mapOf(bar.trayIndex to 0), reported)
        assertTrue(StockDrift.differs(reported, now))
    }

    @Test fun `scale jitter inside one item does not differ`() {
        val reported = StockDrift.shown(listOf(bar), mapOf(bar.trayIndex to 479))
        val now = StockDrift.shown(listOf(bar), mapOf(bar.trayIndex to 486))
        assertFalse(StockDrift.differs(reported, now))
    }

    @Test fun `a basket never reported differs`() =
        assertTrue(StockDrift.differs(emptyMap(), StockDrift.shown(listOf(bar), mapOf(bar.trayIndex to 100))))

    @Test fun `per-kg moves in 50 g steps`() {
        val a = StockDrift.shown(listOf(meat), mapOf(meat.trayIndex to 910))
        assertFalse(StockDrift.differs(a, StockDrift.shown(listOf(meat), mapOf(meat.trayIndex to 930))))
        assertTrue(StockDrift.differs(a, StockDrift.shown(listOf(meat), mapOf(meat.trayIndex to 700))))
    }

    @Test fun `unassigned baskets and trays with no reading are left out`() {
        val empty = basket(7, unitG = 50, product = false)
        assertEquals(emptyMap<Int, Int>(), StockDrift.shown(listOf(empty, bar), mapOf(empty.trayIndex to 200)))
    }
}
