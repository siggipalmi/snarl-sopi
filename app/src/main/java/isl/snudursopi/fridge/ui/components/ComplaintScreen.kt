package isl.snudursopi.fridge.ui.components

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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.fridge.R
import isl.snudursopi.fridge.domain.ComplaintReason
import isl.snudursopi.fridge.ui.state.ComplaintDraft
import isl.snudursopi.fridge.ui.state.FridgeUiState
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import isl.snudursopi.fridge.ui.util.localized
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType

/** Note ceiling. The backend accepts 500; 280 is what someone types at a door. */
private const val NOTE_MAX = 280

/**
 * The complaint form — UI 8.
 *
 * Two columns because the panel is 1280x720: wide and short. Coil's tall single
 * scroll would have put the send button below the fold on a screen that cannot
 * scroll comfortably with a door open in front of it.
 *
 * *** PRODUCTS FIRST, REASON BELOW. The customer has just seen these tiles on
 * the receipt, so the first block is recognition rather than an abstract
 * question, and the reason then narrows what they have already pointed at.
 * Decided from the mockup, not in the abstract.
 */
@Composable
fun ComplaintForm(
    state: FridgeUiState,
    onToggleLine: (Int) -> Unit,
    onReason: (ComplaintReason) -> Unit,
    onNote: (String) -> Unit,
    onEmail: (String) -> Unit,
    onCancel: () -> Unit,
    onSend: () -> Unit,
) {
    val d = state.complaint
    // *** OPAQUE, AND IME-AWARE.
    //
    // The manifest sets adjustResize, so the soft keyboard SHRINKS this window
    // rather than sliding over it. On the machine that squeezed the actions row
    // down to a two-pixel bronze line — the send button was technically present
    // and completely unusable. imePadding keeps the layout above the keyboard,
    // and the actions row below is given a real height instead of whatever is
    // left over.
    Column(
        Modifier
            .fillMaxSize()
            .background(AppColors.Cream)
            .imePadding()
            .padding(horizontal = 44.dp, vertical = 34.dp),
    ) {
        Text(
            localized(state.language, R.string.complaint_title),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.Medium,
            fontSize = 40.sp,
            letterSpacing = (-0.8).sp,
            color = AppColors.Ink,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            localized(state.language, R.string.complaint_sub),
            fontSize = 15.sp,
            color = AppColors.Muted,
        )
        Spacer(Modifier.height(16.dp))

        Row(Modifier.weight(1f)) {
            // ---------- left: what, then why ----------
            Column(Modifier.weight(1.35f).verticalScroll(rememberScrollState())) {
                BlockLabel(localized(state.language, R.string.complaint_which))
                state.receiptLines.forEachIndexed { i, line ->
                    LineRow(
                        name = state.cart.getOrNull(i)?.name ?: line.productId,
                        quantity = line.quantity,
                        isk = line.lineIsk,
                        selected = i in d.selectedLines,
                        onClick = { onToggleLine(i) },
                    )
                    Spacer(Modifier.height(8.dp))
                }
                Spacer(Modifier.height(8.dp))
                BlockLabel(localized(state.language, R.string.complaint_reason_label))
                // Six reasons in a 3x2 grid. A single row of six would give each
                // one a target too narrow for a fingertip.
                ComplaintReason.entries.chunked(3).forEach { row ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { r ->
                            ReasonCard(
                                label = localized(state.language, r.labelRes),
                                selected = d.reason == r,
                                modifier = Modifier.weight(1f),
                            ) { onReason(r) }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                }
            }

            Spacer(Modifier.width(26.dp))

            // ---------- right: note, email, actions ----------
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                BlockLabel(localized(state.language, R.string.complaint_note_label))
                Field(
                    value = d.note,
                    hint = localized(state.language, R.string.complaint_note_hint),
                    minHeight = 96.dp,
                ) { if (it.length <= NOTE_MAX) onNote(it) }
                Text(
                    "${d.note.length} / $NOTE_MAX",
                    fontSize = 11.sp,
                    color = AppColors.Muted,
                    textAlign = TextAlign.End,
                    modifier = Modifier.fillMaxWidth().padding(top = 5.dp),
                )
                Spacer(Modifier.height(16.dp))
                BlockLabel(localized(state.language, R.string.complaint_email_label))
                Field(
                    value = d.email,
                    hint = localized(state.language, R.string.complaint_email_hint),
                    minHeight = 44.dp,
                    singleLine = true,
                    done = true,
                    onChange = onEmail,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    localized(state.language, R.string.complaint_email_note),
                    fontSize = 11.5.sp,
                    color = AppColors.Muted,
                )
                if (d.error) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        localized(state.language, R.string.complaint_send_failed),
                        fontSize = 12.5.sp,
                        color = AppColors.Alert,
                    )
                }
                Spacer(Modifier.weight(1f, fill = false))
                Spacer(Modifier.height(16.dp))
                // Fixed height: with the keyboard up there is no spare space to
                // distribute, and a button that shrinks to nothing is worse than
                // one that pushes the note field smaller.
                Row(
                    Modifier.fillMaxWidth().height(54.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    ActionButton(
                        label = localized(state.language, R.string.complaint_cancel),
                        primary = false,
                        modifier = Modifier.weight(1f),
                        onClick = onCancel,
                    )
                    ActionButton(
                        label = localized(state.language, R.string.complaint_send),
                        primary = true,
                        // A complaint with no line selected has nothing to point
                        // at, and the backend requires a populated lines array.
                        enabled = d.selectedLines.isNotEmpty() && !d.sending,
                        modifier = Modifier.weight(1f),
                        onClick = onSend,
                    )
                }
            }
        }
    }
}

/**
 * Confirmation.
 *
 * *** BRONZE RING, NOT THE GREEN TICK. Green is this app's "settled, money
 * taken" signal and appears nowhere else. Reusing it here would tell a customer
 * who has just reported a problem that something completed successfully.
 */
@Composable
fun ComplaintDone(state: FridgeUiState) {
    Column(
        Modifier.fillMaxSize().background(AppColors.Cream),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier.size(72.dp).clip(CircleShape)
                .border(2.dp, AppColors.Bronze, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text("✓", fontSize = 30.sp, color = AppColors.Bronze)
        }
        Spacer(Modifier.height(26.dp))
        Text(
            localized(state.language, R.string.complaint_done_title),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.Medium,
            fontSize = 44.sp,
            color = AppColors.Ink,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            localized(state.language, R.string.complaint_done_sub),
            fontSize = 15.sp,
            color = AppColors.Muted,
        )
        // Blank when the complaint was QUEUED rather than delivered: the backend
        // mints the id on receipt, so we have nothing honest to show yet. Better
        // no reference than a made-up one.
        if (state.complaint.reference.isNotBlank()) {
            Spacer(Modifier.height(30.dp))
            Text(
                localized(state.language, R.string.complaint_reference) +
                    "  " + state.complaint.reference,
                fontSize = 11.sp,
                letterSpacing = 0.5.sp,
                color = AppColors.Clay,
            )
        }
    }
}

// ---------------------------------------------------------------- small parts

@Composable
private fun BlockLabel(text: String) {
    Text(
        text,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        color = AppColors.InkSoft,
        modifier = Modifier.padding(bottom = 8.dp),
    )
}

@Composable
private fun LineRow(
    name: String,
    quantity: Int,
    isk: Int,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(AppColors.White)
            .border(
                if (selected) 1.5.dp else 1.dp,
                if (selected) AppColors.Ink else AppColors.Line,
                RoundedCornerShape(10.dp),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(19.dp).clip(RoundedCornerShape(5.dp))
                .background(if (selected) AppColors.Ink else AppColors.White)
                .border(
                    1.5.dp,
                    if (selected) AppColors.Ink else AppColors.Clay,
                    RoundedCornerShape(5.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) Text("✓", fontSize = 11.sp, color = AppColors.White)
        }
        Spacer(Modifier.width(14.dp))
        Text(name, fontSize = 14.sp, color = AppColors.Ink, modifier = Modifier.weight(1f))
        Text("×$quantity", fontSize = 12.sp, color = AppColors.Muted)
        Spacer(Modifier.width(14.dp))
        Text("$isk kr", fontSize = 13.sp, color = AppColors.InkSoft)
    }
}

@Composable
private fun ReasonCard(
    label: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Box(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(AppColors.White)
            .border(
                if (selected) 1.5.dp else 1.dp,
                if (selected) AppColors.Ink else AppColors.Line,
                RoundedCornerShape(10.dp),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 13.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 12.5.sp,
            textAlign = TextAlign.Center,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
            color = if (selected) AppColors.Ink else AppColors.InkSoft,
        )
    }
}

/**
 * [done] wires the keyboard's action key to dismissing itself. Without it the
 * green tick on the soft keyboard does nothing and the customer has no way to
 * put the keyboard away — which, on a panel with no navigation bar, means no
 * back gesture either. The only remaining route would be tapping a field-free
 * area and hoping.
 */
@Composable
private fun Field(
    value: String,
    hint: String,
    minHeight: androidx.compose.ui.unit.Dp,
    singleLine: Boolean = false,
    done: Boolean = false,
    onChange: (String) -> Unit,
) {
    // clearFocus() alone dismisses the keyboard, so no need for
    // LocalSoftwareKeyboardController — which carries an experimental opt-in on
    // some Compose versions and is not worth the risk for the same result.
    val focus = LocalFocusManager.current
    Box(
        Modifier.fillMaxWidth()
            .height(minHeight)
            .clip(RoundedCornerShape(10.dp))
            .background(AppColors.White)
            .border(1.dp, AppColors.Line, RoundedCornerShape(10.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        if (value.isEmpty()) {
            Text(hint, fontSize = 13.5.sp, color = AppColors.Clay)
        }
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = singleLine,
            textStyle = TextStyle(fontSize = 13.5.sp, color = AppColors.Ink),
            cursorBrush = SolidColor(AppColors.Bronze),
            keyboardOptions = if (done) {
                KeyboardOptions(
                    keyboardType = KeyboardType.Email,
                    imeAction = ImeAction.Done,
                )
            } else {
                KeyboardOptions.Default
            },
            keyboardActions = KeyboardActions(
                onDone = { focus.clearFocus() },
            ),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun ActionButton(
    label: String,
    primary: Boolean,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val bg = when {
        !primary -> AppColors.Cream
        enabled -> AppColors.Bronze
        else -> AppColors.Clay
    }
    Box(
        modifier
            .clip(RoundedCornerShape(9.dp))
            .background(bg)
            .border(
                1.dp,
                if (primary) bg else AppColors.Clay,
                RoundedCornerShape(9.dp),
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(vertical = 15.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            color = if (primary) AppColors.White else AppColors.MutedSoft,
        )
    }
}
