package isl.snudursopi.fridge.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import coil.compose.AsyncImage
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.fridge.R
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.ui.state.FridgeUiState
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import isl.snudursopi.fridge.ui.util.localized

/**
 * The three machine photos in the ad panel.
 *
 * REMOTE URLs, exactly as the coil kiosk uses — they live on the AG Vending
 * website rather than in either app, so the marketing images can be changed
 * without shipping a build. Same list, so the two kiosks always advertise the
 * same range. If the machine is offline they simply don't render and the panel
 * falls back to its typographic form.
 */
private val MACHINE_IMAGE_URLS = listOf(
    "https://images.squarespace-cdn.com/content/v1/634bcf28ebe037184f7ca533/f9270c22-6644-4f74-bdc8-3da27e8aae0e/sjalfsali1taeki-transp.png",
    "https://images.squarespace-cdn.com/content/v1/634bcf28ebe037184f7ca533/01ebeb8f-a12a-4326-9baf-b964ce1a65bb/tvofaldur-hviturbg-2.png",
    "https://images.squarespace-cdn.com/content/v1/634bcf28ebe037184f7ca533/357fd8d0-dda5-4a43-8f2f-01f84e7a28b0/einfaldur-hviturbg-3.png",
)

/**
 * The ⓘ sheet: who runs this machine, how it works, and the AG Vending panel.
 *
 * Replicates the coil kiosk's ContactOverlay, with two deliberate differences.
 *
 * FIRST, IT TEACHES THE THREE STEPS in full sentences — including the one thing
 * a gravity fridge genuinely needs to say and no vending machine ever has to:
 * PUT SOMETHING BACK IN THE SAME BASKET AND YOU AREN'T CHARGED FOR IT. Customers
 * don't assume that, and the Weimi stock app's own tips say it too.
 *
 * SECOND, IT'S TWO COLUMNS. Coil scrolls down a phone-shaped screen; a 22"
 * landscape panel is very wide and very short, so the same content in one column
 * would need scrolling for no reason. How-it-works and contact on the left, the
 * ad on the right.
 */
@Composable
fun InfoSheet(state: FridgeUiState, onClose: () -> Unit) {
    Box(
        Modifier
            .fillMaxSize()
            // The scrim is also the dismiss target — a customer who opened this
            // by accident shouldn't have to find a button.
            .background(AppColors.Ink.copy(alpha = 0.45f))
            .clickable(onClick = onClose),
    ) {
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .fillMaxHeight(0.86f)
                .clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
                .background(AppColors.Cream)
                // Swallow taps on the sheet itself so they don't dismiss it.
                .clickable(enabled = false) {}
                .padding(44.dp),
        ) {
            Box(
                Modifier
                    .align(Alignment.CenterHorizontally)
                    .width(56.dp)
                    .height(5.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(AppColors.Clay),
            )
            Spacer(Modifier.height(28.dp))

            Row(Modifier.weight(1f)) {
                Column(Modifier.weight(1f).padding(end = 40.dp)) {
                    Text(
                        localized(state.language, R.string.info_title),
                        fontFamily = AppFonts.Cormorant,
                        fontStyle = FontStyle.Italic,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 52.sp,
                        color = AppColors.Ink,
                    )
                    Spacer(Modifier.height(10.dp))
                    Text(
                        if (state.operatorName.isNotBlank()) {
                            localized(state.language, R.string.info_operated_by, state.operatorName)
                        } else {
                            // No name configured: say the useful half rather than
                            // printing "operated by ." at a customer.
                            localized(state.language, R.string.info_operated_by_generic)
                        },
                        fontFamily = AppFonts.Geist,
                        fontSize = 18.sp,
                        color = AppColors.MutedSoft,
                    )

                    Spacer(Modifier.height(26.dp))
                    Steps(state.language)

                    Spacer(Modifier.height(24.dp))
                    if (state.supportEmail.isNotBlank()) {
                        Field(
                            localized(state.language, R.string.info_email_label),
                            state.supportEmail,
                            AppColors.Bronze,
                        )
                        Spacer(Modifier.height(10.dp))
                    }
                    if (state.machineLabel.isNotBlank()) {
                        Field(
                            localized(state.language, R.string.info_machine_label),
                            state.machineLabel,
                            AppColors.Ink,
                        )
                    }
                }

                Column(Modifier.weight(1f)) {
                    Divider(state.language)
                    Spacer(Modifier.height(16.dp))
                    Ad(state.language, Modifier.weight(1f))
                }
            }

            Spacer(Modifier.height(24.dp))
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(62.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(AppColors.Ink)
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    localized(state.language, R.string.close),
                    fontFamily = AppFonts.Geist,
                    fontWeight = FontWeight.Medium,
                    fontSize = 19.sp,
                    color = AppColors.Cream,
                )
            }
        }
    }
}

/** The three steps, in sentences rather than the strip's single words. */
@Composable
private fun Steps(language: Language) {
    val lines = listOf(
        R.string.step_pay to R.string.info_how_pay,
        R.string.step_open to R.string.info_how_open,
        R.string.step_take to R.string.info_how_take,
    )
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        lines.forEachIndexed { i, (wordRes, textRes) ->
            Row {
                Text(
                    "0${i + 1}",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    letterSpacing = 2.sp,
                    color = AppColors.BronzeLight,
                    modifier = Modifier.padding(top = 6.dp, end = 16.dp),
                )
                Column {
                    Text(
                        localized(language, wordRes),
                        fontFamily = AppFonts.Cormorant,
                        fontStyle = FontStyle.Italic,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 26.sp,
                        color = AppColors.Ink,
                    )
                    Text(
                        localized(language, textRes),
                        fontFamily = AppFonts.Geist,
                        fontSize = 17.sp,
                        color = AppColors.MutedSoft,
                    )
                }
            }
        }
    }
}

@Composable
private fun Field(label: String, value: String, valueColor: androidx.compose.ui.graphics.Color) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(AppColors.White)
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(10.dp))
            .padding(horizontal = 18.dp, vertical = 12.dp),
    ) {
        Text(
            label,
            fontFamily = AppFonts.Geist,
            fontSize = 12.sp,
            letterSpacing = 1.2.sp,
            color = AppColors.Muted,
        )
        Spacer(Modifier.height(3.dp))
        Text(
            value,
            fontFamily = AppFonts.Geist,
            fontWeight = FontWeight.Medium,
            fontSize = 21.sp,
            color = valueColor,
        )
    }
}

@Composable
private fun Divider(language: Language) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f).height(0.5.dp).background(AppColors.Line))
        Text(
            localized(language, R.string.info_partner_divider),
            fontFamily = AppFonts.Geist,
            fontSize = 12.sp,
            letterSpacing = 1.4.sp,
            color = AppColors.Muted,
            modifier = Modifier.padding(horizontal = 14.dp),
        )
        Box(Modifier.weight(1f).height(0.5.dp).background(AppColors.Line))
    }
}

@Composable
private fun Ad(language: Language, modifier: Modifier = Modifier) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(
                Brush.verticalGradient(listOf(AppColors.CreamShadow, AppColors.Clay)),
            )
            .padding(28.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        // Three machine photos, bottom-aligned so units of different heights sit
        // on a common floor rather than floating at different levels.
        Row(
            Modifier.fillMaxWidth().height(180.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.Bottom,
        ) {
            MACHINE_IMAGE_URLS.forEach { url ->
                AsyncImage(
                    model = url,
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.weight(1f).fillMaxSize(),
                )
            }
        }
        Spacer(Modifier.height(20.dp))

        Text(
            localized(language, R.string.info_ad_pitch),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.SemiBold,
            fontSize = 30.sp,
            color = AppColors.Ink,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            localized(language, R.string.info_ad_sub),
            fontFamily = AppFonts.Geist,
            fontSize = 17.sp,
            color = AppColors.MutedSoft,
        )
        Spacer(Modifier.height(22.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(112.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(AppColors.White)
                    .padding(8.dp),
            ) {
                Image(
                    painter = painterResource(R.drawable.agvending_qr),
                    contentDescription = null,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            Spacer(Modifier.width(20.dp))
            Column {
                Text(
                    "agvending.is",
                    fontFamily = AppFonts.Geist,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 22.sp,
                    color = AppColors.Bronze,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    localized(language, R.string.info_ad_qr_caption),
                    fontFamily = AppFonts.Geist,
                    fontSize = 14.sp,
                    textAlign = TextAlign.Start,
                    color = AppColors.MutedSoft,
                )
            }
        }
    }
}
