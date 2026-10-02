package isl.snudursopi.fridge.ui.components

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.imageLoader
import coil.request.ImageRequest
import isl.snudursopi.fridge.domain.IdleRotation
import isl.snudursopi.fridge.domain.Poster
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import kotlinx.coroutines.delay

/**
 * Full-screen posters on the idle screen, in turn with the how-it-works
 * animation ([IdleRotation]). Posters are the operator's own (config.ads,
 * uploaded through the dashboard at 1920×1080 — this panel's shape exactly).
 *
 * Shows only while [active] (idle, nothing open on top), after [idleTimeoutSeconds]
 * of idle. A tap goes straight back to the animation and restarts the timeout;
 * a card tap leaves IDLE, which removes this entirely.
 *
 * A poster that fails to load is dropped from the rotation rather than shown
 * as a blank screen — an empty cream panel reads as a broken machine.
 */
@Composable
fun IdlePosters(
    posters: List<Poster>,
    active: Boolean,
    idleTimeoutSeconds: Int,
    bleed: Dp,
) {
    val context = LocalContext.current
    val failed = remember { mutableStateListOf<String>() }
    var idleSince by remember(active) { mutableLongStateOf(System.currentTimeMillis()) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }

    // Fetch every poster up front so a slot never opens on a half-loaded image.
    val urls = posters.map { it.url }
    LaunchedEffect(urls) {
        urls.forEach { context.imageLoader.enqueue(ImageRequest.Builder(context).data(it).build()) }
    }
    LaunchedEffect(active) {
        while (active) {
            now = System.currentTimeMillis()
            delay(250)
        }
    }

    val usable = posters.filter { it.url !in failed }
    if (!active || usable.isEmpty()) return
    val index = IdleRotation.posterAt(
        rotationMs = now - idleSince - idleTimeoutSeconds * 1000L,
        durationsMs = usable.map { it.durationSec * 1000L },
    )

    Crossfade(targetState = index?.let { usable.getOrNull(it) }, animationSpec = tween(600), label = "poster") { p ->
        if (p == null) return@Crossfade
        Box(
            Modifier
                .bleed(bleed)
                .background(AppColors.Ink)
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) { idleSince = System.currentTimeMillis() },
        ) {
            AsyncImage(
                model = p.url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
                onError = { failed.add(p.url) },
            )
            p.overlayText?.takeIf { it.isNotBlank() }?.let { text ->
                Text(
                    text,
                    fontFamily = AppFonts.Geist,
                    fontSize = 34.sp,
                    color = Color.White,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .background(Color.Black.copy(alpha = 0.45f))
                        .padding(vertical = 22.dp, horizontal = 40.dp),
                )
            }
        }
    }
}

/**
 * Fill the parent AND the padding around it. The flow screen pads its content
 * 44dp; a poster has to reach the panel's edges, and a layout modifier can draw
 * outside the padding without restructuring every other screen.
 */
private fun Modifier.bleed(by: Dp): Modifier = layout { measurable, constraints ->
    val extra = by.roundToPx()
    val w = constraints.maxWidth + 2 * extra
    val h = constraints.maxHeight + 2 * extra
    val placeable = measurable.measure(constraints.copy(minWidth = w, maxWidth = w, minHeight = h, maxHeight = h))
    layout(constraints.maxWidth, constraints.maxHeight) { placeable.place(-extra, -extra) }
}
