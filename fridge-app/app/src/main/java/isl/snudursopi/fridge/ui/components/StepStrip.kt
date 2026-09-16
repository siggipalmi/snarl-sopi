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
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import isl.snudursopi.fridge.R
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.ui.state.FridgePhase
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import isl.snudursopi.fridge.ui.util.localized

/**
 * The three-step strip along the bottom of every customer screen.
 *
 * Two jobs at once, which is the whole idea:
 *
 *  1. IT TEACHES. The words are the same three the customer can read on the
 *     round sticker beside the card reader — borga / opna / taka. Screen and
 *     door say the same thing, so neither has to carry the explanation alone.
 *     Smart fridges are new to most people and the instinct is to assume the
 *     door is simply locked.
 *
 *  2. IT REPORTS PROGRESS. Dormant while idle, step 1 lights while the card is
 *     being checked, step 2 when the door unlocks, step 3 while they're taking,
 *     and all three complete on the receipt. So it answers "where am I in this?"
 *     without a separate progress indicator competing for the screen.
 *
 * Only the ACTIVE step animates. Three things moving at once reads as decoration
 * and stops meaning anything; one thing moving is a signal.
 */
@Composable
fun StepStrip(
    language: Language,
    activeStep: Int,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(148.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Step(
            language = language,
            index = 1,
            activeStep = activeStep,
            wordRes = R.string.step_pay,
            modifier = Modifier.weight(1f),
        )
        Divider()
        Step(
            language = language,
            index = 2,
            activeStep = activeStep,
            wordRes = R.string.step_open,
            modifier = Modifier.weight(1f),
        )
        Divider()
        Step(
            language = language,
            index = 3,
            activeStep = activeStep,
            wordRes = R.string.step_take,
            modifier = Modifier.weight(1f),
        )
    }
}

/** Maps a flow phase onto the strip's progress. 0 = dormant, 4 = all complete. */
fun stepForPhase(phase: FridgePhase): Int = when (phase) {
    FridgePhase.IDLE -> 0
    FridgePhase.AUTHORIZING -> 1
    FridgePhase.UNLOCKED -> 2
    FridgePhase.SHOPPING, FridgePhase.DOOR_OPEN_WARN, FridgePhase.CALCULATING -> 3
    FridgePhase.RECEIPT, FridgePhase.PENDING_OFFLINE, FridgePhase.NOTHING_TAKEN -> 4
    // Nothing was achieved on these, so don't imply progress.
    FridgePhase.DECLINED, FridgePhase.SENSOR_FAULT -> 0
    // Staff screen — the strip is hidden entirely, this is just a safe default.
    FridgePhase.RESTOCK -> 0
    // The purchase itself DID complete — the complaint is about what happened
    // during it, not a failure of the flow. Showing 4 keeps the strip steady as
    // the customer moves receipt -> form -> confirmation, rather than appearing
    // to undo the transaction they just made.
    FridgePhase.COMPLAINT, FridgePhase.COMPLAINT_DONE -> 4
}

@Composable
private fun Divider() {
    Box(
        Modifier
            .fillMaxHeight(0.6f)
            .width(1.dp)
            .background(AppColors.Line),
    )
}

@Composable
private fun Step(
    language: Language,
    index: Int,
    activeStep: Int,
    wordRes: Int,
    modifier: Modifier = Modifier,
) {
    val isActive = index == activeStep
    val isDone = activeStep > index || activeStep == ALL_DONE

    // Three states, three weights of the same palette: waiting is Clay and
    // recedes, active is Bronze, done is BronzeLight — present but no longer
    // asking for attention.
    val stroke = when {
        isActive -> AppColors.Bronze
        isDone -> AppColors.BronzeLight
        else -> AppColors.Clay
    }
    val wordColor = when {
        isActive -> AppColors.Ink
        isDone -> AppColors.InkSoft
        else -> AppColors.Muted
    }
    val ordColor = if (isActive || isDone) AppColors.BronzeLight else AppColors.Clay

    // One shared clock per step, only driven when that step is active.
    val phase = if (isActive) rememberPulse() else 0f

    Column(
        modifier = modifier.padding(horizontal = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Canvas(Modifier.size(GLYPH_DP.dp)) {
            when (index) {
                1 -> drawTapGlyph(stroke, phase, isActive)
                2 -> drawDoorGlyph(stroke, phase, isActive)
                else -> drawTakeGlyph(stroke, phase, isActive)
            }
        }
        Spacer(Modifier.height(14.dp))
        Text(
            text = localized(language, wordRes),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.Medium,
            fontSize = 34.sp,
            textAlign = TextAlign.Center,
            color = wordColor,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = "0$index",
            fontFamily = AppFonts.Geist,
            fontSize = 12.sp,
            letterSpacing = 3.sp,
            color = ordColor,
        )
    }
}

/** A 0..1 sawtooth used by all three glyph animations. */
@Composable
private fun rememberPulse(): Float {
    val transition = rememberInfiniteTransition(label = "step")
    val v by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = CYCLE_MS, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "pulse",
    )
    return v
}

// ---- glyphs -------------------------------------------------------------
// Drawn rather than shipped as vectors so the stroke colour can be animated
// per state without three copies of each asset. All are laid out on a nominal
// 40x40 grid and scaled to the canvas, matching the mockup's proportions.

private fun DrawScope.g(v: Float): Float = size.minDimension * (v / 40f)

private fun DrawScope.strokeStyle() = Stroke(
    width = g(1.7f),
    cap = StrokeCap.Round,
)

/** A card with NFC waves rippling outward. */
private fun DrawScope.drawTapGlyph(color: Color, phase: Float, active: Boolean) {
    drawRoundRect(
        color = color,
        topLeft = Offset(g(4f), g(13f)),
        size = Size(g(18f), g(13f)),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(g(2.6f)),
        style = strokeStyle(),
    )
    // Three arcs, staggered a third of a cycle apart so they read as a ripple
    // travelling away from the card rather than three lights blinking.
    for (i in 0..2) {
        val radius = g(6f + i * 4.5f)
        val alpha = if (!active) 1f else {
            val local = (phase - i * 0.33f + 1f) % 1f
            // quick rise, slow fade — the shape of a real ripple
            if (local < 0.3f) local / 0.3f else (1f - (local - 0.3f) / 0.7f).coerceAtLeast(0f)
        }
        drawArc(
            color = color.copy(alpha = alpha.coerceIn(0f, 1f)),
            startAngle = -55f,
            sweepAngle = 110f,
            useCenter = false,
            topLeft = Offset(g(24f) - radius, g(19.5f) - radius),
            size = Size(radius * 2, radius * 2),
            style = strokeStyle(),
        )
    }
}

/** A door swinging open on its hinge. */
private fun DrawScope.drawDoorGlyph(color: Color, phase: Float, active: Boolean) {
    // Hinge post, fixed.
    drawLine(
        color = color,
        start = Offset(g(6f), g(7f)),
        end = Offset(g(6f), g(33f)),
        strokeWidth = g(1.7f),
        cap = StrokeCap.Round,
    )
    // The frame the door swings away from, dashed so it reads as "where it was".
    drawLine(
        color = color.copy(alpha = 0.5f),
        start = Offset(g(30f), g(12f)),
        end = Offset(g(30f), g(28f)),
        strokeWidth = g(1.4f),
        cap = StrokeCap.Round,
        pathEffect = PathEffect.dashPathEffect(floatArrayOf(g(2f), g(3f))),
    )
    // Compressing the leaf horizontally IS what a door rotating on a vertical
    // hinge looks like in projection — cheaper and steadier than a real 3D
    // rotation, and indistinguishable at this size.
    val open = if (!active) 1f else {
        val t = if (phase < 0.5f) phase / 0.5f else 1f - (phase - 0.5f) / 0.5f
        1f - 0.62f * smooth(t)
    }
    val leafWidth = g(20f) * open
    drawRoundRect(
        color = color,
        topLeft = Offset(g(6f), g(7f)),
        size = Size(leafWidth, g(26f)),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(g(1.6f)),
        style = strokeStyle(),
    )
    // Handle rides the leading edge, so the eye follows the swing.
    drawCircle(
        color = color,
        radius = g(1.3f),
        center = Offset(g(6f) + leafWidth - g(3f), g(20f)),
        style = strokeStyle(),
    )
}

/** A can lifting off a shelf. */
private fun DrawScope.drawTakeGlyph(color: Color, phase: Float, active: Boolean) {
    // Shelf, fixed.
    drawLine(
        color = color,
        start = Offset(g(8f), g(29f)),
        end = Offset(g(32f), g(29f)),
        strokeWidth = g(1.7f),
        cap = StrokeCap.Round,
    )
    val lift = if (!active) 0f else {
        val t = if (phase < 0.5f) phase / 0.5f else 1f - (phase - 0.5f) / 0.5f
        g(9f) * smooth(t)
    }
    translate(top = -lift) {
        drawRoundRect(
            color = color,
            topLeft = Offset(g(15.5f), g(11f)),
            size = Size(g(9f), g(16f)),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(g(2.2f)),
            style = Stroke(width = g(1.7f), cap = StrokeCap.Round),
        )
        // The ring-pull line, so it reads as a can rather than a box.
        drawLine(
            color = color,
            start = Offset(g(17.6f), g(14.6f)),
            end = Offset(g(22.4f), g(14.6f)),
            strokeWidth = g(1.4f),
            cap = StrokeCap.Round,
        )
    }
}

/** Ease in and out, so nothing starts or stops abruptly. */
private fun smooth(t: Float): Float = t * t * (3f - 2f * t)

private const val GLYPH_DP = 64
private const val CYCLE_MS = 2400
private const val ALL_DONE = 4
