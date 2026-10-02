package isl.snudursopi.fridge

import isl.snudursopi.fridge.domain.IdleRotation.posterAt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IdleRotationTest {
    private val anim = 18_000L
    private val two = listOf(8_000L, 5_000L)

    @Test fun `no posters means the animation always`() = assertNull(posterAt(60_000, emptyList()))

    @Test fun `inside the idle timeout is the animation`() = assertNull(posterAt(-1, two))

    @Test fun `animation first, then each poster in turn`() {
        assertNull(posterAt(0, two, anim))
        assertNull(posterAt(anim - 1, two, anim))
        assertEquals(0, posterAt(anim, two, anim))
        assertEquals(0, posterAt(anim + 7_999, two, anim))
        assertEquals(1, posterAt(anim + 8_000, two, anim))
        assertEquals(1, posterAt(anim + 12_999, two, anim))
    }

    @Test fun `and round again`() {
        val cycle = anim + 13_000
        assertNull(posterAt(cycle, two, anim))
        assertEquals(0, posterAt(cycle + anim, two, anim))
    }
}
