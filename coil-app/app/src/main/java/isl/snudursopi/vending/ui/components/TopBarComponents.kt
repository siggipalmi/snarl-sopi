package isl.snudursopi.vending.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.font.FontFamily
import isl.snudursopi.vending.domain.ConnectionState
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts

@Composable
fun StatusBar(
    brand: String,
    time: String,
    connectionState: ConnectionState = ConnectionState.None,
    onClockLongPress: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(56.dp)
            .padding(horizontal = 24.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = brand,
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.Medium,
            fontSize = 22.sp,
            color = AppColors.Ink,
            letterSpacing = (-0.2).sp,
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            ConnectionIndicator(state = connectionState)
            // Long-press the clock to enter admin/diagnostics. Tap does nothing
            // (looks unresponsive to a curious customer who casually taps).
            Text(
                text = time,
                fontFamily = FontFamily.Monospace,
                fontSize = 15.sp,
                color = AppColors.MutedSoft,
                letterSpacing = 0.5.sp,
                modifier = Modifier
                    .padding(4.dp)
                    .pointerInput(Unit) {
                        detectTapGestures(onLongPress = { onClockLongPress() })
                    },
            )
        }
    }
}

@Composable
fun ActionButton(
    icon: @Composable () -> Unit,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    badge: Int? = null,
) {
    Box(modifier = modifier) {
        Box(
            modifier = Modifier
                .size(64.dp)
                .background(AppColors.White, CircleShape)
                .border(0.5.dp, AppColors.Line, CircleShape)
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            icon()
        }
        if (badge != null && badge > 0) {
            Box(
                modifier = Modifier
                    .size(26.dp)
                    .background(AppColors.Alert, CircleShape)
                    .border(2.dp, AppColors.Cream, CircleShape)
                    .align(Alignment.TopEnd),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = badge.toString(),
                    color = AppColors.Cream,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

@Composable
fun LanguagePill(
    code: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .height(64.dp)
            .background(AppColors.White, RoundedCornerShape(32.dp))
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(32.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 22.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = code.uppercase(),
            fontFamily = FontFamily.Monospace,
            fontSize = 16.sp,
            fontWeight = FontWeight.Medium,
            color = AppColors.Ink,
            letterSpacing = 1.5.sp,
        )
    }
}

@Composable
fun ContactIcon(tint: Color = AppColors.Ink) {
    Icon(
        imageVector = Icons.Outlined.Phone,
        contentDescription = null,
        tint = tint,
        modifier = Modifier.size(26.dp),
    )
}

@Composable
fun BasketIcon(tint: Color = AppColors.Ink) {
    Icon(
        imageVector = Icons.Outlined.ShoppingCart,
        contentDescription = null,
        tint = tint,
        modifier = Modifier.size(26.dp),
    )
}
