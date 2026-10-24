package isl.snudursopi.vending.ui.screens.complaint

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.vending.domain.ConnectionState
import isl.snudursopi.vending.domain.Language
import isl.snudursopi.vending.R
import isl.snudursopi.vending.ui.util.localized
import isl.snudursopi.vending.ui.components.StatusBar
import isl.snudursopi.vending.ui.state.ComplaintSubmissionState
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts
import kotlinx.coroutines.delay

/**
 * Confirmation that the customer's complaint was received (or queued for
 * later delivery — either way, it'll reach the operator).
 *
 * 6-second auto-close back to Browse. Customer is done; the next they'll
 * hear is the operator's email reply.
 */
@Composable
fun ComplaintConfirmationScreen(
    submissionState: ComplaintSubmissionState,
    brand: String,
    currentTime: String,
    connectionState: ConnectionState,
    language: Language,
    onAutoReturn: () -> Unit,
    onClockLongPress: () -> Unit = {},
) {
    LaunchedEffect(Unit) {
        delay(6_000)
        onAutoReturn()
    }

    // We render the same confirmation for "accepted by backend right now"
    // and "queued for retry" — the customer doesn't need to know the
    // difference, and showing two different states would erode trust
    // ("did it actually go through?").
    val accepted = submissionState as? ComplaintSubmissionState.Accepted

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
                .padding(horizontal = 40.dp, vertical = 60.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            // Bronze ring with check — visually distinct from the green
            // success-screen check (this is a "we got your message" tone,
            // not "transaction complete")
            Box(
                modifier = Modifier
                    .size(72.dp)
                    .border(1.5.dp, AppColors.Bronze, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "✓",
                    color = AppColors.Bronze,
                    fontSize = 32.sp,
                    fontFamily = AppFonts.Cormorant,
                    fontStyle = FontStyle.Italic,
                )
            }

            Spacer(Modifier.height(28.dp))

            Text(
                text = localized(language, R.string.complaint_received),
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontWeight = FontWeight.Medium,
                fontSize = 40.sp,
                color = AppColors.Ink,
                lineHeight = 44.sp,
            )

            Spacer(Modifier.height(16.dp))

            Text(
                text = localized(language, R.string.complaint_received_sub),
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 18.sp,
                color = AppColors.MutedSoft,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                lineHeight = 24.sp,
            )

            // If queued (not yet delivered), show a quieter subtext so the
            // diagnostics view can correlate. Customer doesn't see "queued"
            // text — they see the same message either way.
            if (accepted?.queued == true) {
                Spacer(Modifier.height(20.dp))
                Text(
                    text = "•",
                    fontSize = 12.sp,
                    color = AppColors.MutedSoft,
                )
            }
        }
    }
}
