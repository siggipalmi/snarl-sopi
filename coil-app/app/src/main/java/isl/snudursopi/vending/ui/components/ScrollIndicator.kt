package isl.snudursopi.vending.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import isl.snudursopi.vending.ui.theme.AppColors

/**
 * Floating scroll arrow shown at the bottom of a LazyVerticalGrid while
 * there's more content below the visible area. Fades out when the grid
 * reaches the end. Gentle vertical bounce draws the eye to it.
 *
 * Caller is responsible for positioning this in the bottom-center of the
 * scroll window's overlay area (Box with align BottomCenter).
 */
@Composable
fun ScrollIndicator(
    gridState: LazyGridState,
    modifier: Modifier = Modifier,
) {
    // Visible when the last visible item isn't the last item in the list.
    // Using derivedStateOf avoids recomposing on every scroll pixel.
    val canScrollDown by remember {
        derivedStateOf {
            val layoutInfo = gridState.layoutInfo
            val total = layoutInfo.totalItemsCount
            val lastVisible = layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
            total > 0 && lastVisible < total - 1
        }
    }

    AnimatedVisibility(
        visible = canScrollDown,
        enter = fadeIn(animationSpec = tween(300)),
        exit = fadeOut(animationSpec = tween(300)),
        modifier = modifier,
    ) {
        BouncingArrow()
    }
}

@Composable
private fun BouncingArrow() {
    val transition = rememberInfiniteTransition(label = "scroll-arrow-bounce")
    val offsetY by transition.animateFloat(
        initialValue = 0f,
        targetValue = 6f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 900),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "scroll-arrow-y",
    )
    Box(
        modifier = Modifier
            .graphicsLayer { translationY = offsetY }
            .size(44.dp)
            .clip(CircleShape)
            .background(AppColors.Ink.copy(alpha = 0.75f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Icons.Outlined.KeyboardArrowDown,
            contentDescription = null,
            tint = AppColors.Cream,
            modifier = Modifier.size(22.dp),
        )
    }
}
