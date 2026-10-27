package isl.snudursopi.fridge.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Per-kg baskets: grams taken × kr/kg ÷ 1000, rounded up; under 20 g ignored. */
class SellByWeightTest {

    private fun basket(n: Int, price: Int, unitG: Int = 0, byWeight: Boolean = false) = Basket(
        cabinet = Cabinet.B, basket = n, serialLockNum = "", productId = "p$n", name = "P$n",
        imageUrl = null, priceIsk = price, unitWeightG = unitG, toleranceG = 15,
        measurementFlag = 1, enabled = true, soldByWeight = byWeight,
    )

    private fun plan(vararg b: Basket) = Planogram(spec = Planogram.EMPTY.spec, baskets = b.toList())

    @Test
    fun `weight price rounds up to the next krona`() {
        assertEquals(3531, Settlement.weightLineIsk(412, 8569))   // 3530.4
        assertEquals(1865, Settlement.weightLineIsk(700, 2664))   // 1864.8
        assertEquals(3935, Settlement.weightLineIsk(1000, 3935))  // exact stays exact
    }

    @Test
    fun `the mockup basket charges 6194`() {
        val skyr = basket(1, 399, unitG = 288)
        val ribeye = basket(2, 8569, byWeight = true)
        val burgers = basket(3, 2664, byWeight = true)
        val p = plan(skyr, ribeye, burgers)
        val orig = mapOf(skyr.trayIndex to 2000, ribeye.trayIndex to 3000, burgers.trayIndex to 2100)
        val final = mapOf(skyr.trayIndex to 2000 - 576, ribeye.trayIndex to 3000 - 412, burgers.trayIndex to 1400)
        val r = Settlement.settle(p, orig, final)
        assertEquals(6194, r.totalIsk)
        val rib = r.lines.single { it.basket.basket == 2 }
        assertEquals(412, rib.weightG)
        assertEquals(1, rib.quantity)
        assertNull(r.lines.single { it.basket.basket == 1 }.weightG)
        assertEquals(2, r.lines.single { it.basket.basket == 1 }.quantity)
    }

    @Test
    fun `under 20 g is not a purchase`() {
        val meat = basket(5, 4510, byWeight = true)
        val r = Settlement.settle(plan(meat), mapOf(meat.trayIndex to 3000), mapOf(meat.trayIndex to 2981))
        assertTrue(r.nothingTaken)
        assertEquals(0, r.totalIsk)
    }

    @Test
    fun `a pack lifted and put back, or weight added, costs nothing`() {
        val meat = basket(5, 4510, byWeight = true)
        val back = Settlement.settle(plan(meat), mapOf(meat.trayIndex to 3000), mapOf(meat.trayIndex to 3003))
        assertTrue(back.nothingTaken)
        val added = Settlement.settle(plan(meat), mapOf(meat.trayIndex to 3000), mapOf(meat.trayIndex to 3400))
        assertTrue(added.nothingTaken)
    }

    @Test
    fun `a per-kg basket needs a kilo price, not a unit weight, to be sellable`() {
        assertTrue(basket(5, 4510, byWeight = true).sellable)
        assertTrue(!basket(5, 0, byWeight = true).sellable)
        assertTrue(!plan(basket(5, 4510, byWeight = true)).hasWeightGaps)
    }
}
