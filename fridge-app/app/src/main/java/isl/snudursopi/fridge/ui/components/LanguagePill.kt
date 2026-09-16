package isl.snudursopi.fridge.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.fridge.ui.theme.AppColors

/**
 * The language toggle — a small pill showing the CURRENT language's code.
 *
 * Ported from the coil kiosk, where it's proven in the field. It shows the
 * language you're in rather than the one you'd switch to: on a machine offering
 * three languages there's no sensible single "next" label, and a globe plus the
 * current code is understood without reading anything.
 *
 * Monospace deliberately, so IS / EN / PL are all the same width and the pill
 * doesn't jiggle as it cycles.
 *
 * Sits BOTTOM-RIGHT: it was top-right and collided with the shopping total,
 * which lives in that corner. Bottom-right is also the easier reach on a tall
 * kiosk panel — the top of a 22" screen is above eye level for most people.
 */
@Composable
fun LanguagePill(
    code: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .height(84.dp)
            .background(AppColors.White, RoundedCornerShape(32.dp))
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(32.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 30.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = code.uppercase(),
            fontFamily = FontFamily.Monospace,
            fontSize = 22.sp,
            fontWeight = FontWeight.Medium,
            color = AppColors.Ink,
            letterSpacing = 2.sp,
        )
    }
}
