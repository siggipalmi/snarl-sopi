package isl.snudursopi.vending.ui.screens.loading

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppTypography

@Composable
fun LoadingScreen(deviceCode: String?) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AppColors.Cream),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "snarl & sopi",
            style = AppTypography.DisplayLarge.copy(fontSize = 56.sp),
            color = AppColors.Ink,
        )
        Spacer(Modifier.height(40.dp))
        CircularProgressIndicator(
            color = AppColors.Bronze,
            strokeWidth = 3.dp,
            modifier = Modifier.size(48.dp),
        )
        Spacer(Modifier.height(40.dp))
        Text(
            text = "tengist vél…",
            fontSize = 16.sp,
            color = AppColors.MutedSoft,
            letterSpacing = 1.sp,
        )
        if (deviceCode != null) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = "vélarnúmer · $deviceCode",
                fontSize = 12.sp,
                color = AppColors.Muted,
                letterSpacing = 1.sp,
            )
        }
    }
}
