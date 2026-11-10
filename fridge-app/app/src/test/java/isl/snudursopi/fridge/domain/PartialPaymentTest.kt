package isl.snudursopi.fridge.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class PartialPaymentTest {
    @Test fun `a basket under the limit is charged whole`() {
        assertEquals(2050, PartialPayment.nextCharge(2050, 8000))
    }

    @Test fun `a basket over the limit is charged up to the limit`() {
        assertEquals(8000, PartialPayment.nextCharge(9350, 8000))
        assertEquals(1350, PartialPayment.nextCharge(9350 - 8000, 8000))
    }

    @Test fun `an unknown limit charges what is owed`() {
        assertEquals(9350, PartialPayment.nextCharge(9350, null))
        assertEquals(9350, PartialPayment.nextCharge(9350, 0))
    }

    @Test fun `never more than the reader can carry in one charge`() {
        assertEquals(32_767, PartialPayment.nextCharge(40_000, null))
        assertEquals(32_767, PartialPayment.nextCharge(40_000, 50_000))
    }

    @Test fun `nothing owed charges nothing`() {
        assertEquals(0, PartialPayment.nextCharge(0, 8000))
    }

    @Test fun `outcome says what was collected`() {
        assertEquals("charged", PartialPayment.outcome(9350, 9350))
        assertEquals("partially_paid", PartialPayment.outcome(9350, 8000))
        assertEquals("unpaid", PartialPayment.outcome(9350, 0))
    }
}
