package isl.snudursopi.fridge.data.backend

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class OutOfServiceConfigTest {
    private val mapper = jacksonObjectMapper()

    private fun parse(extra: String) = FridgeConfigParser.parse(
        mapper.readTree("""{"data":{$extra "fridge":{"model":"GR-WM22Z680","baskets":[]}}}"""),
    ).let { assertNotNull(it); it!! }

    @Test
    fun openUnlessTheBackendSaysClosed() {
        assertEquals(false, parse("").outOfService)
        assertEquals(false, parse(""""outOfService":false,""").outOfService)
        assertEquals(true, parse(""""outOfService":true,""").outOfService)
    }

    @Test
    fun reasonIsTrimmedAndOptional() {
        assertEquals("Áfylling í gangi", parse(""""outOfService":true,"outOfServiceReason":"  Áfylling í gangi ",""").outOfServiceReason)
        assertNull(parse(""""outOfService":true,"outOfServiceReason":null,""").outOfServiceReason)
        assertNull(parse(""""outOfService":true,"outOfServiceReason":"   ",""").outOfServiceReason)
    }
}
