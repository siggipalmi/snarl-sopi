package isl.snudursopi.fridge.data.backend

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class ReceiptConfigTest {
    private val mapper = jacksonObjectMapper()

    private fun parse(extra: String) = FridgeConfigParser.parse(
        mapper.readTree("""{"data":{$extra "fridge":{"model":"GR-WM22Z680","baskets":[]}}}"""),
    ).let { assertNotNull(it); it!! }

    @Test
    fun receiptsOnWhenTheBackendSaysSo() {
        assertEquals(true, parse(""""receipts":{"enabled":true},""").receiptsEnabled)
    }

    @Test
    fun receiptsOffWhenAbsentNullOrFalse() {
        assertEquals(false, parse("").receiptsEnabled)
        assertEquals(false, parse(""""receipts":null,""").receiptsEnabled)
        assertEquals(false, parse(""""receipts":{"enabled":false},""").receiptsEnabled)
    }
}
