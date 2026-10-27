package isl.snudursopi.shared.backend

import isl.snudursopi.shared.backend.PaymentStatusReporter.Companion.HEARTBEAT_MS
import isl.snudursopi.shared.backend.PaymentStatusReporter.Companion.shouldPost
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PaymentStatusReporterTest {
    private val up = PaymentLinkStatus(true, "/dev/ttyS4", 1_000L)
    private val down = PaymentLinkStatus(false, "/dev/ttyS4", 1_000L)

    @Test fun `the first sample is always posted`() = assertTrue(shouldPost(null, down, 0, 0))

    @Test fun `a change is posted at once`() {
        assertTrue(shouldPost(up, down, lastPostMs = 100, now = 101))
        assertTrue(shouldPost(down, up, lastPostMs = 100, now = 101))
    }

    @Test fun `a port change is posted at once`() =
        assertTrue(shouldPost(down, down.copy(port = "/dev/ttyS1"), 100, 101))

    @Test fun `a decimal-place change is posted at once`() {
        assertTrue(shouldPost(up, up.copy(decimalPlace = 2), 100, 101))
        assertTrue(shouldPost(up.copy(decimalPlace = 2), up.copy(decimalPlace = 0), 100, 101))
        assertFalse(shouldPost(up.copy(decimalPlace = 0), up.copy(decimalPlace = 0), 100, 101))
    }

    @Test fun `no change is quiet until the heartbeat`() {
        assertFalse(shouldPost(down, down, lastPostMs = 0, now = HEARTBEAT_MS - 1))
        assertTrue(shouldPost(down, down, lastPostMs = 0, now = HEARTBEAT_MS))
    }
}
