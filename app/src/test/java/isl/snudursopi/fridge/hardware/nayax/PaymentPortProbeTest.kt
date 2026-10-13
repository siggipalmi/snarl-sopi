package isl.snudursopi.fridge.hardware.nayax

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PaymentPortProbeTest {

    @Test
    fun `a fresh machine starts on ttyS4 and alternates on silence`() {
        val p = PaymentPortProbe()
        assertTrue(p.probing)
        assertEquals("/dev/ttyS4", p.initial())
        assertEquals("/dev/ttyS1", p.nextAfterTimeout("/dev/ttyS4"))
        assertEquals("/dev/ttyS4", p.nextAfterTimeout("/dev/ttyS1"))
    }

    @Test
    fun `a port that is not a candidate falls back into the rotation`() {
        assertEquals("/dev/ttyS4", PaymentPortProbe().nextAfterTimeout("/dev/ttyS7"))
    }

    @Test
    fun `a confirmed port is sticky through a terminal outage`() {
        val p = PaymentPortProbe(confirmed = "/dev/ttyS1")
        assertFalse(p.probing)
        assertEquals("/dev/ttyS1", p.initial())
        assertEquals("/dev/ttyS1", p.nextAfterTimeout("/dev/ttyS1"))
    }

    @Test
    fun `an explicit port beats a confirmed one and is never probed away from`() {
        val p = PaymentPortProbe(explicit = "/dev/ttyS4", confirmed = "/dev/ttyS1")
        assertEquals("/dev/ttyS4", p.initial())
        assertEquals("/dev/ttyS4", p.nextAfterTimeout("/dev/ttyS4"))
    }

    @Test
    fun `confirm reports only a change`() {
        val p = PaymentPortProbe()
        assertTrue(p.confirm("/dev/ttyS1"))
        assertFalse(p.confirm("/dev/ttyS1"))
        assertTrue(p.confirm("/dev/ttyS4"))
    }

    @Test
    fun `the weight bus is never accepted as a payment port`() {
        val p = PaymentPortProbe()
        assertFalse(p.confirm("/dev/ttyS3"))
        assertFalse(PaymentPortProbe.isValid("/dev/ttyS3"))
        assertFalse(PaymentPortProbe.isValid("/dev/ttyUSB0"))
        assertTrue(PaymentPortProbe.isValid("/dev/ttyS1"))
    }

    @Test
    fun `with the scales on ttyS1 the probe uses ttyS4 and ttyS3 and never ttyS1`() {
        // 8625060404: Nayax on ttyS3, scales on ttyS1.
        val p = PaymentPortProbe(weightPort = "/dev/ttyS1")
        assertEquals(listOf("/dev/ttyS4", "/dev/ttyS3"), p.candidates())
        assertEquals("/dev/ttyS3", p.nextAfterTimeout("/dev/ttyS4"))
        assertEquals("/dev/ttyS4", p.nextAfterTimeout("/dev/ttyS3"))
        assertFalse(p.confirm("/dev/ttyS1"))
        assertTrue(p.confirm("/dev/ttyS3"))
    }

    @Test
    fun `default machines keep the old rotation`() {
        assertEquals(listOf("/dev/ttyS4", "/dev/ttyS1"), PaymentPortProbe().candidates())
    }
}
