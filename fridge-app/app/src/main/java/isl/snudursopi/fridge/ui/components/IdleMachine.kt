package isl.snudursopi.fridge.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform

/**
 * The idle screen's hero: a drawing of THIS machine, demonstrating itself.
 *
 * The reasoning, which is worth keeping: a gravity fridge looks exactly like a
 * locked drinks cooler, and that's what people assume it is. Nobody expects to
 * tap a card and then simply help themselves — so the attract loop shows the
 * whole gesture rather than asking for it in words. It draws the actual cabinet,
 * with the reader in the real place it sits on the door, so what's on screen and
 * what's in front of them agree.
 *
 * Nine seconds, one pass: card approaches, taps, the door swings, a can leaves,
 * the door closes. On a double BOTH doors open together, because that is what a
 * real customer session does — one card opens the whole machine.
 *
 * Everything is driven from a single 0..1 clock so the beats can't drift apart.
 * Deliberately drawn rather than a video: it stays crisp at any size, costs no
 * assets, and picks its own layout from the cabinet count in config, so a single
 * and a double need no separate art.
 */
@Composable
fun IdleMachine(
    cabinets: Int,
    t: Float,
    modifier: Modifier = Modifier,
) {
    val isDouble = cabinets >= 2
    val nominalW = if (isDouble) 268f else 150f

    // Size to the DRAWING's own proportions rather than filling whatever box
    // we're given. Filling meant the cabinet floated in the middle of a
    // half-width column with dead space either side, so its margin was
    // whatever happened to be left over — which is why the screen couldn't be
    // made to balance. Now the composable IS the drawing, and the surrounding
    // layout controls the margins directly.
    Canvas(
        modifier
            .fillMaxHeight()
            .aspectRatio(nominalW / NOMINAL_H),
    ) {
        // Fit the nominal drawing inside the canvas, centred, preserving aspect.
        val scale = minOf(size.width / nominalW, size.height / NOMINAL_H)
        val offX = (size.width - nominalW * scale) / 2f
        val offY = (size.height - NOMINAL_H * scale) / 2f
        withTransform({
            translate(offX, offY)
            scale(scale, scale, Offset.Zero)
        }) {
            if (isDouble) drawDouble(t) else drawSingle(t)
        }
    }
}

/**
 * The shared 0..1 idle clock. Hoisted so the machine drawing and the narration
 * text advance from the SAME value — two independent transitions would drift and
 * the words would stop matching the picture.
 */
@Composable
fun rememberIdleClock(): Float {
    val transition = rememberInfiniteTransition(label = "machine")
    val t by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = CYCLE_MS, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "loop",
    )
    return t
}

/**
 * Which of the three narration lines belongs to this instant.
 *
 * Boundaries sit just AFTER each beat begins, so the words arrive a moment into
 * the action they describe rather than pre-announcing it — reading "open the
 * door" while the door is already swinging is what makes the two feel like one
 * thing.
 */
fun idleNarrationIndex(t: Float): Int = when {
    t < 0.30f -> 0   // card approaching and tapping
    t < 0.52f -> 1   // doors swinging open
    else -> 2        // can leaving
}

// ---- the loop -----------------------------------------------------------
// Beat boundaries, as reviewed on the animation study. Shifting one shifts
// everything after it, so they're named rather than inlined.
private const val CARD_IN_FROM = 0.08f
private const val CARD_IN_TO = 0.20f
private const val TAP_AT = 0.18f
private const val CARD_OUT_FROM = 0.22f
private const val CARD_OUT_TO = 0.30f
private const val DOORS_OPEN_FROM = 0.28f
private const val DOORS_OPEN_TO = 0.42f
private const val CAN_LIFT_FROM = 0.52f
private const val CAN_LIFT_TO = 0.66f
private const val CAN_FADE_FROM = 0.60f
private const val CAN_FADE_TO = 0.70f
private const val DOORS_SHUT_FROM = 0.68f
private const val DOORS_SHUT_TO = 0.84f

private fun smooth(x: Float): Float {
    val c = x.coerceIn(0f, 1f)
    return c * c * (3f - 2f * c)
}

/** Eased progress through a window: 0 before it, 1 after. */
private fun win(t: Float, from: Float, to: Float): Float = smooth((t - from) / (to - from))

private fun lerp(a: Float, b: Float, x: Float): Float = a + (b - a) * x.coerceIn(0f, 1f)

// ---- palette ------------------------------------------------------------
// Local to the drawing: these are the physical machine's colours (dark cabinet,
// red price tags, warm white LEDs), not the app's editorial palette.
private val CabinetDark = Color(0xFF242220)
private val FrameLine = Color(0xFF111111)
private val GlassTint = Color(0xFFEFEAE0)
private val ShelfLine = Color(0xFFD4CCBE)
private val CanBody = Color(0xFFD4CCBE)
private val CanHighlight = Color(0xFFB8946B)
private val PriceTagRed = Color(0xFF8C2B1B)
private val LedWhite = Color(0xFFFFFDF6)
private val ScreenNavy = Color(0xFF14304A)
private val LightboxPale = Color(0xFFE9F0F7)
private val ReaderBody = Color(0xFF2B2926)
private val ReaderFace = Color(0xFFB8946B)
private val CasterRed = Color(0xFF7A2E22)
private val CardBronze = Color(0xFF8B6B3E)

// ---- pieces -------------------------------------------------------------

private fun DrawScope.drawSingle(t: Float) {
    // head unit + screen
    rr(18f, 8f, 114f, 34f, 4f, CabinetDark)
    rr(26f, 13f, 98f, 24f, 2f, ScreenNavy)
    // the screen wakes as the card is read, then settles again
    val glow = 0.30f * (win(t, 0.18f, 0.26f) - win(t, 0.80f, 0.92f))
    if (glow > 0f) rr(26f, 13f, 98f, 24f, 2f, CardBronze.copy(alpha = glow))

    rr(18f, 46f, 114f, 168f, 5f, CabinetDark)
    doorInterior(24f, 102f, highlightRow = 1, t = t)
    val open = doorOpen(t)
    doorLeaf(hingeX = 126f, x = 24f, w = 102f, open = open) {
        readerAndSticker(40f)
    }
    cardAndWaves(t, cardX = 86f, waveX = 64f)
    casters(34f, 116f)
}

private fun DrawScope.drawDouble(t: Float) {
    rr(18f, 8f, 232f, 34f, 4f, CabinetDark)
    // Screen above the RIGHT door, lightbox above the left — matching the real
    // cabinets, so the customer looks where the screen actually is.
    rr(26f, 13f, 106f, 24f, 2f, LightboxPale)
    rr(140f, 13f, 102f, 24f, 2f, ScreenNavy)
    val glow = 0.30f * (win(t, 0.18f, 0.26f) - win(t, 0.80f, 0.92f))
    if (glow > 0f) rr(140f, 13f, 102f, 24f, 2f, CardBronze.copy(alpha = glow))

    rr(18f, 46f, 232f, 168f, 5f, CabinetDark)
    doorInterior(24f, 104f, highlightRow = -1, t = t)
    doorInterior(140f, 104f, highlightRow = 1, t = t)
    val open = doorOpen(t)
    // BOTH doors, together — one card opens the whole machine.
    doorLeaf(hingeX = 24f, x = 24f, w = 104f, open = open) {}
    doorLeaf(hingeX = 244f, x = 140f, w = 104f, open = open) {
        readerAndSticker(152f)
    }
    cardAndWaves(t, cardX = 198f, waveX = 176f)
    casters(34f, 234f)
}

private fun doorOpen(t: Float): Float =
    win(t, DOORS_OPEN_FROM, DOORS_OPEN_TO) - win(t, DOORS_SHUT_FROM, DOORS_SHUT_TO)

/** Glass, shelves, stock, price tags and the edge LED strips. */
private fun DrawScope.doorInterior(x: Float, w: Float, highlightRow: Int, t: Float) {
    rr(x, 52f, w, 158f, 4f, GlassTint.copy(alpha = 0.42f))
    for (row in 0..3) {
        val y = 88f + row * 38f
        line(x + 7f, y, x + w - 7f, y, ShelfLine.copy(alpha = 0.75f), 1.4f)
        for (i in 0..3) {
            val cx = x + 10f + i * ((w - 24f) / 4f)
            val isHero = row == highlightRow && i == 2
            if (isHero) {
                // The one can that leaves. Lifts up and away, then fades — the
                // beat that tells people they take it themselves.
                val lift = win(t, CAN_LIFT_FROM, CAN_LIFT_TO)
                val alpha = 1f - win(t, CAN_FADE_FROM, CAN_FADE_TO)
                if (alpha > 0f) {
                    rr(
                        cx + lerp(0f, 26f, lift), y - 19f + lerp(0f, -30f, lift),
                        12f, 19f, 2.8f, CanHighlight.copy(alpha = alpha),
                    )
                }
            } else {
                rr(cx, y - 19f, 12f, 19f, 2.8f, CanBody)
            }
        }
        // Red LED price tags, one at each end of the shelf edge.
        rr(x + 9f, y + 3f, 14f, 6f, 1f, PriceTagRed)
        rr(x + w - 31f, y + 3f, 14f, 6f, 1f, PriceTagRed)
    }
    // Vertical white LED strips down the door edges.
    rr(x + 3f, 60f, 2.4f, 142f, 1.2f, LedWhite.copy(alpha = 0.85f))
    rr(x + w - 5.4f, 60f, 2.4f, 142f, 1.2f, LedWhite.copy(alpha = 0.85f))
}

/**
 * The door frame, swung open.
 *
 * Compressing horizontally around the hinge IS what a door rotating on a
 * vertical hinge looks like in projection — steadier than a real 3D rotation
 * and indistinguishable at this size.
 */
private fun DrawScope.doorLeaf(
    hingeX: Float,
    x: Float,
    w: Float,
    open: Float,
    content: DrawScope.() -> Unit,
) {
    withTransform({
        scale(1f - 0.55f * open, 1f, Offset(hingeX, 0f))
    }) {
        strokeRr(x, 52f, w, 158f, 4f, FrameLine, 2.4f)
        // The handle, on the leading edge.
        val handleX = if (hingeX > x + w / 2f) x + 6f else x + w - 6f
        line(handleX, 120f, handleX, 142f, FrameLine, 3.2f)
        content()
    }
}

/** The Nayax reader, mounted on the door, with the round sticker beside it. */
private fun DrawScope.readerAndSticker(x: Float) {
    rr(x, 118f, 19f, 26f, 3f, ReaderBody)
    rr(x + 3.5f, 123f, 12f, 10f, 1.6f, ReaderFace.copy(alpha = 0.9f))
    // The round borga/opna/taka sticker. Three faint lines stand in for the
    // three words: at this scale real text would be sub-legible, and the words
    // are already set full-size on the step strip below. Its job here is to say
    // WHERE the label is, so the screen and the door agree.
    circle(x + 35f, 131f, 14f, Color(0xFF141312))
    for (i in 0..2) {
        line(x + 28f, 126f + i * 5f, x + 42f, 126f + i * 5f, GlassTint.copy(alpha = 0.55f), 1.1f)
    }
}

/** The card sliding up to the reader, and the NFC ripple at the moment it taps. */
private fun DrawScope.cardAndWaves(t: Float, cardX: Float, waveX: Float) {
    val inT = win(t, CARD_IN_FROM, CARD_IN_TO)
    val outT = win(t, CARD_OUT_FROM, CARD_OUT_TO)
    val alpha = if (t < 0.06f) 0f else 1f - outT
    if (alpha > 0f) {
        val dx = lerp(34f, 0f, inT)
        val dy = lerp(26f, 0f, inT)
        strokeRr(cardX + dx, 150f + dy, 30f, 20f, 3f, CardBronze.copy(alpha = alpha), 2.2f)
        line(cardX + dx, 157f + dy, cardX + dx + 30f, 157f + dy, CardBronze.copy(alpha = alpha), 2.2f)
    }
    // Three arcs staggered slightly, so they read as one ripple travelling out
    // rather than three lights blinking.
    for (i in 0..2) {
        val local = (t - TAP_AT - i * 0.022f) / 0.10f
        val a = when {
            local < 0f || local > 1f -> 0f
            local < 0.35f -> local / 0.35f
            else -> 1f - (local - 0.35f) / 0.65f
        }
        if (a <= 0f) continue
        val r = 7f + i * 6f
        arc(waveX, 131f, r, CardBronze.copy(alpha = a.coerceIn(0f, 1f)), 2f)
    }
}

private fun DrawScope.casters(leftX: Float, rightX: Float) {
    circle(leftX, 222f, 5f, CasterRed)
    circle(rightX, 222f, 5f, CasterRed)
}

// ---- drawing helpers ----------------------------------------------------
// Everything above works in the nominal 236-tall coordinate space; the canvas
// transform handles the scaling, so these are thin wrappers that keep the
// drawing code readable.

private fun DrawScope.rr(x: Float, y: Float, w: Float, h: Float, r: Float, color: Color) {
    drawRoundRect(color, Offset(x, y), Size(w, h), CornerRadius(r))
}

private fun DrawScope.strokeRr(
    x: Float, y: Float, w: Float, h: Float, r: Float, color: Color, width: Float,
) {
    drawRoundRect(color, Offset(x, y), Size(w, h), CornerRadius(r), style = Stroke(width))
}

private fun DrawScope.line(
    x1: Float, y1: Float, x2: Float, y2: Float, color: Color, width: Float,
) {
    drawLine(color, Offset(x1, y1), Offset(x2, y2), width, StrokeCap.Round)
}

private fun DrawScope.circle(cx: Float, cy: Float, r: Float, color: Color) {
    drawCircle(color, r, Offset(cx, cy))
}

private fun DrawScope.arc(cx: Float, cy: Float, r: Float, color: Color, width: Float) {
    drawArc(
        color = color,
        startAngle = -55f,
        sweepAngle = 110f,
        useCenter = false,
        topLeft = Offset(cx - r, cy - r),
        size = Size(r * 2, r * 2),
        style = Stroke(width, cap = StrokeCap.Round),
    )
}

private const val NOMINAL_H = 236f
private const val CYCLE_MS = 9000
