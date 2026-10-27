package isl.snudursopi.fridge.domain

import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

/**
 * The cabinet lighting policy from config (fridge.led, backend ledPolicy).
 *
 * *** ON/OFF ONLY ON THIS HARDWARE.
 *
 * Measured on 8626020623, 2026-10-02: ctlLed(0, 1, 0) switches the lights off
 * and ctlLed(0, 1, 1) on, each acknowledged with a 0x43 frame. ctlLed(0, 1, 10)
 * and (0, 1, 100) look identical to (0, 1, 1) — no dimming. ledBrightness-
 * Adjustment gets no reply at all. So every brightness in the policy reads as
 * "0 = off, anything above 0 = on". If a board that dims ever turns up, this is
 * the one place that changes.
 */
data class LightPolicy(
    val mode: String = "on",                 // "off" | "on" | "schedule"
    val brightness: Int = 100,
    val night: NightWindow? = null,
    val wake: Wake = Wake(),
) {
    data class NightWindow(
        val from: LocalTime,
        val to: LocalTime,
        val brightness: Int,
        val zone: ZoneId,
        val requiresClockProof: Boolean = true,
    )

    data class Wake(val enabled: Boolean = true, val brightness: Int = 100, val holdSeconds: Int = 45)
}

object Lighting {
    data class Decision(val on: Boolean, val reason: String)

    /**
     * Whether the lights should be on now.
     *
     * [customerHere] is true from door unlock until [Wake.holdSeconds] after the
     * session settles. [clockProven] is true once a backend poll has succeeded
     * since boot: these boards come back from a power cut with the clock years
     * out, and a night window applied on a wrong clock would leave a fridge dark
     * at midday. Until then the day level holds.
     */
    fun decide(p: LightPolicy, nowMs: Long, clockProven: Boolean, customerHere: Boolean): Decision {
        if (customerHere && p.wake.enabled) {
            return Decision(p.wake.brightness > 0, "customer")
        }
        if (p.mode == "off") return Decision(false, "mode off")
        val night = p.night
        if (p.mode == "schedule" && night != null) {
            if (night.requiresClockProof && !clockProven) {
                return Decision(p.brightness > 0, "day level until the clock is proven")
            }
            if (inWindow(nowMs, night)) return Decision(night.brightness > 0, "night window")
        }
        return Decision(p.brightness > 0, "mode ${p.mode}")
    }

    /** from > to wraps midnight (22:00-08:00); from == to is no window at all. */
    fun inWindow(nowMs: Long, n: LightPolicy.NightWindow): Boolean {
        val t = Instant.ofEpochMilli(nowMs).atZone(n.zone).toLocalTime()
        return when {
            n.from == n.to -> false
            n.from < n.to -> !t.isBefore(n.from) && t.isBefore(n.to)
            else -> !t.isBefore(n.from) || t.isBefore(n.to)
        }
    }
}
