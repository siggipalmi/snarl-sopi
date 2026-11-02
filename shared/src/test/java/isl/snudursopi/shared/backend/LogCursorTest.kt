package isl.snudursopi.shared.backend

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LogCursorTest {
    private val header = "--------- beginning of main"
    private fun poll(t: String) = "11-01 $t.104 I/FridgeBackend( 4321): config poll: no change"

    @Test fun `the first read keeps everything but the header`() =
        assertEquals(listOf(poll("23:47:12"), poll("23:48:12")),
            LogCursor.after(listOf(header, poll("23:47:12"), "", poll("23:48:12")), ""))

    @Test fun `lines after the last shipped one are new, and the header never ships`() =
        assertEquals(listOf(poll("23:48:12"), poll("23:49:12")),
            LogCursor.after(listOf(header, poll("23:46:12"), poll("23:47:12"), poll("23:48:12"), poll("23:49:12")), poll("23:47:12")))

    @Test fun `a header after the cut is dropped too`() =
        assertEquals(listOf(poll("23:48:12")),
            LogCursor.after(listOf(poll("23:47:12"), "--------- beginning of system", poll("23:48:12")), poll("23:47:12")))

    /**
     * Blue Hotel, 2026-11-01: `-t 400` reached back only to 23:48:30, after the 23:48:12 line
     * that followed the last shipped one. The old cut shipped the window as it was, so 23:48:12
     * vanished and the header showed up in the batch. Now that is "not found", not "all new".
     */
    @Test fun `a read that no longer reaches the last shipped line is not found`() =
        assertNull(LogCursor.after(listOf(header, poll("23:48:30"), poll("23:49:12")), poll("23:47:12")))

    @Test fun `the first of two identical lines is the cut, so a repeat is duplicated, not lost`() {
        val l = poll("23:47:12")
        assertEquals(listOf(l, poll("23:48:12")), LogCursor.after(listOf(l, l, poll("23:48:12")), l))
    }

    @Test fun `the time read starts a minute early`() {
        assertEquals("11-01 23:47:00.000", LogCursor.sinceArg(poll("23:48:12")))
        assertEquals("11-01 23:47:00.000", LogCursor.sinceArg("11-01 23:48:00.000 I/X( 1): edge"))
    }

    @Test fun `the minute before the hour is in the previous hour`() =
        assertEquals("11-02 00:59:00.000", LogCursor.sinceArg("11-02 01:00:05.000 I/X( 1): m"))

    @Test fun `the first minute of a day, or no timestamp, falls back to a count read`() {
        assertNull(LogCursor.sinceArg("11-02 00:00:41.000 I/X( 1): m"))
        assertNull(LogCursor.sinceArg("garbage"))
    }

    @Test fun `a flush within the cap is untouched`() {
        val lines = List(3) { poll("23:4$it:12") }
        assertEquals(lines, LogCursor.cap(lines, 3) { "note: $it" })
    }

    @Test fun `a flush over the cap keeps the newest and says how many were dropped, note first`() {
        val lines = List(5) { poll("23:4$it:12") }
        val out = LogCursor.cap(lines, 3) { "note: $it" }
        assertEquals(4, out.size)
        assertEquals("note: 2 older lines not relayed (more than 3 since the last batch)", out.first())
        assertEquals(lines.takeLast(3), out.drop(1))
        assertEquals(lines.last(), out.last())
    }
}
