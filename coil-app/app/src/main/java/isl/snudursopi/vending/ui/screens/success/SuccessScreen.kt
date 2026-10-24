package isl.snudursopi.vending.ui.screens.success

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.vending.domain.ConnectionState
import isl.snudursopi.vending.domain.Language
import isl.snudursopi.vending.R
import isl.snudursopi.vending.ui.util.localized
import isl.snudursopi.vending.ui.components.StatusBar
import isl.snudursopi.vending.ui.state.CompletedTransaction
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts
import isl.snudursopi.vending.ui.theme.AppTypography
import kotlinx.coroutines.delay

/**
 * Success screen shown after payment completes.
 *
 * Three jobs:
 *  1. Acknowledge the sale with the 200sp "takk." hero
 *  2. Surface the physical-reality advisory about products that get
 *     stuck in the corners of the delivery flap
 *  3. Offer the customer a quiet "vantar vöru?" entry point if
 *     something didn't dispense
 *
 * Timer is 20 seconds (was 8). Customers need time to bend down,
 * fetch products, read the advisory, decide whether to complain.
 * Tapping the complaint icon cancels the auto-return.
 *
 * The screen no longer shows dispense-slot pills. When real dispense
 * is wired (Weimi serial SDK), not every slot in the basket will
 * necessarily dispense successfully — surfacing slot numbers here
 * would create false confidence. The complaint flow handles failures.
 */
@Composable
fun SuccessScreen(
    transaction: CompletedTransaction?,
    brand: String,
    currentTime: String,
    connectionState: ConnectionState,
    language: Language,
    onAutoReturn: () -> Unit,
    onComplain: () -> Unit,
    onClockLongPress: () -> Unit = {},
) {
    LaunchedEffect(Unit) {
        delay(20_000)
        onAutoReturn()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AppColors.Cream),
    ) {
        StatusBar(
            brand = brand,
            time = currentTime,
            connectionState = connectionState,
            onClockLongPress = onClockLongPress,
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 40.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = buildAnnotatedString {
                    withStyle(SpanStyle(color = AppColors.Ink)) { append(localized(language, R.string.success_takk)) }
                    withStyle(SpanStyle(color = AppColors.Bronze)) { append(".") }
                },
                style = AppTypography.DisplayLarge.copy(fontSize = 200.sp),
            )

            Spacer(Modifier.height(28.dp))

            Text(
                text = localized(language, R.string.success_in_bin),
                fontSize = 20.sp,
                color = AppColors.MutedSoft,
            )

            Spacer(Modifier.height(36.dp))

            // Corner advisory — soft bronze-tinted box, italic Cormorant
            AdvisoryBlock(language)

            // Suppress the complaint entry if for some reason we don't have a
            // transaction record (shouldn't happen in practice, but the screen
            // shouldn't blow up if it does).
            if (transaction != null && transaction.items.isNotEmpty()) {
                Spacer(Modifier.height(36.dp))
                ComplaintEntry(language = language, onClick = onComplain)
            }
        }
    }
}

@Composable
private fun AdvisoryBlock(language: Language) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                color = Color(0x148B6B3E),  // ~8% bronze
                shape = RoundedCornerShape(14.dp),
            )
            .padding(horizontal = 24.dp, vertical = 18.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = localized(language, R.string.success_corner_advisory),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.Medium,
            fontSize = 18.sp,
            lineHeight = 24.sp,
            color = Color(0xFF5A4628),  // muted bronze ink
            modifier = Modifier.fillMaxWidth(),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

@Composable
private fun ComplaintEntry(language: Language, onClick: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Box(
            modifier = Modifier
                .size(36.dp)
                .background(Color.Transparent, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp),
                contentAlignment = Alignment.Center,
            ) {
                // Bronze ring with italic !
                androidx.compose.foundation.Canvas(modifier = Modifier.size(36.dp)) {
                    drawCircle(
                        color = AppColors.Bronze,
                        radius = (size.minDimension / 2) - 1.dp.toPx(),
                        style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.dp.toPx()),
                    )
                }
                Text(
                    text = "!",
                    fontFamily = AppFonts.Cormorant,
                    fontStyle = FontStyle.Italic,
                    fontSize = 20.sp,
                    color = AppColors.Bronze,
                )
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(
            text = localized(language, R.string.success_missing_item),
            fontFamily = AppFonts.Geist,
            fontSize = 12.sp,
            color = AppColors.Bronze,
            letterSpacing = 0.3.sp,
        )
    }
}
