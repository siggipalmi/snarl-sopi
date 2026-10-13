package isl.snudursopi.fridge.domain

/**
 * What kind of gravity fridge this machine is, derived ENTIRELY from the
 * model string the backend already knows — there is no separate `machineKind`
 * field (backend contract v5.67).
 *
 *   GR-WM22Z680  -> single: 1 door, cabinet A, 16 baskets
 *   GR-WM22Z1260 -> double: 2 doors, cabinets A + B (both open on one tap),
 *                   32 baskets
 *
 * The backend centralises this in a `fridgeSpec(model)` helper; we mirror the
 * same rule client-side so the app can reason about cabinet count and door
 * behaviour without an extra round-trip. A model that doesn't start with
 * "GR-" is not a fridge at all (this build should never run on one).
 */
enum class Cabinet { A, B }

data class FridgeSpec(
    val model: String,
    val cabinets: List<Cabinet>,
    val basketCount: Int,
    /**
     * Trays per cabinet: 16 on most machines, 10 on 8625060404 (2 per shelf,
     * 5 shelves). NOT readable from the model — that machine is a
     * GR-WM22Z1260 like the 16-tray doubles — so the backend serves it per
     * machine as `fridge.basketsPerCabinet`. Addresses stay in blocks of 20
     * per cabinet either way (A 0.., B 20..).
     */
    val basketsPerCabinet: Int = Planogram.BASKETS_PER_CABINET,
) {
    val isDouble: Boolean get() = cabinets.size > 1

    /**
     * *** ONE LOCK, EVEN ON A DOUBLE. CONFIRMED ON HARDWARE 2026-08-27.
     *
     * A double's two doors are driven by a SINGLE lock and open together — that
     * is the design, not a fault. The WM3.0ZL has a second lock header (锁2) but
     * it is unpopulated on this model.
     *
     * This used to return one index per cabinet, so a double had the app
     * actuating lock 2 as well. Nothing answers there, so restock sat waiting
     * for a door report that could never arrive and kept re-issuing openLock —
     * which put continuous traffic on the bus that also carries the lights and
     * the compressor, and cycled both.
     *
     * The lock index is 1-based to match the vendor GPIO convention.
     */
    val lockIndices: List<Int> get() = listOf(1)

    /**
     * Door numbers this machine may legitimately report, which is NOT the same
     * as the locks it actuates.
     *
     * We drive one lock, but the board is free to report the door state under
     * either cabinet number on a double, and we have not confirmed which it
     * uses. Filtering incoming frames by [lockIndices] would therefore risk
     * discarding a real door-closed report and leaving a customer's session
     * hanging — so accept a frame from any cabinet this machine actually has.
     */
    val doorIndices: List<Int> get() = cabinets.indices.map { it + 1 }

    /**
     * Every basket position this model physically has, as (cabinet, basket 1..16)
     * with its bus address. Used where the hardware matters rather than what is
     * stocked: tare_all on a new machine has no planogram baskets yet, and a
     * basket with no product still has a scale that wants zeroing.
     */
    val physicalBaskets: List<Triple<Cabinet, Int, Int>>
        get() = cabinets.flatMap { c ->
            (1..basketsPerCabinet).map { b ->
                Triple(c, b, c.ordinal * Planogram.ADDRESS_BLOCK_PER_CABINET + (b - 1))
            }
        }

    companion object {
        /**
         * Resolve a spec from a model string, or null if it isn't a GR- fridge.
         * Size is read from the numeric part: models containing "1260" are the
         * double; "680" (and the general single case) are the single. We match
         * on the known suffixes but fall back to single for any other GR- model
         * so a new single-size SKU doesn't break — a double is the exception
         * that must be named explicitly.
         */
        fun fromModel(model: String?, basketsPerCabinet: Int? = null): FridgeSpec? {
            val m = model?.trim().orEmpty()
            if (!m.startsWith("GR-", ignoreCase = true)) return null
            // Only the layouts we have hardware for; anything else is the 16-tray default.
            val per = basketsPerCabinet?.takeIf { it in SUPPORTED_BASKETS_PER_CABINET }
                ?: Planogram.BASKETS_PER_CABINET
            val cabinets = if (m.contains("1260")) listOf(Cabinet.A, Cabinet.B) else listOf(Cabinet.A)
            return FridgeSpec(
                model = m,
                cabinets = cabinets,
                basketCount = cabinets.size * per,
                basketsPerCabinet = per,
            )
        }

        val SUPPORTED_BASKETS_PER_CABINET = setOf(16, 10)
    }
}
