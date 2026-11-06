package isl.snudursopi.fridge.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.fridge.R
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import isl.snudursopi.fridge.ui.theme.AppShapes
import isl.snudursopi.fridge.ui.util.localized

/**
 * "„Skyr, vanilla“ er í röngu hólfi" — shown while the door is open and an item taken from one
 * basket is sitting in another (mockup approved by Siggi 2026-11-06). It asks; it never blocks.
 * The item stays in the cart at its price, because if the door closes now they did take it.
 */
@Composable
fun MisplacedBanner(productName: String, language: Language, modifier: Modifier = Modifier) {
    val shape = AppShapes.rounded(18.dp)
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(AppColors.CautionFill)
            .border(1.dp, AppColors.Line, shape)
            .padding(horizontal = 26.dp, vertical = 18.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(22.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val ink = AppColors.CautionText
        // A basket with a cross through it: "this one is wrong".
        Canvas(Modifier.size(44.dp)) {
            val u = size.width / 24f
            val stroke = Stroke(width = 1.9f * u)
            val box = Path().apply {
                moveTo(3 * u, 7 * u); lineTo(21 * u, 7 * u); lineTo(21 * u, 20 * u); lineTo(3 * u, 20 * u); close()
                moveTo(3 * u, 7 * u); lineTo(6 * u, 3 * u); lineTo(18 * u, 3 * u); lineTo(21 * u, 7 * u)
            }
            drawPath(box, ink, style = stroke)
            drawLine(ink, Offset(9 * u, 11 * u), Offset(15 * u, 17 * u), strokeWidth = 1.9f * u)
            drawLine(ink, Offset(15 * u, 11 * u), Offset(9 * u, 17 * u), strokeWidth = 1.9f * u)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                localized(language, R.string.misplaced_title, productName),
                fontFamily = AppFonts.Display,
                fontStyle = AppFonts.DisplayStyle,
                fontWeight = AppFonts.DisplayWeight,
                fontSize = 32.sp,
                lineHeight = 35.sp,
                maxLines = 2,
                color = ink,
            )
            Text(
                localized(language, R.string.misplaced_body),
                fontFamily = AppFonts.Body,
                fontWeight = FontWeight.Medium,
                fontSize = 18.sp,
                lineHeight = 25.sp,
                color = AppColors.Ink,
            )
        }
    }
}
