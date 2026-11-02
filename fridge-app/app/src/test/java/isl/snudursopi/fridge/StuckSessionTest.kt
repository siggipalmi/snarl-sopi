package isl.snudursopi.fridge

import isl.snudursopi.fridge.ui.state.FridgePhase
import isl.snudursopi.fridge.ui.state.StuckSession
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StuckSessionTest {
    private val stuck = StuckSession.STUCK_MS
    private val fresh = 30_000L

    @Test fun `a live customer blocks commands`() {
        assertTrue(StuckSession.blocksCommands(FridgePhase.SHOPPING, fresh))
        assertTrue(StuckSession.blocksCommands(FridgePhase.COMPLAINT, fresh))
    }

    @Test fun `a stuck screen no longer blocks commands`() {
        FridgePhase.values().forEach { assertFalse(it.name, StuckSession.blocksCommands(it, stuck)) }
    }

    @Test fun `idle and restock never block or count as stuck`() {
        listOf(FridgePhase.IDLE, FridgePhase.RESTOCK).forEach {
            assertFalse(StuckSession.blocksCommands(it, fresh))
            assertFalse(StuckSession.isStuck(it, stuck * 10))
            assertFalse(StuckSession.mayReturnToIdle(it, stuck * 10))
        }
    }

    @Test fun `screens after the payment return to idle once stuck`() {
        listOf(
            FridgePhase.RECEIPT, FridgePhase.PENDING_OFFLINE, FridgePhase.COMPLAINT,
            FridgePhase.COMPLAINT_DONE, FridgePhase.RECEIPT_EMAIL, FridgePhase.DECLINED,
        ).forEach {
            assertTrue(it.name, StuckSession.mayReturnToIdle(it, stuck))
            assertFalse(it.name, StuckSession.mayReturnToIdle(it, fresh))
        }
    }

    @Test fun `screens during a payment are never reset`() {
        listOf(
            FridgePhase.AUTHORIZING, FridgePhase.UNLOCKED, FridgePhase.SHOPPING,
            FridgePhase.DOOR_OPEN_WARN, FridgePhase.CALCULATING,
        ).forEach { assertFalse(it.name, StuckSession.mayReturnToIdle(it, stuck * 10)) }
    }
}
