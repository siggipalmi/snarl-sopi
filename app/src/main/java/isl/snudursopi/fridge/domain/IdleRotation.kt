package isl.snudursopi.fridge.domain

/** An idle-screen poster from config.ads (images only for now). */
data class Poster(val url: String, val durationSec: Int, val overlayText: String? = null)

/**
 * What the idle screen shows when: the how-it-works animation, then each poster
 * in turn, then round again. Pure, so the order is testable without a screen.
 *
 * The animation keeps a slot of its own because a gravity fridge looks like a
 * locked cooler, and a screen of nothing but posters would never show a new
 * customer that you tap a card and simply open the door.
 */
object IdleRotation {
    /** Two passes of the 9-second drawing: long enough to be followed once. */
    const val ANIMATION_SLOT_MS = 18_000L

    /**
     * The poster showing [rotationMs] into the rotation, or null for the
     * animation slot. Negative time (still inside the idle timeout) is the
     * animation too.
     */
    fun posterAt(rotationMs: Long, durationsMs: List<Long>, animationMs: Long = ANIMATION_SLOT_MS): Int? {
        if (durationsMs.isEmpty() || rotationMs < 0) return null
        val cycle = animationMs + durationsMs.sum()
        var t = rotationMs % cycle
        if (t < animationMs) return null
        t -= animationMs
        durationsMs.forEachIndexed { i, d ->
            if (t < d) return i
            t -= d
        }
        return null
    }
}
