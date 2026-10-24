package isl.snudursopi.vending.ui.screens.complaint

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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.vending.domain.ConnectionState
import isl.snudursopi.vending.domain.Language
import isl.snudursopi.vending.R
import isl.snudursopi.vending.ui.util.localized
import isl.snudursopi.vending.ui.components.StatusBar
import isl.snudursopi.vending.ui.state.ComplaintSubmissionState
import isl.snudursopi.vending.ui.state.CompletedTransaction
import isl.snudursopi.vending.ui.state.CompletedTransactionItem
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts

/**
 * Complaint form screen.
 *
 * Three sections, stacked: items the customer picks (checkboxes, multi-select),
 * optional free-text "athugasemd", and email (required).
 *
 * If [transaction] has only one item, the checkbox UI collapses to a
 * single locked-in row (singular: "vara sem kom ekki út").
 *
 * Submit is disabled until ≥1 item is selected AND a plausible-looking
 * email is entered. Submit shows a spinner during the in-flight request.
 * On Accepted, [onAcceptedNavigate] fires — caller routes to the
 * confirmation screen.
 *
 * Root layout uses `imePadding()` so the bottom buttons remain reachable
 * when the soft keyboard opens (lessons from setup screen).
 */
@Composable
fun ComplaintFormScreen(
    transaction: CompletedTransaction?,
    submissionState: ComplaintSubmissionState,
    brand: String,
    currentTime: String,
    connectionState: ConnectionState,
    language: Language,
    onSubmit: (items: List<CompletedTransactionItem>, note: String?, email: String) -> Unit,
    onCancel: () -> Unit,
    onAcceptedNavigate: () -> Unit,
    onClockLongPress: () -> Unit = {},
) {
    // Defensive: if there's no transaction (shouldn't happen), bail
    if (transaction == null || transaction.items.isEmpty()) {
        LaunchedEffect(Unit) { onCancel() }
        return
    }

    val isSingleItem = transaction.items.size == 1
    // Tracking selection by goodsId — survives composition. When single
    // item, prepopulate. When multi, start unselected.
    val selectedIds = remember {
        mutableStateOf(
            if (isSingleItem) setOf(transaction.items.first().goodsId)
            else emptySet()
        )
    }
    var note by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }

    // When the submission flips to Accepted, navigate forward
    LaunchedEffect(submissionState) {
        if (submissionState is ComplaintSubmissionState.Accepted) {
            onAcceptedNavigate()
        }
    }

    val isSubmitting = submissionState is ComplaintSubmissionState.Submitting
    val canSubmit = !isSubmitting &&
        selectedIds.value.isNotEmpty() &&
        looksLikeEmail(email)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AppColors.Cream)
            .imePadding(),
    ) {
        StatusBar(
            brand = brand,
            time = currentTime,
            connectionState = connectionState,
            onClockLongPress = onClockLongPress,
        )

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 32.dp, vertical = 24.dp),
        ) {
            // Title
            Text(
                text = if (isSingleItem) localized(language, R.string.complaint_title_single) else localized(language, R.string.complaint_title_multi),
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontWeight = FontWeight.Medium,
                fontSize = 44.sp,
                color = AppColors.Ink,
                lineHeight = 48.sp,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = localized(language, R.string.complaint_subtitle),
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 18.sp,
                color = AppColors.MutedSoft,
            )

            Spacer(Modifier.height(28.dp))

            // ITEMS
            FieldLabel(
                if (isSingleItem) localized(language, R.string.complaint_which_single)
                else localized(language, R.string.complaint_which_multi)
            )
            transaction.items.forEach { item ->
                ItemRow(
                    item = item,
                    selected = selectedIds.value.contains(item.goodsId),
                    locked = isSingleItem,
                    onToggle = {
                        if (isSingleItem) return@ItemRow
                        selectedIds.value = if (selectedIds.value.contains(item.goodsId)) {
                            selectedIds.value - item.goodsId
                        } else {
                            selectedIds.value + item.goodsId
                        }
                    },
                )
            }

            Spacer(Modifier.height(20.dp))

            // OPTIONAL NOTE
            FieldLabel(localized(language, R.string.complaint_note_label))
            TextArea(
                value = note,
                onValueChange = { if (it.length <= 280) note = it },
                placeholder = localized(language, R.string.complaint_note_placeholder),
            )

            Spacer(Modifier.height(20.dp))

            // EMAIL
            FieldLabel(localized(language, R.string.complaint_email_label))
            TextLine(
                value = email,
                onValueChange = { email = it },
                placeholder = localized(language, R.string.complaint_email_placeholder),
                keyboardType = KeyboardType.Email,
                imeAction = ImeAction.Done,
                onImeDone = {
                    if (canSubmit) {
                        onSubmit(
                            transaction.items.filter { selectedIds.value.contains(it.goodsId) },
                            note,
                            email,
                        )
                    }
                },
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = localized(language, R.string.complaint_email_note),
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 13.sp,
                color = AppColors.MutedSoft,
            )

            // Failure message (form-screen variant, before navigating away)
            if (submissionState is ComplaintSubmissionState.Failed) {
                Spacer(Modifier.height(14.dp))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0x1AC4501A), RoundedCornerShape(10.dp))
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    Text(
                        text = localized(language, R.string.complaint_send_failed),
                        fontFamily = AppFonts.Cormorant,
                        fontStyle = FontStyle.Italic,
                        fontSize = 14.sp,
                        color = Color(0xFF8B2C0A),
                    )
                }
            }
        }

        // ===== BUTTONS =====
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 32.dp, vertical = 20.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SecondaryButton(
                label = localized(language, R.string.complaint_cancel),
                onClick = onCancel,
                modifier = Modifier.weight(1f),
            )
            SubmitButton(
                label = localized(language, R.string.complaint_send),
                enabled = canSubmit,
                isSubmitting = isSubmitting,
                onClick = {
                    onSubmit(
                        transaction.items.filter { selectedIds.value.contains(it.goodsId) },
                        note,
                        email,
                    )
                },
                modifier = Modifier.weight(1f),
            )
        }
    }
}

// ---- subcomponents ----

@Composable
private fun FieldLabel(text: String) {
    Text(
        text = text.uppercase(),
        fontFamily = AppFonts.Geist,
        fontSize = 11.sp,
        letterSpacing = 1.5.sp,
        fontWeight = FontWeight.Medium,
        color = AppColors.MutedSoft,
        modifier = Modifier.padding(bottom = 8.dp),
    )
}

@Composable
private fun ItemRow(
    item: CompletedTransactionItem,
    selected: Boolean,
    locked: Boolean,
    onToggle: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 6.dp)
            .background(AppColors.White, RoundedCornerShape(10.dp))
            .border(
                width = 0.5.dp,
                color = if (selected) AppColors.Ink else AppColors.Line,
                shape = RoundedCornerShape(10.dp),
            )
            .clickable(enabled = !locked, onClick = onToggle)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(18.dp)
                .background(
                    color = if (selected) AppColors.Ink else Color.Transparent,
                    shape = RoundedCornerShape(4.dp),
                )
                .border(
                    width = 1.dp,
                    color = if (selected) AppColors.Ink else AppColors.MutedSoft,
                    shape = RoundedCornerShape(4.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) {
                Text(
                    text = "✓",
                    color = AppColors.Cream,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
        Spacer(Modifier.size(12.dp))
        Text(
            text = item.name,
            fontFamily = AppFonts.Geist,
            fontSize = 15.sp,
            color = AppColors.Ink,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = "${item.priceIsk} kr",
            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
            fontSize = 12.sp,
            color = AppColors.MutedSoft,
        )
    }
}

@Composable
private fun TextArea(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(72.dp)
            .background(AppColors.White, RoundedCornerShape(10.dp))
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(10.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        if (value.isEmpty()) {
            Text(
                text = placeholder,
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 14.sp,
                color = AppColors.MutedSoft,
            )
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            textStyle = TextStyle(
                fontSize = 15.sp,
                color = AppColors.Ink,
                fontFamily = AppFonts.Geist,
            ),
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
private fun TextLine(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    keyboardType: KeyboardType,
    imeAction: ImeAction,
    onImeDone: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(AppColors.White, RoundedCornerShape(10.dp))
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(10.dp))
            .padding(horizontal = 14.dp, vertical = 14.dp),
    ) {
        if (value.isEmpty()) {
            Text(
                text = placeholder,
                fontFamily = AppFonts.Geist,
                fontSize = 15.sp,
                color = AppColors.MutedSoft,
            )
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            textStyle = TextStyle(
                fontSize = 15.sp,
                color = AppColors.Ink,
                fontFamily = AppFonts.Geist,
            ),
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = keyboardType,
                imeAction = imeAction,
            ),
            keyboardActions = KeyboardActions(onDone = { onImeDone() }),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun SecondaryButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .height(52.dp)
            .background(AppColors.Cream, RoundedCornerShape(26.dp))
            .border(0.5.dp, AppColors.MutedSoft, RoundedCornerShape(26.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = AppColors.MutedSoft,
            fontFamily = AppFonts.Geist,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun SubmitButton(
    label: String,
    enabled: Boolean,
    isSubmitting: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .height(52.dp)
            .background(
                if (enabled) AppColors.Ink else AppColors.Clay,
                RoundedCornerShape(26.dp),
            )
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (isSubmitting) {
            CircularProgressIndicator(
                color = AppColors.Cream,
                strokeWidth = 1.5.dp,
                modifier = Modifier.size(18.dp),
            )
        } else {
            Text(
                text = label,
                color = AppColors.Cream,
                fontFamily = AppFonts.Geist,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}

/**
 * Light-touch email validity check. Real validation is the backend's job;
 * this just gates the submit button so customers can't fire off obvious
 * typos.
 */
private fun looksLikeEmail(s: String): Boolean {
    val trimmed = s.trim()
    if (trimmed.length < 5) return false
    val at = trimmed.indexOf('@')
    if (at <= 0 || at == trimmed.length - 1) return false
    val dot = trimmed.indexOf('.', startIndex = at)
    return dot in (at + 2)..(trimmed.length - 2)
}
