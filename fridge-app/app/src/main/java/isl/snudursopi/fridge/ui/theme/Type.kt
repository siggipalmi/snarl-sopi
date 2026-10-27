package isl.snudursopi.fridge.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Typography for the app.
 *
 * Display copy uses [AppFonts.Cormorant] italic.
 * Body uses [AppFonts.Geist].
 * Tabular numerics use [FontFamily.Monospace] for proper digit alignment
 * (clock, deviceCode, signal strength) — Geist is proportional and would
 * jitter as digits change.
 */
object AppTypography {
    // Display: italic Cormorant Garamond. Used for greetings, hero titles, "takk", etc.
    val DisplayHuge = TextStyle(
        fontFamily = AppFonts.Cormorant,
        fontStyle = FontStyle.Italic,
        fontWeight = FontWeight.Medium,
        fontSize = 88.sp,
        lineHeight = 92.sp,
        letterSpacing = (-2).sp,
    )
    val DisplayLarge = TextStyle(
        fontFamily = AppFonts.Cormorant,
        fontStyle = FontStyle.Italic,
        fontWeight = FontWeight.Medium,
        fontSize = 56.sp,
        lineHeight = 56.sp,
        letterSpacing = (-1).sp,
    )
    val DisplayMedium = TextStyle(
        fontFamily = AppFonts.Cormorant,
        fontStyle = FontStyle.Italic,
        fontWeight = FontWeight.Medium,
        fontSize = 40.sp,
        lineHeight = 42.sp,
        letterSpacing = (-0.8).sp,
    )
    val DisplaySmall = TextStyle(
        fontFamily = AppFonts.Cormorant,
        fontStyle = FontStyle.Italic,
        fontWeight = FontWeight.Medium,
        fontSize = 28.sp,
        lineHeight = 30.sp,
        letterSpacing = (-0.5).sp,
    )

    // Body: Geist
    val BodyLarge = TextStyle(
        fontFamily = AppFonts.Geist,
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 22.sp,
    )
    val BodyMedium = TextStyle(
        fontFamily = AppFonts.Geist,
        fontWeight = FontWeight.Normal,
        fontSize = 13.sp,
        lineHeight = 19.sp,
    )
    val BodySmall = TextStyle(
        fontFamily = AppFonts.Geist,
        fontWeight = FontWeight.Normal,
        fontSize = 11.sp,
        lineHeight = 15.sp,
    )

    val Label = TextStyle(
        fontFamily = AppFonts.Geist,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        letterSpacing = 0.2.sp,
    )
    val LabelSmall = TextStyle(
        fontFamily = AppFonts.Geist,
        fontWeight = FontWeight.Medium,
        fontSize = 10.sp,
        letterSpacing = 1.5.sp,
    )

    // Numeric: monospaced for tabular price/clock display. NOT Geist —
    // Geist is proportional and digits would jitter as they tick.
    val Mono = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        letterSpacing = 0.5.sp,
    )
}

internal val AppMaterialTypography = Typography(
    displayLarge = AppTypography.DisplayLarge,
    displayMedium = AppTypography.DisplayMedium,
    displaySmall = AppTypography.DisplaySmall,
    bodyLarge = AppTypography.BodyLarge,
    bodyMedium = AppTypography.BodyMedium,
    bodySmall = AppTypography.BodySmall,
    labelLarge = AppTypography.Label,
    labelMedium = AppTypography.Label,
    labelSmall = AppTypography.LabelSmall,
)
