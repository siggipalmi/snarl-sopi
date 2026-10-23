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
        c.vpos_serial = "0434123456".toByteArray()
        c.monyx_id = "M12345"
        c.currency_code = "352".toByteArray()
        val info = readerInfoOf(c)
        assertEquals("0434123456", info["serial"])
        assertEquals("M12345", info["monyxId"])
        assertEquals("352", info["currency"])
        assertFalse(info.containsKey("merchantId"))
    }
}
