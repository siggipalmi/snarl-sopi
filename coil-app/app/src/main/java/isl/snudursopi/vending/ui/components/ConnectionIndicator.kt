package isl.snudursopi.vending.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import isl.snudursopi.vending.domain.ConnectionState
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts

/**
 * Connection indicator for the top status bar.
 *  - Wi-Fi: four-bar icon showing signal strength
 *  - Cellular: small generation label (5G/4G) + bars
 *  - None: red dot + "ekkert net" label so a passing technician notices
 *
 * Designed to sit in the gap between the brand line and the clock — small,
 * understated, but immediately readable.
 */
@Composable
fun ConnectionIndicator(
    state: ConnectionState,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        when (state) {
            is ConnectionState.Wifi -> {
                WifiBars(bars = state.bars)
            }
            is ConnectionState.Cellular -> {
                Text(
                    text = state.generation,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Medium,
                    color = AppColors.MutedSoft,
                )
                CellularBars(bars = state.bars)
            }
            ConnectionState.None -> {
                NoConnectionIcon()
            }
        }
    }
}

@Composable
private fun WifiBars(bars: Int) {
    // Wi-Fi fan: 4 arcs at increasing radii, lit/dim by signal strength.
    val active = AppColors.Ink
    val inactive = AppColors.MutedSoft.copy(alpha = 0.25f)
    Canvas(modifier = Modifier.size(width = 18.dp, height = 14.dp)) {
        val cx = size.width / 2f
        val cy = size.height
        val maxR = size.height * 0.95f
        val barCount = 4

        for (i in 0 until barCount) {
            val r = maxR * (i + 1f) / barCount
            val isOn = (i + 1) <= bars
            val color = if (isOn) active else inactive
            // Draw an arc from 200° to 340° (top half of a circle, opening downward)
            drawArc(
                color = color,
                startAngle = 200f,
                sweepAngle = 140f,
                useCenter = false,
                topLeft = Offset(cx - r, cy - r),
                size = Size(r * 2, r * 2),
                style = Stroke(width = size.height * 0.10f),
            )
        }
    }
}

@Composable
private fun CellularBars(bars: Int) {
    // Four vertical bars of increasing height.
    val active = AppColors.Ink
    val inactive = AppColors.MutedSoft.copy(alpha = 0.25f)
    Canvas(modifier = Modifier.size(width = 16.dp, height = 12.dp)) {
        val barWidth = size.width / 5f
        val gap = barWidth / 3f
        val totalWidth = barWidth * 4 + gap * 3
        val startX = (size.width - totalWidth) / 2f

        for (i in 0 until 4) {
            val barHeight = size.height * (i + 1f) / 4f
            val isOn = (i + 1) <= bars
            val color = if (isOn) active else inactive
            val x = startX + i * (barWidth + gap)
            val y = size.height - barHeight
            drawRect(
                color = color,
                topLeft = Offset(x, y),
                size = Size(barWidth, barHeight),
            )
        }
    }
}

@Composable
private fun NoConnectionIcon() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp),
        ) {
            Canvas(modifier = Modifier.size(8.dp)) {
                drawCircle(color = Color(0xFFC4501A))
            }
        }
        Text(
            text = "ekkert net",
            fontFamily = AppFonts.Geist,
            fontSize = 11.sp,
            color = Color(0xFFC4501A),
            fontWeight = FontWeight.Medium,
        )
    }
}
