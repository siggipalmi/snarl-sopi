package isl.snudursopi.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AdminPinTest {
    // Made by the backend: adminPin.hashPin('482197', salt 00112233445566778899aabbccddeeff, 1000).
    private val fromBackend = AdminPinHash.fromConfig(
        "pbkdf2-sha256", 1000, "ABEiM0RVZneImaq7zN3u/w==", "L6g3yJuTHeQWXStalDHKk6afILrVPr0awx7kVJ4OOW0=",
    )

    @Test fun checksTheBackendsHash() {
        assertTrue(AdminPin.check(fromBackend, "482197"))
        assertFalse(AdminPin.check(fromBackend, "482198"))
        assertFalse(AdminPin.check(fromBackend, AdminPin.SHARED))
    }

    @Test fun noHashMeansTheSharedCode() {
        assertTrue(AdminPin.check(null, "123456"))
        assertFalse(AdminPin.check(null, "482197"))
    }

    @Test fun unknownShapesAreIgnored() {
        assertNull(AdminPinHash.fromConfig("sha1", 1000, "AA==", "AA=="))
        assertNull(AdminPinHash.fromConfig("pbkdf2-sha256", null, "AA==", "AA=="))
        assertNull(AdminPinHash.fromConfig("pbkdf2-sha256", 1000, "not base64!", "AA=="))
    }

    private class MemStore : AdminPinGuard.Store { override var failures = 0; override var lockedUntilMs = 0L }

    @Test fun fiveWrongLockForFiveMinutes() {
        var t = 1_000_000L
        val store = MemStore()
        val g = AdminPinGuard(store) { t }
        repeat(4) { assertFalse(g.failed()) }
        assertEquals(1, g.triesLeft())
        assertTrue(g.failed())
        assertEquals(5 * 60 * 1000L, g.lockedForMs())
        t += 4 * 60 * 1000L
        assertTrue(g.lockedForMs() > 0)
        t += 61 * 1000L
        assertEquals(0L, g.lockedForMs())
        assertEquals(5, g.triesLeft())
        // The lock survives a restart: a new guard on the same store.
        assertFalse(AdminPinGuard(store) { t }.failed())
        assertEquals(4, AdminPinGuard(store) { t }.triesLeft())
    }

    @Test fun successClearsTheCount() {
        val store = MemStore()
        val g = AdminPinGuard(store) { 0L }
        g.failed(); g.failed()
        g.succeeded()
        assertEquals(5, g.triesLeft())
    }
}
