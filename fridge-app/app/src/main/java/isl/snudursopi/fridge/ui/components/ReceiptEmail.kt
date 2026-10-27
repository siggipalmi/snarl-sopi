package isl.snudursopi.fridge.ui.components

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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.fridge.R
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.ui.state.FridgeUiState
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import isl.snudursopi.fridge.ui.util.localized
import kotlinx.coroutines.delay

/**
 * Email receipt — the button on the receipt screen, the address form, and the
 * confirmation. Laid out from the mockup Siggi approved on 2026-10-02.
 */

/** One-tap domains, because typing on a fridge panel is the slow part. */
private val DOMAINS = listOf("@gmail.com", "@hotmail.com", "@simnet.is", "@outlook.com")

/**
 * *** BIG AND BRICK RED, ON PURPOSE. After the amount it is the strongest thing
 * on the receipt screen — Siggi asked for it bigger and red on the mockup. The
 * red is a warmer cousin of Alert, so it invites rather than warns.
 */
@Composable
fun ReceiptEmailButton(language: Language, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(14.dp))
            .background(AppColors.BrickDeep)
            .clickable(onClick = onClick)
            // The darker strip left showing below is the button's "edge".
            .padding(bottom = 4.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(AppColors.Brick)
            .padding(horizontal = 34.dp, vertical = 16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("✉", fontSize = 26.sp, color = AppColors.White)
            Spacer(Modifier.width(14.dp))
            Text(
                localized(language, R.string.receipt_email_button),
                fontSize = 22.sp,
                fontWeight = FontWeight.SemiBold,
                color = AppColors.White,
            )
        }
    }
}

/**
 * Thin bar and a quiet label showing when the screen returns to idle. Without
 * it a customer reaching for the button can have the screen vanish under them.
 */
@Composable
fun IdleCountdown(state: FridgeUiState, totalMs: Long, modifier: Modifier = Modifier) {
    val at = state.idleReturnAtMs ?: return
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(at) {
        while (true) {
            now = System.currentTimeMillis()
            delay(200)
        }
    }
    val leftMs = (at - now).coerceAtLeast(0)
    val fraction = (leftMs.toFloat() / totalMs).coerceIn(0f, 1f)
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        Text(
            localized(state.language, R.string.receipt_returning, ((leftMs + 999) / 1000).toInt()),
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            color = AppColors.Muted,
        )
        Spacer(Modifier.height(4.dp))
        Box(Modifier.fillMaxWidth().height(4.dp).background(AppColors.Line)) {
            Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().background(AppColors.Clay))
        }
    }
}

@Composable
fun ReceiptEmailForm(
    state: FridgeUiState,
    onEmail: (String) -> Unit,
    onDomain: (String) -> Unit,
    onCancel: () -> Unit,
    onSend: () -> Unit,
) {
    val d = state.receipt
    val focus = remember { FocusRequester() }
    // Straight to the keyboard: the only thing to do on this screen is type.
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    // Opaque and IME-aware for the same reason as the complaint form: the
    // manifest's adjustResize shrinks this window when the keyboard opens.
    Column(
        Modifier
            .fillMaxSize()
            .background(AppColors.Cream)
            .imePadding()
            .padding(horizontal = 44.dp, vertical = 30.dp),
    ) {
        Text(
            localized(state.language, R.string.receipt_email_title),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.Medium,
            fontSize = 36.sp,
            color = AppColors.InkSoft,
        )
        Spacer(Modifier.height(14.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .height(62.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(AppColors.White)
                .border(2.dp, if (d.invalid || d.error) AppColors.Alert else AppColors.Ink, RoundedCornerShape(12.dp))
                .padding(horizontal = 18.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (d.email.isEmpty()) {
                Text(localized(state.language, R.string.receipt_email_hint), fontSize = 20.sp, color = AppColors.Clay)
            }
            BasicTextField(
                value = d.email,
                onValueChange = onEmail,
                singleLine = true,
                textStyle = TextStyle(fontSize = 22.sp, fontFamily = FontFamily.Monospace, color = AppColors.Ink),
                cursorBrush = SolidColor(AppColors.Bronze),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSend() }),
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
            )
        }
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            DOMAINS.forEach { dom ->
                Box(
                    Modifier
                        .clip(RoundedCornerShape(50))
                        .background(AppColors.White)
                        .border(1.dp, AppColors.Clay, RoundedCornerShape(50))
                        .clickable { onDomain(dom) }
                        .padding(horizontal = 16.dp, vertical = 9.dp),
                ) {
                    Text(dom, fontSize = 15.sp, fontFamily = FontFamily.Monospace, color = AppColors.InkSoft)
                }
            }
        }
        Spacer(Modifier.height(10.dp))
        val note = when {
            d.invalid -> R.string.receipt_email_invalid
            d.error -> R.string.receipt_email_failed
            else -> R.string.receipt_email_note
        }
        Text(
            localized(state.language, note),
            fontSize = 13.sp,
            color = if (d.invalid || d.error) AppColors.Alert else AppColors.Muted,
        )
        Spacer(Modifier.weight(1f, fill = false))
        Spacer(Modifier.height(16.dp))
        // Fixed height: with the keyboard up there is no spare space, and a
        // button squeezed to nothing is worse than a shorter gap above it.
        Row(Modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FormButton(
                label = localized(state.language, R.string.receipt_email_cancel),
                primary = false,
                modifier = Modifier.weight(1f),
                onClick = onCancel,
            )
            FormButton(
                label = localized(state.language, R.string.receipt_email_send),
                primary = true,
                enabled = d.email.isNotBlank() && !d.sending,
                modifier = Modifier.weight(1f),
                onClick = onSend,
            )
        }
    }
}

/**
 * Confirmation, with the FULL address. Siggi on the mockup: it is a
 * confirmation, not a password — showing it is how a typo gets caught.
 */
@Composable
fun ReceiptSent(state: FridgeUiState) {
    Column(
        Modifier.fillMaxSize().background(AppColors.Cream),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier.size(72.dp).clip(CircleShape).border(2.dp, AppColors.Bronze, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text("✓", fontSize = 30.sp, color = AppColors.Bronze)
        }
        Spacer(Modifier.height(24.dp))
        Text(
            localized(state.language, R.string.receipt_sent_title),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.Medium,
            fontSize = 44.sp,
            color = AppColors.Ink,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            localized(state.language, R.string.receipt_sent_to, state.receipt.email.trim()),
            fontSize = 22.sp,
            fontFamily = FontFamily.Monospace,
            color = AppColors.Ink,
        )
        if (state.receipt.queued) {
            Spacer(Modifier.height(10.dp))
            Text(localized(state.language, R.string.receipt_sent_queued), fontSize = 14.sp, color = AppColors.Muted)
        }
    }
}

@Composable
private fun FormButton(
    label: String,
    primary: Boolean,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val bg = when {
        !primary -> AppColors.Cream
        enabled -> AppColors.Ink
        else -> AppColors.Clay
    }
    Box(
        modifier
            .fillMaxHeight()
            .clip(RoundedCornerShape(10.dp))
            .background(bg)
            .border(1.dp, if (primary) bg else AppColors.Clay, RoundedCornerShape(10.dp))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 17.sp,
            fontWeight = FontWeight.Medium,
            color = if (primary) AppColors.White else AppColors.MutedSoft,
        )
    }
}
