package isl.snudursopi.vending.ui.components

import android.view.ViewGroup
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import isl.snudursopi.vending.domain.AdOverlay
import isl.snudursopi.vending.domain.AdRotationConfig
import isl.snudursopi.vending.domain.AdSlot
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppTypography
import kotlinx.coroutines.delay

/**
 * Top-of-screen rotating ad region.
 *
 * Cycles through the provided ad slots on the backend-set interval.
 * Returns early when [ads] is empty so the caller doesn't need to
 * gate visibility separately.
 *
 * Videos play muted at all times — there is no way to unmute.
 */
@Composable
fun AdRegion(
    ads: List<AdSlot>,
    config: AdRotationConfig,
    modifier: Modifier = Modifier,
) {
    if (ads.isEmpty()) return

    var currentIndex by remember { mutableStateOf(0) }

    // Auto-advance loop. Video ads can shorten their own window via
    // maxDurationSeconds; otherwise we use the global interval.
    LaunchedEffect(ads, config.intervalSeconds) {
        while (true) {
            val current = ads[currentIndex]
            val seconds = when (current) {
                is AdSlot.Video -> current.maxDurationSeconds ?: config.intervalSeconds
                is AdSlot.Image -> config.intervalSeconds
            }
            delay(seconds * 1000L)
            currentIndex = (currentIndex + 1) % ads.size
        }
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f),
    ) {
        // Cross-fade between ads when index changes
        AnimatedContent(
            targetState = currentIndex,
            transitionSpec = {
                fadeIn(animationSpec = tween(400)) togetherWith fadeOut(animationSpec = tween(400))
            },
            label = "ad-rotation",
        ) { idx ->
            when (val ad = ads[idx]) {
                is AdSlot.Image -> ImageAd(ad)
                is AdSlot.Video -> VideoAd(ad)
            }
        }

        // Progress dots — only when there's more than one ad and config allows
        if (config.showProgressDots && ads.size > 1) {
            ProgressDots(
                count = ads.size,
                activeIndex = currentIndex,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 12.dp),
            )
        }
    }
}

@Composable
private fun ImageAd(ad: AdSlot.Image) {
    Box(modifier = Modifier.fillMaxSize()) {
        if (!ad.imageUrl.isNullOrBlank()) {
            AsyncImage(
                model = ad.imageUrl,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            // No URL → fall back to a default gradient backdrop so the
            // overlay still has something to sit on.
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(
                        Brush.linearGradient(
                            colors = listOf(Color(0xFFEFC9A6), Color(0xFFD8A574)),
                        ),
                    ),
            )
        }
        ad.overlay?.let { OverlayContent(it) }
    }
}

@Composable
private fun OverlayContent(overlay: AdOverlay) {
    Column(
        modifier = Modifier
            .fillMaxHeight()
            .padding(start = 32.dp, top = 36.dp, end = 32.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = overlay.eyebrow,
            fontSize = 14.sp,
            letterSpacing = 2.sp,
            color = Color(0xFF6B3E15),
            fontWeight = FontWeight.Medium,
        )
        Spacer(Modifier.height(12.dp))
        overlay.titleLines.forEach { line ->
            Text(
                text = line,
                style = AppTypography.DisplayMedium.copy(fontSize = 52.sp),
                color = Color(0xFF3D1F0F),
            )
        }
        if (overlay.ctaLabel != null) {
            Spacer(Modifier.height(16.dp))
            Box(
                modifier = Modifier
                    .background(AppColors.Ink, RoundedCornerShape(28.dp))
                    .padding(horizontal = 20.dp, vertical = 10.dp),
            ) {
                Text(
                    text = overlay.ctaLabel,
                    color = AppColors.Cream,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

/**
 * Muted, auto-playing video using ExoPlayer. The video starts when the
 * composable enters composition and stops/releases on exit. Volume is
 * forced to zero — no path to unmute.
 */
@Composable
private fun VideoAd(ad: AdSlot.Video) {
    val context = LocalContext.current
    var hasError by remember(ad.id) { mutableStateOf(false) }

    // One ExoPlayer per video slot — recreated each time this composable
    // is entered (which is each rotation tick, due to AnimatedContent).
    val exoPlayer = remember(ad.id) {
        ExoPlayer.Builder(context).build().apply {
            addListener(object : Player.Listener {
                override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                    android.util.Log.e(
                        "AdRegion",
                        "Video playback error for ad ${ad.id}: ${error.errorCodeName} — ${error.message}",
                        error,
                    )
                    hasError = true
                }

                override fun onPlaybackStateChanged(playbackState: Int) {
                    val name = when (playbackState) {
                        Player.STATE_IDLE -> "IDLE"
                        Player.STATE_BUFFERING -> "BUFFERING"
                        Player.STATE_READY -> "READY"
                        Player.STATE_ENDED -> "ENDED"
                        else -> "UNKNOWN"
                    }
                    android.util.Log.d("AdRegion", "Video state for ad ${ad.id}: $name")
                }
            })
            setMediaItem(MediaItem.fromUri(ad.videoUrl))
            repeatMode = Player.REPEAT_MODE_ONE   // loop until rotation advances
            volume = 0f                            // muted always
            playWhenReady = true
            prepare()
        }
    }

    // Clean up the player when this slot rotates away.
    DisposableEffect(ad.id) {
        onDispose { exoPlayer.release() }
    }

    if (hasError) {
        // Show a calm fallback when video can't load (common on emulators
        // without proper H.264 codec support). On real hardware this
        // shouldn't fire.
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.linearGradient(
                        colors = listOf(Color(0xFF3A3A3A), Color(0xFF1A1A1A)),
                    ),
                ),
        )
    } else {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                PlayerView(ctx).apply {
                    player = exoPlayer
                    useController = false
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                }
            },
        )
    }
}

@Composable
private fun ProgressDots(
    count: Int,
    activeIndex: Int,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        repeat(count) { i ->
            val active = i == activeIndex
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(3.dp))
                    .background(
                        if (active) AppColors.Cream.copy(alpha = 0.95f)
                        else AppColors.Cream.copy(alpha = 0.4f)
                    )
                    .height(6.dp)
                    .width(if (active) 24.dp else 6.dp),
            )
        }
    }
}
