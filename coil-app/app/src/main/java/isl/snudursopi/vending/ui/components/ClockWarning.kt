package isl.snudursopi.vending.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.vending.ClockGuard
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts
import kotlinx.coroutines.delay

private val WarnAccent = Color(0xFF8B2020)
private val WarnBg = Color(0xFFFDECE8)

/**
 * Says "the clock is wrong" in plain words, and nothing at all while it's right.
 * Shown on the setup screen and on both views of the error screen, so whoever
 * walks up to the machine reads the cause before any stack trace — and without
 * needing the PIN. See [ClockGuard] for why.
 *
 * Re-reads the clock every few seconds, so it disappears by itself once the
 * time is fixed, wherever it is placed.
 */
@Composable
fun ClockWarning(modifier: Modifier = Modifier) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(5_000L)
            now = System.currentTimeMillis()
        }
    }
    if (!ClockGuard.isWrong(now)) return

    val autoTimeOn = ClockGuard.isAutoTimeOn(LocalContext.current)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(WarnBg, RoundedCornerShape(10.dp))
            .border(0.5.dp, WarnAccent.copy(alpha = 0.35f), RoundedCornerShape(10.dp))
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Text(
            text = "klukkan í vélinni er röng",
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontSize = 22.sp,
            color = WarnAccent,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = "hún sýnir ${ClockGuard.shownAs(now)}. á meðan klukkan er röng nær vélin " +
                "hvorki í vörulistann né í bakendann.",
            fontFamily = AppFonts.Geist,
            fontSize = 13.sp,
            lineHeight = 18.sp,
            color = AppColors.Ink,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = "lagað í Settings → System → Date & time → kveikja á „Automatic date & time“.",
            fontFamily = AppFonts.Geist,
            fontSize = 13.sp,
            lineHeight = 18.sp,
            color = AppColors.Ink,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = "sjálfvirkur tími: ${if (autoTimeOn) "á" else "af"}",
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = WarnAccent,
        )
    }
}
