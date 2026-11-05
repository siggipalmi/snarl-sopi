package isl.snudursopi.vending.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.shared.SkinId
import isl.snudursopi.vending.R

/**
 * A skin is every visual token the screens read: colours, the two type roles, the type scale,
 * corner rounding and a few chrome flags. The structure of the screens (what is on them, the
 * timers, the strings, the five reader states) is NOT a skin: both skins share it.
 *
 * Two skins exist. [Skins.Classic] is the look the fleet has run since the start: cream, ink,
 * bronze, Cormorant Garamond italic headlines over Geist. [Skins.Franklin] is the 2026 redesign:
 * white, black hairlines, one typeface (Libre Franklin) heavy and tight, square corners, colour
 * only for meaning and for product tiles.
 *
 * The backend picks the skin per operator with a per-machine override (AG only, `skin` in the
 * config). The app applies it at the next config poll, so a canary can be switched — and switched
 * back — from the dashboard with no new build.
 *
 * Screens keep reading `AppColors.Ink`, `AppFonts.Display` and `AppTypography.DisplayLarge`
 * exactly as before: those names are now composable getters over [LocalSkin]. The legacy colour
 * names (Cream, Bronze, Clay…) are ROLES, mapped per skin — in Franklin "Bronze" is ink and
 * "Cream" is white. New code should prefer the role names at the bottom of [SkinColors].
 */
data class SkinColors(
    val Cream: Color,
    val CreamShadow: Color,
    val Ink: Color,
    val InkSoft: Color,
    val Bronze: Color,
    val BronzeLight: Color,
    val Clay: Color,
    val Line: Color,
    val Muted: Color,
    val MutedSoft: Color,
    val Alert: Color,
    val Success: Color,
    val White: Color,
    // ---- role names added with the Franklin skin; classic maps them onto its own palette ----
    /** Marker colour: language/greeting square, combo bar, awaiting-card dot, deal label text. */
    val Accent: Color,
    /** Advisory, not failure: corner warning, closed reason, retry line, reader down. */
    val Advisory: Color,
    /** Inputs, image placeholders, keypad keys. */
    val Wall: Color,
    /** Disabled buttons, empty progress track. */
    val WallDeep: Color,
    /** Photo-well colours behind product images, picked by a stable hash of the product id. Empty = no well. */
    val TilePalette: List<Color>,
)

data class SkinFonts(
    /** Headlines, greetings, "takk", editorial copy. */
    val Display: FontFamily,
    /** UI chrome, labels, values. */
    val Body: FontFamily,
    /** The style headlines are set in: italic for classic Cormorant, upright for Franklin. */
    val DisplayStyle: FontStyle,
    /** The weight headlines are set in: Medium for Cormorant, Black for Franklin. */
    val DisplayWeight: FontWeight,
)

/** The type scale. Built from [SkinFonts] so each skin gets its own faces in the same roles. */
data class SkinTypography(
    val DisplayHuge: TextStyle,
    val DisplayLarge: TextStyle,
    val DisplayMedium: TextStyle,
    val DisplaySmall: TextStyle,
    val BodyLarge: TextStyle,
    val BodyMedium: TextStyle,
    val BodySmall: TextStyle,
    val Label: TextStyle,
    val LabelSmall: TextStyle,
    /** Monospaced digits for the clock and codes. */
    val Mono: TextStyle,
)

data class Skin(
    val id: SkinId,
    val colors: SkinColors,
    val fonts: SkinFonts,
    val type: SkinTypography,
    /** Corner radius 0 on everything (tiles, buttons, pills, cards, inputs, sheets). */
    val squareCorners: Boolean,
    /** The brand line ("snarl & sopi") in the status bar. Off in Franklin by the owner's wish. */
    val showBrandLine: Boolean,
)

private fun typographyFor(f: SkinFonts) = SkinTypography(
    DisplayHuge = TextStyle(fontFamily = f.Display, fontStyle = f.DisplayStyle, fontWeight = f.DisplayWeight, fontSize = 88.sp, lineHeight = 92.sp, letterSpacing = (-2).sp),
    DisplayLarge = TextStyle(fontFamily = f.Display, fontStyle = f.DisplayStyle, fontWeight = f.DisplayWeight, fontSize = 56.sp, lineHeight = 56.sp, letterSpacing = (-1).sp),
    DisplayMedium = TextStyle(fontFamily = f.Display, fontStyle = f.DisplayStyle, fontWeight = f.DisplayWeight, fontSize = 40.sp, lineHeight = 42.sp, letterSpacing = (-0.8).sp),
    DisplaySmall = TextStyle(fontFamily = f.Display, fontStyle = f.DisplayStyle, fontWeight = f.DisplayWeight, fontSize = 28.sp, lineHeight = 30.sp, letterSpacing = (-0.5).sp),
    BodyLarge = TextStyle(fontFamily = f.Body, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 22.sp),
    BodyMedium = TextStyle(fontFamily = f.Body, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 19.sp),
    BodySmall = TextStyle(fontFamily = f.Body, fontWeight = FontWeight.Normal, fontSize = 11.sp, lineHeight = 15.sp),
    Label = TextStyle(fontFamily = f.Body, fontWeight = FontWeight.Medium, fontSize = 13.sp, letterSpacing = 0.2.sp),
    LabelSmall = TextStyle(fontFamily = f.Body, fontWeight = FontWeight.Medium, fontSize = 10.sp, letterSpacing = 1.5.sp),
    Mono = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 0.5.sp),
)

object Skins {
    /** Cormorant Garamond italic (regular + medium cuts); upright requests fall back to italic. */
    private val cormorant = FontFamily(
        Font(resId = R.font.cormorant_garamond_italic, weight = FontWeight.Normal, style = FontStyle.Italic),
        Font(resId = R.font.cormorant_garamond_medium_italic, weight = FontWeight.Medium, style = FontStyle.Italic),
        Font(resId = R.font.cormorant_garamond_italic, weight = FontWeight.Normal, style = FontStyle.Normal),
    )

    /** Geist regular + medium; light and bold requests fall back to the nearest cut. */
    private val geist = FontFamily(
        Font(resId = R.font.geist_regular, weight = FontWeight.Normal),
        Font(resId = R.font.geist_medium, weight = FontWeight.Medium),
        Font(resId = R.font.geist_regular, weight = FontWeight.Light),
        Font(resId = R.font.geist_medium, weight = FontWeight.Bold),
    )

    /**
     * Libre Franklin, static cuts 500–900 (SIL OFL; coil-app/fonts/LICENSE-LibreFranklin-OFL.txt).
     * The redesign sets body copy at 600 and headlines at 900, so a request for Normal (400) — which
     * is what the classic screens ask for — lands on the SemiBold cut rather than a synthesised one.
     */
    private val libreFranklin = FontFamily(
        Font(resId = R.font.libre_franklin_medium, weight = FontWeight.Medium),
        Font(resId = R.font.libre_franklin_semibold, weight = FontWeight.SemiBold),
        Font(resId = R.font.libre_franklin_bold, weight = FontWeight.Bold),
        Font(resId = R.font.libre_franklin_extrabold, weight = FontWeight.ExtraBold),
        Font(resId = R.font.libre_franklin_black, weight = FontWeight.Black),
        Font(resId = R.font.libre_franklin_semibold, weight = FontWeight.Normal),
        Font(resId = R.font.libre_franklin_medium, weight = FontWeight.Light),
    )

    private val classicColors = SkinColors(
        Cream = Color(0xFFFAF7F2),
        CreamShadow = Color(0xFFF0E8DA),
        Ink = Color(0xFF1A1A1A),
        InkSoft = Color(0xFF3A3A3A),
        Bronze = Color(0xFF8B6B3E),
        BronzeLight = Color(0xFFB8946B),
        Clay = Color(0xFFD4CCBE),
        Line = Color(0xFFE8E2D8),
        Muted = Color(0xFF8A8275),
        MutedSoft = Color(0xFF6B6B6B),
        Alert = Color(0xFFB8471F),
        Success = Color(0xFF4A6B2E),
        White = Color(0xFFFFFFFF),
        Accent = Color(0xFF8B6B3E),
        Advisory = Color(0xFF8B6B3E),
        Wall = Color(0xFFF0E8DA),
        WallDeep = Color(0xFFD4CCBE),
        TilePalette = emptyList(),
    )

    private val franklinColors = SkinColors(
        Cream = Color(0xFFFFFFFF),        // paper
        CreamShadow = Color(0xFFF3F0EB),  // wall
        Ink = Color(0xFF111111),
        InkSoft = Color(0xFF555555),
        Bronze = Color(0xFF111111),       // the old accent role reads as ink here
        BronzeLight = Color(0xFF555555),
        Clay = Color(0xFFE2DED7),         // wallDeep
        Line = Color(0xFF111111),         // black hairline rules
        Muted = Color(0xFF555555),
        MutedSoft = Color(0xFF555555),
        Alert = Color(0xFFEC4F8C),        // pink alert
        Success = Color(0xFF22B05A),
        White = Color(0xFFFFFFFF),
        Accent = Color(0xFFFFC72C),
        Advisory = Color(0xFFF7A21B),
        Wall = Color(0xFFF3F0EB),
        WallDeep = Color(0xFFE2DED7),
        TilePalette = listOf(
            Color(0xFFF05A3C), Color(0xFF3FC3E6), Color(0xFF22B05A), Color(0xFFF48FB8),
            Color(0xFFFFC72C), Color(0xFF8DCFC7), Color(0xFFF7A21B), Color(0xFFF7AE94),
        ),
    )

    private val classicFonts = SkinFonts(Display = cormorant, Body = geist, DisplayStyle = FontStyle.Italic, DisplayWeight = FontWeight.Medium)
    private val franklinFonts = SkinFonts(Display = libreFranklin, Body = libreFranklin, DisplayStyle = FontStyle.Normal, DisplayWeight = FontWeight.Black)

    val Classic = Skin(SkinId.Classic, classicColors, classicFonts, typographyFor(classicFonts), squareCorners = false, showBrandLine = true)
    val Franklin = Skin(SkinId.Franklin, franklinColors, franklinFonts, typographyFor(franklinFonts), squareCorners = true, showBrandLine = false)

    fun of(id: SkinId): Skin = when (id) {
        SkinId.Classic -> Classic
        SkinId.Franklin -> Franklin
    }
}

val LocalSkin = staticCompositionLocalOf { Skins.Classic }

/** The current skin's colours. Same call sites as the old constant object. */
val AppColors: SkinColors
    @Composable @ReadOnlyComposable get() = LocalSkin.current.colors

/** The current skin's type roles. */
val AppFonts: SkinFonts
    @Composable @ReadOnlyComposable get() = LocalSkin.current.fonts

/** The current skin's type scale. */
val AppTypography: SkinTypography
    @Composable @ReadOnlyComposable get() = LocalSkin.current.type

object AppShapes {
    /** A rounded corner in classic, a square one in Franklin. Replaces bare RoundedCornerShape(r). */
    @Composable @ReadOnlyComposable
    fun rounded(radius: Dp): Shape = if (LocalSkin.current.squareCorners) RectangleShape else RoundedCornerShape(radius)

    /** Percent form, as RoundedCornerShape(50) for a pill. */
    @Composable @ReadOnlyComposable
    fun rounded(percent: Int): Shape = if (LocalSkin.current.squareCorners) RectangleShape else RoundedCornerShape(percent)

    /** Per-corner form, as RoundedCornerShape(topStart = …, topEnd = …). */
    @Composable @ReadOnlyComposable
    fun rounded(topStart: Dp = 0.dp, topEnd: Dp = 0.dp, bottomEnd: Dp = 0.dp, bottomStart: Dp = 0.dp): Shape =
        if (LocalSkin.current.squareCorners) RectangleShape else RoundedCornerShape(topStart, topEnd, bottomEnd, bottomStart)
}
