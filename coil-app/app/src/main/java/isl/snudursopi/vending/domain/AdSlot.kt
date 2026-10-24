package isl.snudursopi.vending.domain

import kotlinx.serialization.Serializable

/**
 * Content shown in the rotating ad region above the greeting.
 *
 * Two kinds today: image and video. Both are non-interactive — taps do
 * nothing (the hero zone and product grid handle all purchase paths).
 *
 * Videos play muted at all times. There is no way to unmute. A vending
 * machine in a public space must not produce sound on its own.
 *
 * TODO: populated from admin backend per-machine. For now stubbed in
 * VendingViewModel.defaultAdPlaylist() so we can test rotation.
 */
@Serializable
sealed class AdSlot {
    abstract val id: String

    /**
     * Image ad. Editorial copy can be overlaid on top using a templated
     * style (eyebrow + title + cta), or the image can be full-bleed art
     * from a sponsor (no overlay).
     */
    @Serializable
    data class Image(
        override val id: String,
        /** Image URL (admin backend) or null for bundled-in-app images later. */
        val imageUrl: String?,
        /** Optional editorial overlay; if null, image renders full-bleed. */
        val overlay: AdOverlay? = null,
    ) : AdSlot()

    /**
     * Video ad. Always muted, always plays once or until rotation tick,
     * whichever comes first.
     */
    @Serializable
    data class Video(
        override val id: String,
        val videoUrl: String,
        /**
         * Hard cap for how long this video stays on screen, even if the
         * video is longer. Defaults to the global rotation interval if
         * null. Use to keep one giant video from monopolizing the slot.
         */
        val maxDurationSeconds: Int? = null,
    ) : AdSlot()
}

/**
 * Editorial overlay for image ads — eyebrow + title + optional CTA pill.
 * Same shape as the current static "fylkir · íþróttadrykkur" ad.
 */
@Serializable
data class AdOverlay(
    val eyebrow: String,       // small uppercase label, e.g. "fylkir · íþróttadrykkur"
    val titleLines: List<String>,   // big italic serif, one per line
    val ctaLabel: String? = null,   // dark pill at bottom, e.g. "prófaðu · 425 kr →"
)

/**
 * Rotation behavior. Backend-set in production; today this is a default.
 */
@Serializable
data class AdRotationConfig(
    /** Seconds between auto-advances. Backend controls this. */
    val intervalSeconds: Int = 10,
    /** If true, show progress dots at bottom of the ad zone. */
    val showProgressDots: Boolean = true,
)
