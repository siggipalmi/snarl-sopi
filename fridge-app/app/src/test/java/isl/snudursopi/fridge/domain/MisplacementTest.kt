package isl.snudursopi.fridge.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** An item taken from one basket and put down in another (0.70.11). */
class MisplacementTest {

    private fun basket(
        n: Int,
        price: Int = 500,
        unitG: Int = 0,
        byWeight: Boolean = false,
        product: Boolean = true,
        cab: Cabinet = Cabinet.A,
    ) = Basket(
        cabinet = cab, basket = n, serialLockNum = "", productId = if (product) "p$n" else null,
        name = "P$n", imageUrl = null, priceIsk = price, unitWeightG = unitG, toleranceG = 15,
        measurementFlag = 1, enabled = product, soldByWeight = byWeight,
    )

    private fun plan(vararg b: Basket) = Planogram(spec = Planogram.EMPTY.spec, baskets = b.toList())

    private val sandwich = basket(3, price = 849, unitG = 212)
    private val soda = basket(5, price = 249, unitG = 330)
    private val skyr = basket(1, price = 399, unitG = 288)

    private fun w(vararg p: Pair<Basket, Int>) = p.associate { it.first.trayIndex to it.second }

    @Test
    fun `an item moved to another basket is found, with where it came from`() {
        val p = plan(sandwich, soda)
        val found = Misplacement.detect(p, w(sandwich to 1060, soda to 1650), w(sandwich to 848, soda to 1863))
        val m = found.single()
        assertEquals(soda.trayIndex, m.into.trayIndex)
        assertEquals(sandwich.trayIndex, m.from!!.trayIndex)
        assertEquals(1, m.quantity)
        assertEquals(213, m.gainG)
    }

    @Test
    fun `the charge is unchanged — the moved item is still charged, the heavier basket credits nothing`() {
        val p = plan(sandwich, soda)
        val r = Settlement.settle(p, w(sandwich to 1060, soda to 1650), w(sandwich to 848, soda to 1863))
        assertEquals(849, r.totalIsk)
        assertEquals(sandwich.trayIndex, r.lines.single().basket.trayIndex)
        assertEquals(1, r.misplaced.size)
    }

    @Test
    fun `put back where it came from is nothing`() {
        val p = plan(sandwich, soda)
        assertTrue(Misplacement.detect(p, w(sandwich to 1060, soda to 1650), w(sandwich to 1058, soda to 1652)).isEmpty())
    }

    @Test
    fun `an ordinary purchase is nothing`() {
        val p = plan(sandwich, soda)
        assertTrue(Misplacement.detect(p, w(sandwich to 1060, soda to 1650), w(sandwich to 848, soda to 1650)).isEmpty())
    }

    @Test
    fun `weight added that matches nothing taken has no source`() {
        val p = plan(sandwich, soda)
        val m = Misplacement.detect(p, w(sandwich to 1060, soda to 1650), w(sandwich to 1060, soda to 1790)).single()
        assertNull(m.from)
        assertEquals(140, m.gainG)
    }

    @Test
    fun `noise below the tolerance is not a gain`() {
        val p = plan(sandwich, soda)
        assertTrue(Misplacement.detect(p, w(sandwich to 848, soda to 1650), w(sandwich to 848, soda to 1662)).isEmpty())
    }

    @Test
    fun `took two, put one in the wrong basket`() {
        val p = plan(sandwich, soda)
        val m = Misplacement.detect(p, w(sandwich to 1060, soda to 1650), w(sandwich to 636, soda to 1862)).single()
        assertEquals(sandwich.trayIndex, m.from!!.trayIndex)
        assertEquals(1, m.quantity)
    }

    @Test
    fun `one item cannot explain two heavier baskets`() {
        val p = plan(sandwich, soda, skyr)
        val found = Misplacement.detect(
            p,
            w(sandwich to 1060, soda to 1650, skyr to 2000),
            w(sandwich to 848, soda to 1862, skyr to 2211),
        )
        assertEquals(2, found.size)
        assertEquals(1, found.count { it.from != null })
        assertEquals(1, found.count { it.from == null })
    }

    @Test
    fun `the closest match wins when two products could explain it`() {
        val bar = basket(7, unitG = 205)
        val p = plan(sandwich, bar, soda)
        val m = Misplacement.detect(
            p,
            w(sandwich to 1060, bar to 820, soda to 1650),
            w(sandwich to 848, bar to 615, soda to 1856),
        )
        // 206 g: bar (205) is closer than sandwich (212); the sandwich stays unexplained.
        val moved = m.single()
        assertEquals(bar.trayIndex, moved.from!!.trayIndex)
    }

    @Test
    fun `a per-kg cut put in another basket is matched on its grams`() {
        val ribeye = basket(2, price = 8569, byWeight = true)
        val p = plan(ribeye, soda)
        val m = Misplacement.detect(p, w(ribeye to 3000, soda to 1650), w(ribeye to 2588, soda to 2063)).single()
        assertEquals(ribeye.trayIndex, m.from!!.trayIndex)
    }

    @Test
    fun `an empty, unassigned basket is a destination too`() {
        val empty = basket(9, product = false)
        val p = plan(sandwich, empty)
        val m = Misplacement.detect(p, w(sandwich to 1060, empty to 4), w(sandwich to 848, empty to 216)).single()
        assertEquals(empty.trayIndex, m.into.trayIndex)
        assertEquals(sandwich.trayIndex, m.from!!.trayIndex)
    }

    @Test
    fun `the misplaced tile is marked in the live cart`() {
        val p = plan(sandwich, soda)
        val tiles = isl.snudursopi.fridge.ui.state.FridgeUiState.tentativeTiles(
            p.baskets, w(sandwich to 1060, soda to 1650), w(sandwich to 848, soda to 1863),
            misplacedFrom = setOf(sandwich.trayIndex),
        )
        assertTrue(tiles.single().misplaced)
    }
}
