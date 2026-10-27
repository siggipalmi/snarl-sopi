package isl.snudursopi.vending.ui.screens.closed

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.vending.domain.ConnectionState
import isl.snudursopi.vending.ui.components.StatusBar
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts

/**
 * Closed for sale (config.outOfService) — the coil twin of the fridge's ClosedView (0.68.0).
 *
 * The operator's own switch in the dashboard (Controls → close this machine, with a reason the
 * screen shows), or AG's master close, which sends no reason. All three languages at once,
 * Icelandic first, because a customer who can't buy shouldn't have to find the language button
 * to learn why. Covers every customer screen; the clock long-press still reaches the PIN pad, so
 * a technician gets in while the machine is closed.
 */
@Composable
fun ClosedScreen(
    reason: String?,
    brand: String,
    currentTime: String,
    connectionState: ConnectionState,
    onClockLongPress: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .background(AppColors.Cream),
    ) {
        StatusBar(
            brand = brand,
            time = currentTime,
            connectionState = connectionState,
            onClockLongPress = onClockLongPress,
        )
        Box(Modifier.fillMaxSize().padding(horizontal = 40.dp), contentAlignment = Alignment.Center) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text("🔒", fontSize = 46.sp)
                Spacer(Modifier.height(18.dp))
                Text(
                    "Lokað tímabundið",
                    fontFamily = AppFonts.Cormorant, fontStyle = FontStyle.Italic, fontWeight = FontWeight.SemiBold,
                    fontSize = 60.sp, lineHeight = 64.sp, color = AppColors.Ink, textAlign = TextAlign.Center,
                )
                reason?.let {
                    Spacer(Modifier.height(12.dp))
                    Text(it, fontSize = 21.sp, lineHeight = 28.sp, color = AppColors.InkSoft, textAlign = TextAlign.Center)
                }
                Spacer(Modifier.height(26.dp))
                Text("Temporarily closed · Chwilowo nieczynne", fontSize = 17.sp, color = AppColors.Muted, textAlign = TextAlign.Center)
                Spacer(Modifier.height(40.dp))
                Text("Við biðjumst velvirðingar á óþægindunum", fontSize = 14.sp, color = AppColors.Muted, textAlign = TextAlign.Center)
            }
        }
    }
}
