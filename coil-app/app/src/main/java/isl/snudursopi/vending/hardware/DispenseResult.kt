package isl.snudursopi.vending.hardware

/**
 * Interpretation of a dispense (`setShipments`) reply from the WM3.0DJ
 * control board.
 *
 * ## Fleet decision: drop sensors are disabled
 *
 * These machines have an infrared drop sensor across the delivery chute,
 * but it has a proven failure mode: small items fall through without
 * breaking the beam, the board reads "no drop," reports a vend failure,
 * and **closes the slot** — so a successful vend is recorded as a fault,
 * the customer keeps the item for free, and the slot is dead until
 * serviced. Because of this, drop sensors are being disabled fleet-wide.
 *
 * Consequence for interpretation: we judge a vend on the **motor-
 * mechanical** axis only — did the coil motor complete its rotation? —
 * and we deliberately **ignore drop-detection outcomes**. We never treat
 * a "no drop detected" code as a failure, and we never close a slot on
 * one. The motor either turned or it didn't; that is our success signal.
 *
 * The trade-off (accepted): the machine cannot confirm a product
 * physically fell. A genuine mechanical success that nonetheless failed
 * to deliver (rare jam that still completed rotation, mis-load) is
 * invisible to the hardware and is caught only by the customer complaint
 * flow. That is the agreed safety net.
 *
 * ## Frame format (confirmed on real hardware, ttyS1 @ 9600)
 *
 * A dispense reply (`cmd == INSTRUCT_SHIPMENTS`, opcode 0x28) is an
 * ASCII-hex string. Per the SDK doc the meaningful fields are at fixed
 * substring offsets:
 *   - shipmentResult: chars [34, 36)
 *   - board address:  chars [4, 12)
 *   - orderId:        chars [18, 34)
 *
 * Real success frame seen on the bench (spiral 8, motor turned):
 *   FF010000000028000900000000000000000000...  → result byte 0x00
 *
 * The doc warns return codes vary by machine model ("请根据厂商提供的型号
 * 参考对照表" — refer to the manufacturer's per-model table), so we
 * classify by *category* rather than asserting every code, and anything
 * unrecognized is treated conservatively as [Outcome.UNKNOWN].
 */
data class DispenseResult(
    val outcome: Outcome,
    /** Raw shipmentResult byte (e.g. 0x00), or null if it couldn't be parsed. */
    val resultCode: Int?,
    /** The orderId echoed back by the board, if present. */
    val orderId: String?,
    /** Human-readable explanation for logs/diagnostics. */
    val detail: String,
) {
    enum class Outcome {
        /** Motor completed its turn. We treat this as a successful vend. */
        VENDED,

        /**
         * Motor did not turn / no motor / jam / stall — a genuine
         * mechanical failure where the product definitely did not come
         * out. Safe to NOT charge / to refund / to retry.
         */
        MOTOR_FAILED,

        /**
         * Duplicate or unknown order reference. Not a vend — a protocol
         * bookkeeping reply. Caller should not treat as success or as a
         * mechanical failure; usually means "this order was already
         * handled, don't re-send."
         */
        ORDER_REJECTED,

        /** Frame unparseable or code not in our table. Treat with caution. */
        UNKNOWN,

        /**
         * The board sent NO ack at all (dispense timed out). This is NOT a
         * successful vend — the board didn't even respond, which almost
         * always means the dispense did not happen (bad/empty slot, no motor,
         * comms issue). MUST be treated as a failure → void/refund. Never
         * capture a charge on NO_RESPONSE.
         */
        NO_RESPONSE,
    }

    companion object {
        /**
         * Parse a raw dispense-ack hex string into a [DispenseResult].
         *
         * Pure function, no Android dependencies, so it can be unit-tested.
         */
        fun parse(data: String?): DispenseResult {
            if (data.isNullOrBlank() || data.length < 36) {
                return DispenseResult(
                    Outcome.UNKNOWN, null, null,
                    "frame too short to parse (len=${data?.length ?: 0})",
                )
            }

            val orderId = runCatching { data.substring(18, 34) }.getOrNull()

            val code = runCatching { data.substring(34, 36).toInt(16) }.getOrNull()
                ?: return DispenseResult(
                    Outcome.UNKNOWN, null, orderId,
                    "could not read shipmentResult byte at [34,36)",
                )

            val (outcome, detail) = classify(code)
            return DispenseResult(outcome, code, orderId, detail)
        }

        /**
         * Map a shipmentResult code to an outcome on the MOTOR axis only.
         *
         * Key rule: codes whose meaning is "motor completed but no
         * drop detected" are classified as [Outcome.VENDED], NOT as a
         * failure — because the drop sensor is disabled and its readings
         * are not trusted. We only call a vend failed when the *motor*
         * demonstrably did not complete (no motor, stall, jam).
         *
         * Codes are from the WM22/WM55 table in the SDK doc. Where a code
         * is explicitly "motor worked" we map to VENDED regardless of any
         * infrared remark.
         */
        private fun classify(code: Int): Pair<Outcome, String> = when (code) {
            // --- motor completed successfully ---
            0x00 -> Outcome.VENDED to "motor ok, completed (0x00)"
            0x13 -> Outcome.VENDED to "motor turned half-turn, item dropped (0x13)"
            0x19 -> Outcome.VENDED to "motor turned two turns, dropped — vend ok (0x19)"
            0x09 -> Outcome.VENDED to "motor >1 turn, drop detected (0x09)"
            0x10 -> Outcome.VENDED to "motor completed >2 turns (0x10)"
            0x11 -> Outcome.VENDED to "motor worked, drop not detected — treated as vended (0x11)"
            0x12 -> Outcome.VENDED to "motor turned half-turn, no drop — treated as vended (0x12)"
            0x20 -> Outcome.VENDED to "motor >1 turn, no drop — treated as vended (0x20)"
            // Codes whose only fault is the (disabled, untrusted) infrared
            // sensor. We deliberately treat these as VENDED, never close slot.
            0x0c, 0x15, 0x16, 0x17, 0x18, 0x21 ->
                Outcome.VENDED to "motor worked; infrared anomaly ignored (sensor disabled) (0x%02x)".format(code)

            // --- genuine mechanical failure: motor did not deliver ---
            0x01 -> Outcome.MOTOR_FAILED to "no motor / open circuit, never worked (0x01)"
            0x02 -> Outcome.MOTOR_FAILED to "no motor / open circuit (0x02)"
            0x03 -> Outcome.MOTOR_FAILED to "position line broken or motor stalled, not at gap (0x03)"
            0x04 -> Outcome.MOTOR_FAILED to "motor stalled / jammed (0x04)"
            0x05 -> Outcome.MOTOR_FAILED to "turned <1 turn, stopped short (0x05)"
            0x06 -> Outcome.MOTOR_FAILED to "over-rotation fault (0x06)"
            0x07 -> Outcome.MOTOR_FAILED to "over-rotation, not at gap (0x07)"
            0x08 -> Outcome.MOTOR_FAILED to "belt channel no feedback, possibly empty (0x08)"
            0x0a -> Outcome.MOTOR_FAILED to "lift did not reach position, possibly empty (0x0a)"
            0x0d -> Outcome.MOTOR_FAILED to "jam suspected — low signal 3s (0x0d)"
            0x14 -> Outcome.MOTOR_FAILED to "no motor detected (0x14)"
            0xfd -> Outcome.MOTOR_FAILED to "motor not merged (variable channel) (0xfd)"

            // --- order bookkeeping ---
            0xf1 -> Outcome.ORDER_REJECTED to "order already exists, not re-vended (0xf1)"
            0xf2 -> Outcome.ORDER_REJECTED to "no such order id (0xf2)"
            0xfe -> Outcome.ORDER_REJECTED to "busy, currently vending (0xfe)"
            0xff -> Outcome.UNKNOWN to "CRC error in frame (0xff)"

            else -> Outcome.UNKNOWN to "unrecognized code 0x%02x — check per-model table".format(code)
        }
    }
}
