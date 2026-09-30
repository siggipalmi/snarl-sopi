package isl.snudursopi.fridge.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.fridge.R
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import isl.snudursopi.fridge.ui.util.localized

/**
 * "Close the door firmly", on the receipt.
 *
 * WHY THIS EXISTS even though a receipt usually means the door is already shut:
 * the PRIMARY settle trigger is the bolt latching, which can only happen with
 * the door closed — but the FALLBACK trigger is weight stability, ten seconds
 * of nothing moving, and that fires WITH THE FRIDGE STANDING OPEN. In that path
 * the customer is looking at a receipt beside an open door, which is exactly the
 * moment they need telling. Harmless when the door is already shut; the whole
 * point when it isn't.
 *
 * Bronze rather than red: this is a nudge, not a failure. The transaction went
 * fine and nothing is wrong — we're asking for one small courtesy on the way out.
 */
@Composable
fun CloseDoorBanner(
    language: Language,
    modifier: Modifier = Modifier,
) {
    val transition = rememberInfiniteTransition(label = "closeDoor")
    val t by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = NUDGE_CYCLE_MS, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "nudge",
    )

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(AppColors.Bronze.copy(alpha = 0.08f), RoundedCornerShape(16.dp))
            .padding(vertical = 20.dp, horizontal = 28.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Canvas(Modifier.size(44.dp)) {
            // A door easing shut, on a long pause. Constant motion beside a
            // finished transaction reads as an alarm; one small movement every
            // few seconds reads as a reminder.
            val push = nudge(t)
            val u = size.minDimension / 40f
            val stroke = Stroke(width = 2.1f * u, cap = StrokeCap.Round)

            // Frame the door closes into.
            drawLine(
                color = AppColors.Bronze.copy(alpha = 0.45f),
                start = Offset(30f * u, 6f * u),
                end = Offset(30f * u, 34f * u),
                strokeWidth = 1.6f * u,
                cap = StrokeCap.Round,
            )
            // The leaf, widening toward the frame as it swings shut.
            val leafW = (17f + 6f * push) * u
            drawRoundRect(
                color = AppColors.Bronze,
                topLeft = Offset(5f * u, 6f * u),
                size = Size(leafW, 28f * u),
                cornerRadius = CornerRadius(1.8f * u),
                style = stroke,
            )
            drawCircle(
                color = AppColors.Bronze,
                radius = 1.5f * u,
                center = Offset(5f * u + leafW - 3.5f * u, 20f * u),
            )
        }

        Spacer(Modifier.width(20.dp))

        Text(
            text = localized(language, R.string.close_door_firmly),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.SemiBold,
            fontSize = 44.sp,
            letterSpacing = (-0.5).sp,
            color = AppColors.Bronze,
        )
    }
}

/**
 * 0..1 push, spending most of the cycle at rest.
 *
 * The door only moves in the last fifth of each cycle, so the banner sits still
 * and then gives a single shove — a repeating animation on a receipt screen
 * would pull the eye away from the amount that was just charged.
 */
private fun nudge(t: Float): Float {
    if (t < 0.78f) return 0f
    val local = (t - 0.78f) / 0.22f
    // out and back
    val tri = if (local < 0.5f) local / 0.5f else 1f - (local - 0.5f) / 0.5f
    return tri * tri * (3f - 2f * tri)
}

private const val NUDGE_CYCLE_MS = 3200
