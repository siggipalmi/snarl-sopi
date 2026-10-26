package isl.snudursopi.fridge.hardware

import com.bitmick.marshall.vmc.vmc_link
import isl.snudursopi.fridge.hardware.nayax.bytesText
import isl.snudursopi.fridge.hardware.nayax.readerInfoOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class ReaderInfoTest {
    @Test fun asciiWithTrailingZerosReadsAsText() {
        assertEquals("0434123456", bytesText("0434123456".toByteArray() + byteArrayOf(0, 0)))
    }

    @Test fun binaryReadsAsHex() {
        assertEquals("01ff", bytesText(byteArrayOf(1, -1)))
    }

    @Test fun emptyIsNull() {
        assertNull(bytesText(null))
        assertNull(bytesText(byteArrayOf(0, 0)))
    }

    @Test fun handshakeFieldsAreNamed() {
        val c = vmc_link.vpos_config_t()
        // As 8626020715's reader sent them (2026-10-26); Nayax Core lists 0434334925281436.
        c.vpos_serial = "6341825294334340".toByteArray()
        c.monyx_id = "M12345"
        c.country_code = byteArrayOf(0x60, 0x01)
        c.currency_code = byteArrayOf(0x60, 0x01)
        val info = readerInfoOf(c)
        assertEquals("0434334925281436", info["serial"])
        assertEquals("M12345", info["monyxId"])
        assertEquals("352", info["country"])
        assertEquals("352", info["currency"])
        assertEquals("2", info["v"])
        assertFalse(info.containsKey("merchantId"))
    }
}
