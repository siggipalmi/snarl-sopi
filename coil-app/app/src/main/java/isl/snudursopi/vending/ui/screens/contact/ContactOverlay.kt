package isl.snudursopi.vending.ui.screens.contact

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import isl.snudursopi.vending.R
import isl.snudursopi.vending.domain.Language
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts
import isl.snudursopi.vending.ui.theme.AppTypography
import isl.snudursopi.vending.ui.util.localized

/**
 * Contact / info overlay (the info icon). Two parts:
 *  1. The SUB-OPERATOR running this machine (from backend config profile) —
 *     operator line + support email + machine id. Falls back to a generic
 *     line when the operator name is blank.
 *  2. The AG Vending house ad — three machine photos, leasing pitch, and a
 *     QR code to agvending.is. Always shown.
 *
 * Fully bilingual via [localized] (EN/IS toggle).
 */
private val MACHINE_IMAGE_URLS = listOf(
    "https://images.squarespace-cdn.com/content/v1/634bcf28ebe037184f7ca533/f9270c22-6644-4f74-bdc8-3da27e8aae0e/sjalfsali1taeki-transp.png",
    "https://images.squarespace-cdn.com/content/v1/634bcf28ebe037184f7ca533/01ebeb8f-a12a-4326-9baf-b964ce1a65bb/tvofaldur-hviturbg-2.png",
    "https://images.squarespace-cdn.com/content/v1/634bcf28ebe037184f7ca533/357fd8d0-dda5-4a43-8f2f-01f84e7a28b0/einfaldur-hviturbg-3.png",
)

@Composable
fun ContactOverlay(
    operatorName: String,
    email: String,
    machineId: String,
    language: Language,
    onClose: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(AppColors.Ink.copy(alpha = 0.45f))
            .clickable(onClick = onClose),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp))
                .background(AppColors.Cream)
                .clickable(enabled = false) {}
                .verticalScroll(rememberScrollState())
                .padding(start = 40.dp, end = 40.dp, top = 24.dp, bottom = 40.dp),
        ) {
            Box(
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .size(width = 56.dp, height = 5.dp)
                    .background(AppColors.Clay, RoundedCornerShape(3.dp)),
            )
            Spacer(Modifier.height(28.dp))

            Text(
                text = localized(language, R.string.contact_title),
                style = AppTypography.DisplayMedium.copy(fontSize = 48.sp),
                color = AppColors.Ink,
            )
            Spacer(Modifier.height(20.dp))

            // Operator line — uses the operator name when present, else generic.
            Text(
                text = if (operatorName.isNotBlank()) {
                    localized(language, R.string.contact_operated_by, operatorName)
                } else {
                    localized(language, R.string.contact_operated_by_generic)
                },
                fontSize = 17.sp,
                lineHeight = 26.sp,
                color = AppColors.InkSoft,
            )
            Spacer(Modifier.height(24.dp))

            ContactField(
                label = localized(language, R.string.contact_email_label),
                value = email,
                accent = true,
            )
            Spacer(Modifier.height(12.dp))
            ContactField(
                label = localized(language, R.string.contact_machine_label),
                value = machineId,
                accent = false,
            )

            // ---- Divider: in partnership with ----
            Spacer(Modifier.height(26.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(0.5.dp)
                        .background(AppColors.Line),
                )
                Text(
                    text = localized(language, R.string.contact_partner_divider).uppercase(),
                    fontSize = 10.sp,
                    letterSpacing = 1.4.sp,
                    color = AppColors.Muted,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .height(0.5.dp)
                        .background(AppColors.Line),
                )
            }
            Spacer(Modifier.height(22.dp))

            // ---- AG Vending ad block ----
            AgVendingAd(language = language)

            Spacer(Modifier.height(26.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(62.dp)
                    .background(AppColors.Ink, RoundedCornerShape(16.dp))
                    .clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = localized(language, R.string.contact_close),
                    color = AppColors.Cream,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

@Composable
private fun AgVendingAd(language: Language) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(
                Brush.linearGradient(
                    colors = listOf(AppColors.CreamShadow, AppColors.Clay),
                )
            )
            .padding(22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Three machine photos side by side.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(150.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.Bottom,
        ) {
            MACHINE_IMAGE_URLS.forEach { url ->
                AsyncImage(
                    model = url,
                    contentDescription = null,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxSize(),
                    contentScale = ContentScale.Fit,
                )
            }
        }
        Spacer(Modifier.height(16.dp))

        Text(
            text = localized(language, R.string.contact_ad_pitch),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.SemiBold,
            fontSize = 21.sp,
            lineHeight = 26.sp,
            color = AppColors.Ink,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = localized(language, R.string.contact_ad_sub),
            fontSize = 14.sp,
            lineHeight = 20.sp,
            color = AppColors.InkSoft,
        )
        Spacer(Modifier.height(18.dp))

        // QR + caption.
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(96.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(AppColors.White)
                    .padding(7.dp),
                contentAlignment = Alignment.Center,
            ) {
                AsyncImage(
                    model = R.drawable.agvending_qr,
                    contentDescription = "agvending.is QR",
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Fit,
                )
            }
            Spacer(Modifier.width(16.dp))
            Column {
                Text(
                    text = "agvending.is",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = AppColors.Bronze,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = localized(language, R.string.contact_ad_qr_caption),
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    color = AppColors.Muted,
                )
            }
        }
    }
}

@Composable
private fun ContactField(label: String, value: String, accent: Boolean) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(AppColors.White, RoundedCornerShape(16.dp))
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(16.dp))
            .padding(horizontal = 22.dp, vertical = 16.dp),
    ) {
        Text(
            text = label,
            fontSize = 13.sp,
            letterSpacing = 1.5.sp,
            color = AppColors.MutedSoft,
            fontWeight = FontWeight.Medium,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = value,
            fontSize = 22.sp,
            color = if (accent) AppColors.Bronze else AppColors.Ink,
            fontWeight = FontWeight.Medium,
        )
    }
}
