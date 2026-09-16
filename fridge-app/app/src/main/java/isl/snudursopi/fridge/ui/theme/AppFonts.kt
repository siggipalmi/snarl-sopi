package isl.snudursopi.fridge.ui.theme

import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import isl.snudursopi.fridge.R

/**
 * Brand typefaces, bundled as TTF assets under res/font/.
 *
 * Cormorant Garamond — display italic serif used for greetings, hero titles,
 * captions, button copy, and accent text. We only use italic cuts (regular
 * and medium); upright Cormorant is not in our design system.
 *
 * Geist — body sans-serif used for UI chrome, labels, technical/value rows.
 * Regular for body, Medium for emphasis (product names, action buttons).
 *
 * Both are SIL OFL licensed and redistributable in apps. When the design
 * calls for a weight not bundled, the system falls back to the closest cut
 * we have rather than the platform default — better than a jarring style
 * mismatch.
 */
object AppFonts {

    val Cormorant = FontFamily(
        // Regular italic — most editorial copy
        Font(
            resId = R.font.cormorant_garamond_italic,
            weight = FontWeight.Normal,
            style = FontStyle.Italic,
        ),
        // Medium italic — emphasized display copy (greetings, hero captions)
        Font(
            resId = R.font.cormorant_garamond_medium_italic,
            weight = FontWeight.Medium,
            style = FontStyle.Italic,
        ),
        // When asked for upright Cormorant we don't have it. Fall back to the
        // italic regular cut rather than the platform serif — keeps the
        // typeface consistent even if the styling doesn't match exactly.
        // In practice we never request upright Cormorant in the design.
        Font(
            resId = R.font.cormorant_garamond_italic,
            weight = FontWeight.Normal,
            style = FontStyle.Normal,
        ),
        // SemiBold italic — for display copy that has to carry across a room.
        // A real cut, not a synthesised bold: Cormorant is a high-contrast serif
        // and faux-bolding smears the thin strokes badly at large sizes.
        Font(
            resId = R.font.cormorant_garamond_semibold_italic,
            weight = FontWeight.SemiBold,
            style = FontStyle.Italic,
        ),
    )

    val Geist = FontFamily(
        Font(
            resId = R.font.geist_regular,
            weight = FontWeight.Normal,
            style = FontStyle.Normal,
        ),
        Font(
            resId = R.font.geist_medium,
            weight = FontWeight.Medium,
            style = FontStyle.Normal,
        ),
        // Light: not bundled. If a screen requests Light, fall back to Regular
        // rather than the platform sans. Keeps brand consistent.
        Font(
            resId = R.font.geist_regular,
            weight = FontWeight.Light,
            style = FontStyle.Normal,
        ),
        // Bold: same — fall back to Medium, our heaviest available cut.
        Font(
            resId = R.font.geist_medium,
            weight = FontWeight.Bold,
            style = FontStyle.Normal,
        ),
    )
}
