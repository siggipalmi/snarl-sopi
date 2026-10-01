package isl.snudursopi.fridge.data.backend

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingClientTest {

    @Test
    fun `a 200 with an identity pairs`() {
        val r = PairingClient.parse(
            200,
            """{"ok":true,"data":{"deviceCode":"8626020715","machineKey":"k-123"}}""",
        )
        assertEquals(PairResult.Paired("8626020715", "k-123"), r)
    }

    @Test
    fun `the key never appears in toString`() {
        val s = PairResult.Paired("8626020715", "secret-key").toString()
        assertFalse(s.contains("secret-key"))
        assertTrue(s.contains("8626020715"))
    }

    @Test
    fun `404 is an invalid code and 429 is rate limited`() {
        assertEquals(PairResult.InvalidCode, PairingClient.parse(404, """{"ok":false,"error":"invalid_code"}"""))
        assertEquals(PairResult.RateLimited, PairingClient.parse(429, null))
    }

    @Test
    fun `a 200 missing either field is a failure, not a half identity`() {
        assertTrue(PairingClient.parse(200, """{"ok":true,"data":{"deviceCode":"8626020715"}}""") is PairResult.Failed)
        assertTrue(PairingClient.parse(200, """{"ok":true,"data":{"deviceCode":"","machineKey":"k"}}""") is PairResult.Failed)
        assertTrue(PairingClient.parse(200, "not json") is PairResult.Failed)
    }

    @Test
    fun `other statuses fail with the status`() {
        assertEquals(PairResult.Failed("HTTP 500"), PairingClient.parse(500, "boom"))
    }

    @Test
    fun `only six digits are well formed`() {
        assertTrue(PairingClient.isWellFormed("012345"))
        assertFalse(PairingClient.isWellFormed("12345"))
        assertFalse(PairingClient.isWellFormed("1234567"))
        assertFalse(PairingClient.isWellFormed("12a456"))
    }
}
