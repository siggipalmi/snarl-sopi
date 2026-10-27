package isl.snudursopi.fridge

import android.util.Log
import isl.snudursopi.fridge.domain.LightPolicy
import isl.snudursopi.fridge.domain.Lighting
import isl.snudursopi.fridge.hardware.FridgeHardwareController
import isl.snudursopi.fridge.ui.state.FridgePhase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Drives the cabinet lights from the config policy ([Lighting.decide]).
 *
 * Talks to the board only when the decision CHANGES, plus a re-assert every
 * [REASSERT_MS] in case the board lost its state in a power blip. This bus also
 * carries the weights, the locks and the compressor, and driving the wrong
 * thing on it has cycled the lights and compressor before (HARDWARE-facts.md);
 * a call every few seconds would be asking for that.
 *
 * Wake: from door unlock until [LightPolicy.Wake.holdSeconds] after the session
 * is over — cutting the light at door close cuts it while the customer is still
 * standing there. Restock counts too: staff need to see the shelves.
 *
 * A set_led command is a manual override that lasts until the next config
 * change, as the backend's contract says.
 */
class LightController(private val hardware: FridgeHardwareController) {

    @Volatile var policy: LightPolicy = LightPolicy()
        set(value) {
            if (value != field) manualOn = null   // a new config ends any override
            field = value
        }

    @Volatile var phase: FridgePhase = FridgePhase.IDLE
        set(value) {
            if (field in WAKE_PHASES && value !in WAKE_PHASES) leftSessionAtMs = System.currentTimeMillis()
            field = value
        }

    /** True once a backend poll has succeeded since boot — proof the clock is right. */
    @Volatile var clockProven: Boolean = false

    @Volatile private var manualOn: Boolean? = null
    @Volatile private var leftSessionAtMs: Long = 0L
    private var lastSent: Boolean? = null
    private var lastSentAtMs: Long = 0L

    /** set_led: an instant override until the next config change. */
    fun override(on: Boolean): String {
        manualOn = on
        return "lights ${if (on) "ON" else "OFF"} (manual, until the next config change)"
    }

    fun start(scope: CoroutineScope) {
        scope.launch {
            while (isActive) {
                runCatching { tick(System.currentTimeMillis()) }
                    .onFailure { Log.w(TAG, "lighting tick failed: ${it.message}") }
                delay(TICK_MS)
            }
        }
    }

    private fun tick(now: Long) {
        val p = policy
        val customerHere = phase in WAKE_PHASES ||
            (leftSessionAtMs > 0 && now - leftSessionAtMs < p.wake.holdSeconds * 1000L)
        val manual = manualOn
        val d = if (manual != null) {
            Lighting.Decision(manual, "manual override")
        } else {
            Lighting.decide(p, now, clockProven, customerHere)
        }
        val changed = d.on != lastSent
        if (changed || now - lastSentAtMs >= REASSERT_MS) {
            // Not sent (bus not up yet): leave lastSent alone so the next tick
            // tries again, instead of believing the lights are already right.
            if (!hardware.setLights(d.on)) return
            if (changed) Log.i(TAG, "lights ${if (d.on) "ON" else "OFF"} — ${d.reason}")
            lastSent = d.on
            lastSentAtMs = now
        }
    }

    private companion object {
        const val TAG = "FridgeLights"
        const val TICK_MS = 2_000L
        const val REASSERT_MS = 15L * 60L * 1000L
        val WAKE_PHASES = setOf(
            FridgePhase.UNLOCKED, FridgePhase.SHOPPING, FridgePhase.CALCULATING,
            FridgePhase.DOOR_OPEN_WARN, FridgePhase.RESTOCK,
        )
    }
}
