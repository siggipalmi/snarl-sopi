package isl.snudursopi.vending.domain

import org.junit.Assert.assertEquals
import org.junit.Test

/** Portrait posters go to the full-screen idle loop, everything else to the 16:9 strip. */
class AdSlotSplitTest {
    private val landscape = AdSlot.Image(id = "a", imageUrl = "file:///a.png", portrait = false)
    private val portrait1 = AdSlot.Image(id = "b", imageUrl = "file:///b.png", durationSeconds = 8, portrait = true)
    private val video = AdSlot.Video(id = "c", videoUrl = "file:///c.mp4")
    private val portrait2 = AdSlot.Image(id = "d", imageUrl = "file:///d.png", portrait = true)
    private val all = listOf(landscape, portrait1, video, portrait2)

    @Test fun idlePostersAreThePortraitImagesInListOrder() {
        assertEquals(listOf(portrait1, portrait2), all.idlePosters())
    }

    @Test fun stripKeepsLandscapeImagesAndVideos() {
        assertEquals(listOf(landscape, video), all.stripAds())
    }

    @Test fun noPostersMeansNoIdleLoopAndAnUnchangedStrip() {
        val strip = listOf(landscape, video)
        assertEquals(emptyList<AdSlot.Image>(), strip.idlePosters())
        assertEquals(strip, strip.stripAds())
    }
}
