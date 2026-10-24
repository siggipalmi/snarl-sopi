package isl.snudursopi.vending.ui.screens.error

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.vending.domain.ConnectionState
import isl.snudursopi.vending.ui.components.StatusBar
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts
import kotlinx.coroutines.delay

/**
 * Two-tier error screen.
 *
 * Customer view (default): calm editorial copy explaining the kiosk is briefly
 * unavailable, plus a countdown to the next auto-retry. No buttons — the
 * ViewModel handles the retry loop in the background. If a retry succeeds the
 * phase transitions to Ready and the customer sees the grid appear.
 *
 * Operator view (after PIN, [showOperatorDetail] = true): technical summary,
 * stack trace, retry status, and manual buttons. Reached via long-press on
 * the clock (same gesture as elsewhere) → PIN → flag flips.
 *
 * Long-press is handled by the caller via the [onClockLongPress] callback —
 * keeps PIN navigation outside this screen.
 */
@Composable
fun ErrorScreen(
    error: Throwable,
    deviceCode: String?,
    machineName: String,
    currentTime: String,
    connectionState: ConnectionState,
    retryAttempts: Int,
    nextRetryAtMillis: Long,
    showOperatorDetail: Boolean,
    onClockLongPress: () -> Unit,
    onRetryNow: () -> Unit,
    onResetDeviceCode: () -> Unit,
    onExitOperator: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(if (showOperatorDetail) OperatorBg else AppColors.Cream),
    ) {
        StatusBar(
            brand = "snarl & sopi — AG Vending",
            time = currentTime,
            connectionState = connectionState,
            onClockLongPress = onClockLongPress,
        )

        if (showOperatorDetail) {
            OperatorView(
                error = error,
                deviceCode = deviceCode,
                machineName = machineName,
                retryAttempts = retryAttempts,
                nextRetryAtMillis = nextRetryAtMillis,
                onRetryNow = onRetryNow,
                onResetDeviceCode = onResetDeviceCode,
                onExit = onExitOperator,
            )
        } else {
            CustomerView(nextRetryAtMillis = nextRetryAtMillis)
        }
    }
}

// ---------- Customer view ----------

@Composable
private fun CustomerView(nextRetryAtMillis: Long) {
    // Tick every second so the countdown updates live.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000L)
        }
    }
    val secondsRemaining = if (nextRetryAtMillis > 0L) {
        ((nextRetryAtMillis - now) / 1000L).coerceAtLeast(0L)
    } else 0L

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 36.dp, vertical = 60.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        // Bronze ringed exclamation
        Box(
            modifier = Modifier
                .size(56.dp)
                .border(1.5.dp, AppColors.Bronze.copy(alpha = 0.6f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "!",
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 28.sp,
                color = AppColors.Bronze.copy(alpha = 0.6f),
            )
        }

        Spacer(Modifier.height(28.dp))

        Text(
            text = "vélin er ekki\ntiltæk í augnablikinu.",
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.Medium,
            fontSize = 40.sp,
            color = AppColors.Ink,
            lineHeight = 44.sp,
        )

        Spacer(Modifier.height(12.dp))

        Text(
            text = "við vinnum að lausn.",
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontSize = 18.sp,
            color = AppColors.MutedSoft,
        )

        Spacer(Modifier.height(32.dp))

        if (secondsRemaining > 0L) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "að reyna aftur í ${secondsRemaining}s",
                    fontFamily = AppFonts.Geist,
                    fontSize = 12.sp,
                    color = AppColors.Bronze,
                    letterSpacing = 0.5.sp,
                )
                Spacer(Modifier.width(8.dp))
                PulsingDots()
            }
        } else {
            // No retry scheduled (or window elapsed waiting for the retry to fire)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "athugar tengingu",
                    fontFamily = AppFonts.Geist,
                    fontSize = 12.sp,
                    color = AppColors.Bronze,
                    letterSpacing = 0.5.sp,
                )
                Spacer(Modifier.width(8.dp))
                PulsingDots()
            }
        }
    }
}

@Composable
private fun PulsingDots() {
    // Three dots pulsing at staggered phases. Subtle ambient indicator.
    var tick by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) {
        while (true) {
            tick = System.currentTimeMillis()
            delay(140L)
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        repeat(3) { i ->
            val phase = ((tick / 140L) + i) % 10L
            val alpha = if (phase < 5) 0.3f + (phase * 0.14f) else 1.0f - ((phase - 5) * 0.14f)
            Box(
                modifier = Modifier
                    .size(4.dp)
                    .background(AppColors.Bronze.copy(alpha = alpha.coerceIn(0.2f, 1f)), CircleShape),
            )
        }
    }
}

// ---------- Operator view ----------

private val OperatorBg = Color(0xFFFFF1EE)
private val OperatorAccent = Color(0xFF8B2020)

@Composable
private fun OperatorView(
    error: Throwable,
    deviceCode: String?,
    machineName: String,
    retryAttempts: Int,
    nextRetryAtMillis: Long,
    onRetryNow: () -> Unit,
    onResetDeviceCode: () -> Unit,
    onExit: () -> Unit,
) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000L)
        }
    }
    val secondsRemaining = if (nextRetryAtMillis > 0L) {
        ((nextRetryAtMillis - now) / 1000L).coerceAtLeast(0L)
    } else 0L

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp, vertical = 22.dp),
    ) {
        Text(
            text = "TÆKNILEGAR UPPLÝSINGAR",
            fontFamily = AppFonts.Geist,
            fontSize = 11.sp,
            color = OperatorAccent,
            letterSpacing = 1.5.sp,
            fontWeight = FontWeight.Medium,
        )
        Spacer(Modifier.height(10.dp))

        // Friendly user-side summary (what the customer sees)
        Text(
            text = "ekki tókst að sækja vörulistann frá vefþjónustu",
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.Medium,
            fontSize = 24.sp,
            color = AppColors.Ink,
            lineHeight = 26.sp,
        )

        Spacer(Modifier.height(12.dp))

        Text(
            text = "vélarnúmer: ${deviceCode ?: "—"}" +
                if (machineName.isNotBlank()) " · $machineName" else "",
            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
            fontSize = 12.sp,
            color = AppColors.MutedSoft,
        )

        Spacer(Modifier.height(18.dp))

        // Retry status row
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(AppColors.White, RoundedCornerShape(8.dp))
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = "sjálfvirk endurtilraun",
                fontFamily = AppFonts.Geist,
                fontSize = 12.sp,
                color = AppColors.MutedSoft,
            )
            val retryDesc = if (secondsRemaining > 0L)
                "$retryAttempts mistókust · næst eftir ${secondsRemaining}s"
            else
                "$retryAttempts mistókust · keyrir núna"
            Text(
                text = retryDesc,
                fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                fontSize = 12.sp,
                color = AppColors.Ink,
            )
        }

        Spacer(Modifier.height(14.dp))

        // Stack trace
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .background(AppColors.White, RoundedCornerShape(8.dp))
                .border(0.5.dp, OperatorAccent.copy(alpha = 0.3f), RoundedCornerShape(8.dp))
                .padding(14.dp),
        ) {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                val errClassName = error::class.qualifiedName ?: error::class.java.name
                Text(
                    text = "${errClassName}: ${error.message ?: "(no message)"}",
                    fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                    fontSize = 11.sp,
                    color = OperatorAccent,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(10.dp))
                Text(
                    text = error.stackTraceToString(),
                    fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                    fontSize = 10.sp,
                    color = AppColors.Muted,
                    lineHeight = 14.sp,
                )
            }
        }

        Spacer(Modifier.height(14.dp))

        // Action buttons
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            DangerOutlinedButton(
                label = "endurstilla vél",
                onClick = onResetDeviceCode,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(
                label = "til baka",
                onClick = onExit,
                modifier = Modifier.weight(1f),
            )
            SolidButton(
                label = "reyna núna",
                onClick = onRetryNow,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun SolidButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .height(48.dp)
            .background(AppColors.Ink, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = AppColors.Cream,
            fontFamily = AppFonts.Geist,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun OutlinedButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .height(48.dp)
            .border(0.5.dp, AppColors.Ink, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = AppColors.Ink,
            fontFamily = AppFonts.Geist,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun DangerOutlinedButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .height(48.dp)
            .border(0.5.dp, OperatorAccent, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = OperatorAccent,
            fontFamily = AppFonts.Geist,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}
