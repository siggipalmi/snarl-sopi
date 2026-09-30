package isl.snudursopi.fridge.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.unit.dp
import isl.snudursopi.fridge.ui.theme.AppColors

/**
 * The ⓘ affordance.
 *
 * Same size and shape as the language pill so the two read as a pair, one in
 * each bottom corner — the reachable part of a panel this tall, and out of the
 * way of the content rather than sitting over the shopping total as the first
 * arrangement did.
 *
 * Drawn rather than a glyph so it can't be affected by a font fallback.
 */
@Composable
fun InfoButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .size(84.dp)
            .background(AppColors.White, RoundedCornerShape(999.dp))
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(999.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(30.dp)) {
            val w = size.minDimension
            val stroke = w * 0.085f
            // the dot
            drawCircle(
                color = AppColors.Ink,
                radius = stroke * 0.62f,
                center = Offset(w / 2f, w * 0.24f),
            )
            // the stem
            drawLine(
                color = AppColors.Ink,
                start = Offset(w / 2f, w * 0.44f),
                end = Offset(w / 2f, w * 0.82f),
                strokeWidth = stroke,
                cap = StrokeCap.Round,
            )
        }
    }
}
