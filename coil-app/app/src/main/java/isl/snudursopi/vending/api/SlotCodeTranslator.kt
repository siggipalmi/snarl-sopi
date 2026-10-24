package isl.snudursopi.vending.api

/**
 * Translates between our friendly slot IDs (A1, A35, A69) and Weimi's
 * aisleCode format (0-A01, 0-C05, 0-F09).
 */
object SlotCodeTranslator {
    /**
     * Weimi encodes the column zero-based ("0-E00" is column 1), so this is
     * TRUE for every machine we run.
     *
     * It defaults to true deliberately. It used to default to false and was
     * flipped inside ProductMapping.toProducts() — which meant that between
     * process start and the first Weimi product fetch, decoding was wrong:
     * "0-E00" resolved to column 0, failed the 1..9 check, and returned null.
     * ConfigClient drops nulls when it parses hardware.disabledAisles, so a
     * config poll landing in that window silently produced an EMPTY closed-lane
     * set and every lane the operator had closed went back on sale. First boot
     * of a newly provisioned machine sits squarely in that window.
     */
    var columnBaseZero: Boolean = true
    private const val DEFAULT_CABINET = 0

    /**
     * Lanes per row, keyed by row number. Rows absent from the map fall back to
     * [DEFAULT_LANES].
     *
     * Rows are NOT all the same width. Faxatorg (62160491) has 9 lanes on rows
     * 1–4 and 7 on rows 5–6 — 50 channels, which is exactly what deviceInfo
     * reports for it. Because the column is reversed, the row width is part of
     * the address: with 9 assumed on a 7-wide row, bay 66 was addressed as raw
     * 53, which is bay 64, and bays 61/67 resolved to raw indexes the board
     * rejects outright as open circuits.
     *
     * Populated from the Weimi aisle list at catalog load — see
     * [learnRowWidths]. Derived from the machine rather than configured, so a
     * mis-set backend field can't silently vend the wrong lane.
     */
    @Volatile
    var lanesPerRow: Map<Int, Int> = emptyMap()
        private set

    private const val DEFAULT_LANES = 9

    fun lanesIn(row: Int): Int = lanesPerRow[row] ?: DEFAULT_LANES

    /**
     * Derive row widths from the machine's own aisle codes (Weimi format,
     * "0-E00"). Call once per catalog load, before any dispense.
     */
    fun learnRowWidths(apiCodes: Collection<String>) {
        val widest = mutableMapOf<Int, Int>()
        for (code in apiCodes) {
            val parts = code.split("-")
            if (parts.size != 2) continue
            val body = parts[1]
            if (body.length < 2) continue
            val letter = body[0].uppercaseChar()
            if (letter !in 'A'..'F') continue
            val colNumber = body.substring(1).toIntOrNull() ?: continue
            val row = letter - 'A' + 1
            val col = if (columnBaseZero) colNumber + 1 else colNumber
            if (col < 1) continue
            widest[row] = maxOf(widest[row] ?: 0, col)
        }
        if (widest.isNotEmpty()) {
            lanesPerRow = widest.toMap()
            android.util.Log.i(
                "SlotCodeTranslator",
                "learned row widths from ${apiCodes.size} aisle codes: " +
                    widest.toSortedMap().map { (r, n) -> "row$r=$n" }.joinToString(" "),
            )
        } else {
            android.util.Log.w(
                "SlotCodeTranslator",
                "learned NO row widths from ${apiCodes.size} aisle codes — " +
                    "falling back to $DEFAULT_LANES per row. Sample: " +
                    apiCodes.take(6).joinToString(","),
            )
        }
    }

    fun toApiCode(slot: String, cabinet: Int = DEFAULT_CABINET): String? {
        val (row, col) = parseSlot(slot) ?: return null
        val letter = 'A' + (row - 1)
        val colNumber = if (columnBaseZero) col - 1 else col
        return "$cabinet-$letter${colNumber.toString().padStart(2, '0')}"
    }

    fun fromApiCode(apiCode: String): String? {
        val parts = apiCode.split("-")
        if (parts.size != 2) return null
        val codePart = parts[1]
        if (codePart.length < 2) return null
        val letter = codePart[0].uppercaseChar()
        if (letter !in 'A'..'F') return null
        val colNumber = codePart.substring(1).toIntOrNull() ?: return null
        val row = letter - 'A' + 1
        val col = if (columnBaseZero) colNumber + 1 else colNumber
        if (col !in 1..lanesIn(row)) return null
        return if (row == 1) "A$col" else "A$row$col"
    }

    /**
     * Accept an aisle code in EITHER format and return the canonical friendly,
     * uppercased form ("A3"), or null. The backend may send Weimi API codes
     * ("0-A03") or already-friendly codes ("A3"/"a3"); the kiosk matches against
     * friendly [Product.slot], so everything funnels through here. Being tolerant
     * of both avoids a brittle cross-system string contract.
     */
    fun normalize(code: String): String? {
        val c = code.trim()
        if (c.isEmpty()) return null
        return if (c.contains("-")) fromApiCode(c)?.uppercase() else c.uppercase()
    }

    /**
     * Friendly slot ("A35") → the RAW slot index to pass to
     * MotorInstruct.setShipments. The motor board itself applies the
     * raw→physical-coil mapping, so we must pass the RAW index (NOT the coil) —
     * passing a coil double-converts and turns the wrong slot.
     *   raw = (row-1)*10 + (col-1)     (row1 = A1..A9, rowN = A{N}{col})
     * In STIG tests we typed these raw numbers directly and the right coil
     * turned. Verify end-to-end: A26→raw15, A37→raw26, A25→raw14.
     */
    fun friendlyToRaw(slot: String): Int? {
        if (!slot.startsWith("A")) return null
        val digits = slot.substring(1)
        val (row, col) = when (digits.length) {
            1 -> 1 to (digits.toIntOrNull() ?: return null)
            2 -> (digits[0].digitToIntOrNull() ?: return null) to
                 (digits[1].digitToIntOrNull() ?: return null)
            else -> return null
        }
        val lanes = lanesIn(row)
        if (row !in 1..6 || col !in 1..lanes) return null
        // Column is REVERSED relative to raw indexing: the board counts from the
        // right, so col C maps to raw position (lanes - C), NOT (C - 1).
        // The width matters. Measured at Faxatorg on a 7-wide row: bay 66 →
        // raw 51, 65 → 52, 64 → 53, 63 → 54, i.e. raw = 50 + (7 - col).
        return (row - 1) * 10 + (lanes - col)
    }

    /**
     * RAW slot index → the friendly slot ("A35"). Exact inverse of
     * [friendlyToRaw], including the reversed column: raw = (row-1)*10 + (9-col),
     * so row = raw/10 + 1 and col = 9 - (raw%10).
     *
     * Used to LABEL a dispense we already performed (the diagnostics log). It is
     * never used to pick a slot to vend — that direction stays [friendlyToRaw],
     * so a bug here can misname a log line but can never turn the wrong coil.
     */
    fun rawToFriendly(raw: Int): String? {
        if (raw < 0) return null
        val row = raw / 10 + 1
        if (row !in 1..6) return null
        val lanes = lanesIn(row)
        val col = lanes - (raw % 10)
        if (col !in 1..lanes) return null
        return if (row == 1) "A$col" else "A$row$col"
    }

    private fun parseSlot(slot: String): Pair<Int, Int>? {
        if (!slot.startsWith("A")) return null
        val digits = slot.substring(1)
        return when (digits.length) {
            1 -> {
                val col = digits.toIntOrNull() ?: return null
                if (col !in 1..9) return null
                1 to col
            }
            2 -> {
                val row = digits[0].digitToIntOrNull() ?: return null
                val col = digits[1].digitToIntOrNull() ?: return null
                if (row !in 2..6 || col !in 1..9) return null
                row to col
            }
            else -> null
        }
    }
}
