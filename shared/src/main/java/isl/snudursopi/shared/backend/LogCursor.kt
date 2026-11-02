package isl.snudursopi.shared.backend

import java.util.Locale

/**
 * The pure part of the log relay: given what `logcat` printed and the last line already
 * shipped, which lines are new.
 *
 * *** WHY THIS EXISTS (Blue Hotel 8626020716, fridge 0.70.6, 2026-11-01/02). The relay used
 * to read `logcat -d -t 400 <tag filters>` and drop everything up to the last line it had
 * shipped. About one line per 5-minute batch went missing, always at a batch boundary, and
 * every batch in the dashboard started with `--------- beginning of main`.
 *
 * That header is the giveaway. It is the first line logcat prints, so whenever the cut finds
 * the last shipped line, the header lies BEFORE it and is dropped. A header in every batch
 * means the cut found nothing, every time. The reason: `-t 400` is counted by logd over
 * everything the app wrote, BEFORE logcat applies the tag filters — the tray weights, the
 * poll timing and the payment SDK's frames are silenced in the filter but still use up the
 * 400. The app writes more than 400 lines in five minutes, so the window reached back less
 * than five minutes, the previous batch's last line had already scrolled out, and the lines
 * between it and the start of the window (a `config poll: no change`, an OtaScheduler
 * outcome) were never read at all.
 *
 * So the read is now by TIME, from just before the last shipped line, which the tag filter
 * cannot shrink; a cut that still finds nothing is retried with a deep count read, and if
 * the line is gone even then (buffer wrapped, clock moved) the batch says so instead of
 * hiding the gap.
 */
object LogCursor {

    /** logcat's `--------- beginning of main` / `system` / `crash`: structure, not log. */
    fun isHeader(line: String): Boolean = line.startsWith("--------- ")

    /**
     * The log lines in [all] after [lastSeen], headers and blanks removed. With no [lastSeen]
     * (first read since start) everything is new. Returns null when [lastSeen] is not in
     * [all]: the read did not reach back far enough, and shipping what it did return would
     * silently skip whatever lies between.
     *
     * The FIRST occurrence is used: two identical lines in the same millisecond then cost a
     * duplicate, never a loss.
     */
    fun after(all: List<String>, lastSeen: String): List<String>? {
        val lines = all.filter { it.isNotBlank() && !isHeader(it) }
        if (lastSeen.isBlank()) return lines
        val i = lines.indexOf(lastSeen)
        return if (i < 0) null else lines.drop(i + 1)
    }

    private val STAMP = Regex("""^(\d\d)-(\d\d) (\d\d):(\d\d):\d\d\.\d{3}""")

    /**
     * The `-t '<time>'` argument for a read that is sure to include [lastSeen]: the start of
     * the minute BEFORE its timestamp (`-v time` format, "MM-DD hh:mm:ss.mmm"). A whole minute
     * early so it does not matter whether logd treats the bound as inclusive, nor how it
     * orders lines logged in the same instant; [after] cuts the overlap. Null when the line
     * has no timestamp, or for a line from the first minute of a day (rolling the date back
     * is not worth it — the caller falls back to a count read).
     */
    fun sinceArg(lastSeen: String): String? {
        val m = STAMP.find(lastSeen) ?: return null
        val (mo, d, h, mi) = m.destructured
        var hour = h.toInt()
        var minute = mi.toInt() - 1
        if (minute < 0) { minute = 59; hour -= 1 }
        if (hour < 0) return null
        return String.format(Locale.ROOT, "%s-%s %02d:%02d:00.000", mo, d, hour, minute)
    }

    /**
     * Caps one flush at [max] lines, keeping the newest, and says so in the log when lines
     * are dropped rather than leaving an unexplained gap. [note] turns a message into a line
     * in the relay's own format. The note goes first, so the last line is always a real
     * logcat line — the one the next read cuts on.
     */
    fun cap(fresh: List<String>, max: Int, note: (String) -> String): List<String> =
        if (fresh.size <= max) fresh
        else listOf(note("${fresh.size - max} older lines not relayed (more than $max since the last batch)")) +
            fresh.takeLast(max)
}
