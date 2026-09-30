package isl.snudursopi.fridge.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.fridge.R
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.domain.LanguageCycle
import isl.snudursopi.fridge.ui.components.CartTiles
import isl.snudursopi.fridge.ui.components.CloseDoorBanner
import isl.snudursopi.fridge.ui.components.AdminClock
import isl.snudursopi.fridge.ui.components.AdminSheet
import isl.snudursopi.fridge.ui.components.IdleMachine
import isl.snudursopi.fridge.ui.components.InfoButton
import isl.snudursopi.fridge.ui.components.InfoSheet
import isl.snudursopi.fridge.ui.components.idleNarrationIndex
import isl.snudursopi.fridge.ui.components.rememberIdleClock
import isl.snudursopi.fridge.ui.components.LanguagePill
import isl.snudursopi.fridge.ui.components.RestockScreen
import isl.snudursopi.fridge.ui.components.StepStrip
import isl.snudursopi.fridge.ui.components.stepForPhase
import isl.snudursopi.fridge.ui.state.FridgePhase
import isl.snudursopi.fridge.ui.state.FridgeUiState
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import isl.snudursopi.fridge.ui.util.localized
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import isl.snudursopi.fridge.ui.components.ComplaintForm
import isl.snudursopi.fridge.ui.components.ComplaintDone
import isl.snudursopi.fridge.domain.ComplaintReason

/**
 * Renders the current [FridgeUiState] as one full-screen kiosk view. Landscape,
 * cream/ink/bronze, Cormorant italic display + Geist body — matching the coil
 * app and the signed-off mockup. Copy comes from string resources in the
 * customer's chosen language — one language at a time, never stacked.
 */
@Composable
fun FridgeFlowScreen(
    state: FridgeUiState,
    onCycleLanguage: () -> Unit = {},
    onOpenInfo: () -> Unit = {},
    onCloseInfo: () -> Unit = {},
    // ---- complaint flow (UI 8) ----
    onComplaintOpen: () -> Unit = {},
    onComplaintToggleLine: (Int) -> Unit = {},
    onComplaintReason: (ComplaintReason) -> Unit = {},
    onComplaintNote: (String) -> Unit = {},
    onComplaintEmail: (String) -> Unit = {},
    onComplaintCancel: () -> Unit = {},
    onComplaintSend: () -> Unit = {},
) {
    // Admin is local UI state, not app state — it must work even if the backend
    // is unreachable, which is exactly when someone needs it.
    var showAdmin by remember { mutableStateOf(false) }

    /**
     * *** THE COMPLAINT FLOW OWNS THE WHOLE SCREEN.
     *
     * Everything else here is customer chrome for BUYING — the three-step strip,
     * the info button, the language pill. Leaving them up during a complaint put
     * "borga / opna / taka" and the step numbers behind a form about something
     * having gone wrong, which is both confusing and, with the keyboard up,
     * genuinely unreadable. Seen on the machine, not in the mockup: the mockup
     * had no chrome around it and no soft keyboard.
     *
     * Restock is the same idea for staff, hence one predicate for both.
     */
    // ONE clock for the whole screen: the idle animation and the step strip
    // both read it, so the numbers cannot drift from the picture they narrate.
    val idleClock = rememberIdleClock()

    val fullScreenPhase = state.phase == FridgePhase.RESTOCK ||
        state.phase == FridgePhase.COMPLAINT ||
        state.phase == FridgePhase.COMPLAINT_DONE
    Box(
        Modifier
            .fillMaxSize()
            .background(AppColors.Cream)
            .padding(44.dp)
    ) {
        Column(Modifier.fillMaxSize()) {
            // The weighted Box is load-bearing: it always takes whatever height
            // is left, so the strip sits at the bottom on EVERY phase. The
            // mockup had exactly this bug — on a phase with no hero and no cart,
            // nothing claimed the space and the strip floated up under the
            // headline.
            Box(Modifier.weight(1f).fillMaxWidth()) {
        when (state.phase) {
            FridgePhase.IDLE -> IdleView(state, idleClock)
            FridgePhase.AUTHORIZING -> Centered(
                language = state.language,
                titleRes = R.string.authorizing_title,
                subRes = R.string.authorizing_sub,
            )
            FridgePhase.UNLOCKED -> Centered(
                language = state.language,
                titleRes = R.string.unlocked_title,
                subRes = R.string.unlocked_sub,
                prominent = true,
            )
            FridgePhase.SHOPPING, FridgePhase.DOOR_OPEN_WARN ->
                ShoppingView(state, warn = state.phase == FridgePhase.DOOR_OPEN_WARN)
            FridgePhase.CALCULATING -> Centered(
                language = state.language,
                titleRes = R.string.calculating_title,
                subRes = R.string.calculating_sub,
            )
            FridgePhase.RECEIPT -> ReceiptView(state, onComplaint = onComplaintOpen)
            FridgePhase.COMPLAINT -> ComplaintForm(
                state = state,
                onToggleLine = onComplaintToggleLine,
                onReason = onComplaintReason,
                onNote = onComplaintNote,
                onEmail = onComplaintEmail,
                onCancel = onComplaintCancel,
                onSend = onComplaintSend,
            )
            FridgePhase.COMPLAINT_DONE -> ComplaintDone(state)
            FridgePhase.DECLINED -> Centered(
                language = state.language,
                titleRes = R.string.declined_title,
                subRes = R.string.declined_sub,
                accent = AppColors.Alert,
            )
            FridgePhase.SENSOR_FAULT -> Centered(
                language = state.language,
                titleRes = R.string.sensor_fault_title,
                subRes = R.string.sensor_fault_sub,
                accent = AppColors.Alert,
            )
            FridgePhase.PENDING_OFFLINE -> Centered(
                language = state.language,
                titleRes = R.string.pending_offline_title,
                subRes = R.string.pending_offline_sub,
            )
            // Placeholder until the designed restock screen lands with the UI
            // work. It only has to stop a passer-by thinking the fridge is open
            // for business while staff are refilling it.
            FridgePhase.RESTOCK -> RestockScreen(state)
            FridgePhase.NOTHING_TAKEN -> Centered(
                language = state.language,
                titleRes = R.string.nothing_taken_title,
                subRes = R.string.nothing_taken_sub,
            )
        }
            }

            // Hidden on the staff screen — the three steps are customer
            // instructions and mean nothing to someone refilling the shelves.
            if (!fullScreenPhase) {
                // *** ON IDLE, FOLLOW THE ANIMATION RATHER THAN THE PHASE.
                //
                // The phase is IDLE for the whole loop, so the strip used to sit
                // frozen on step 1 while the animation played all three beats
                // beside it. Driving it from the same clock makes the numbers
                // light in time with the card tapping, the doors opening and the
                // can leaving — one thing happening, described twice, instead of
                // two unrelated things sharing a screen.
                //
                // idleNarrationIndex is the SAME function the narration line
                // uses, so the words and the numbers can never drift apart.
                StepStrip(
                    language = state.language,
                    activeStep = if (state.phase == FridgePhase.IDLE) {
                        idleNarrationIndex(idleClock) + 1
                    } else {
                        stepForPhase(state.phase)
                    },
                )
            }
        }

        // Info button, bottom-LEFT — mirroring the language pill so the two
        // customer affordances sit in the corners nearest the hand rather than
        // competing with the content. Hidden during restock (staff screen).
        if (!fullScreenPhase) {
            InfoButton(
                onClick = onOpenInfo,
                modifier = Modifier.align(Alignment.BottomStart),
            )
        }

        // Language toggle, BOTTOM-right. It used to sit top-right, where it
        // overlapped the shopping total — and the bottom corner is the easier
        // reach on a panel this tall. Hidden on the restock screen (staff don't
        // need it) and when the machine only offers one language.
        if (!fullScreenPhase &&
            LanguageCycle.isToggleEnabled(state.availableLanguages)
        ) {
            LanguagePill(
                code = state.language.code,
                onClick = onCycleLanguage,
                modifier = Modifier.align(Alignment.BottomEnd),
            )
        }

        // The clock, top-left. Long-press is the way into admin — see AdminClock.
        AdminClock(
            onLongPress = { showAdmin = true },
            modifier = Modifier.align(Alignment.TopStart),
        )

        // Over everything, including the pill, the info button and the strip.
        if (state.showInfo) {
            InfoSheet(state, onClose = onCloseInfo)
        }
        if (showAdmin) {
            AdminSheet(
                onClose = { showAdmin = false },
                deviceCode = state.deviceCode,
                lastPollOkMs = state.lastPollOkMs,
            )
        }
    }
}

/**
 * Idle: the invitation above, the machine demonstrating itself below.
 *
 * The animation carries the explanation because a gravity fridge looks exactly
 * like a locked cooler — words alone don't overcome the assumption that the door
 * won't open.
 */
@Composable
private fun IdleView(state: FridgeUiState, t: Float) {

    Row(
        Modifier.fillMaxSize().padding(horizontal = 64.dp),
        verticalAlignment = Alignment.CenterVertically,
        // CENTRE THE PAIR, don't justify it. Giving the text weight(1f) made it
        // claim every spare pixel, so the machine was pushed to the far edge and
        // the leftover sat as a hole in the middle. Sizing the text and centring
        // the group instead means the words and the drawing read as ONE thing
        // with balanced margins, rather than two objects at opposite ends.
        horizontalArrangement = Arrangement.Center,
    ) {
        Column(
            // A FRACTION rather than a fixed width, so it scales if a machine
            // ever has a different panel — and fixed rather than wrap-content,
            // because the narration lines differ in length and a wrapping column
            // would shunt the machine sideways every time the line changed.
            Modifier.fillMaxWidth(TEXT_COLUMN_FRACTION),
            horizontalAlignment = Alignment.Start,
        ) {
            // Crossfade rather than a cut: the line changes while the machine is
            // mid-movement, and a hard swap reads as a glitch next to a smooth
            // animation.
            Crossfade(
                targetState = idleNarrationIndex(t),
                animationSpec = tween(durationMillis = 420),
                label = "narration",
            ) { index ->
                Text(
                    text = localized(
                        state.language,
                        when (index) {
                            0 -> R.string.idle_step1
                            1 -> R.string.idle_step2
                            else -> R.string.idle_step3
                        },
                    ),
                    fontFamily = AppFonts.Cormorant,
                    fontStyle = FontStyle.Italic,
                    // A real SemiBold cut, newly bundled. Cormorant is a
                    // high-contrast serif and reads thin at a distance on a
                    // bright panel; Medium disappeared across the room.
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 96.sp,
                    lineHeight = 102.sp,
                    letterSpacing = (-1.5).sp,
                    color = AppColors.Ink,
                )
            }
            Spacer(Modifier.height(20.dp))
            // The one line that stays put — the concrete "how", which the
            // cycling narration deliberately doesn't repeat.
            Text(
                text = localized(state.language, R.string.idle_sub),
                fontFamily = AppFonts.Geist,
                fontSize = 24.sp,
                color = AppColors.Muted,
            )
        }

        // A deliberate, single gap between the two — previously the space
        // between them was just whatever the text column didn't use, which is
        // why it drifted so wide.
        Spacer(Modifier.width(72.dp))

        // MACHINE RIGHT — takes exactly the width its drawing needs at full
        // height, so the pair can be centred as a unit.
        IdleMachine(
            cabinets = state.cabinetCount,
            t = t,
            modifier = Modifier.fillMaxHeight(),
        )
    }
}

@Composable
private fun Centered(
    language: Language,
    titleRes: Int,
    subRes: Int,
    accent: Color = AppColors.Ink,
    prominent: Boolean = false,
) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = localized(language, titleRes),
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontWeight = FontWeight.Medium,
                fontSize = if (prominent) 108.sp else 60.sp,
                lineHeight = if (prominent) 112.sp else 62.sp,
                textAlign = TextAlign.Center,
                color = accent,
            )
            Spacer(Modifier.height(18.dp))
            Text(
                text = localized(language, subRes),
                fontFamily = AppFonts.Geist,
                fontSize = if (prominent) 30.sp else 20.sp,
                textAlign = TextAlign.Center,
                color = AppColors.InkSoft,
            )
        }
    }
}

@Composable
private fun ShoppingView(state: FridgeUiState, warn: Boolean) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            Column {
                Text(
                    localized(state.language, R.string.shopping_title),
                    fontFamily = AppFonts.Cormorant,
                    fontStyle = FontStyle.Italic,
                    fontWeight = FontWeight.Medium,
                    fontSize = 40.sp,
                    color = AppColors.Ink,
                )
                Text(
                    localized(state.language, R.string.shopping_sub),
                    fontFamily = AppFonts.Geist,
                    fontSize = 14.sp,
                    color = AppColors.Muted,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    "${state.totalIsk} kr",
                    fontFamily = AppFonts.Cormorant,
                    fontStyle = FontStyle.Italic,
                    fontWeight = FontWeight.Medium,
                    fontSize = 40.sp,
                    color = AppColors.Ink,
                )
            }
        }
        Spacer(Modifier.height(20.dp))

        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            if (state.cart.isEmpty()) {
                // The door is open and they haven't taken anything yet. An empty
                // grid says "nothing here"; this says "go on". It's also the
                // moment the customer most needs telling that they simply help
                // themselves — nothing else on screen competes with it.
                Text(
                    text = localized(state.language, R.string.shopping_empty),
                    fontFamily = AppFonts.Cormorant,
                    fontStyle = FontStyle.Italic,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 88.sp,
                    lineHeight = 94.sp,
                    letterSpacing = (-1.5).sp,
                    textAlign = TextAlign.Center,
                    color = AppColors.Ink,
                )
            } else {
                CartTiles(state.cart, state.language, Modifier.fillMaxSize())
            }
        }

        Spacer(Modifier.height(16.dp))
        Text(
            text = localized(
                state.language,
                if (warn) R.string.door_warn else R.string.shopping_hint,
            ),
            fontFamily = AppFonts.Geist,
            fontWeight = FontWeight.Medium,
            fontSize = 16.sp,
            color = if (warn) AppColors.Alert else AppColors.Bronze,
        )
    }
}

@Composable
private fun ReceiptView(state: FridgeUiState, onComplaint: () -> Unit) {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.height(8.dp))
        // The thank-you is a courtesy; the AMOUNT is the fact. It used to be
        // the larger of the two, which put the emphasis the wrong way round on
        // the one screen where the number is what people check.
        Text(
            localized(state.language, R.string.receipt_title),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.Medium,
            fontSize = 42.sp,
            color = AppColors.InkSoft,
        )
        Spacer(Modifier.height(16.dp))
        CartTiles(state.cart, state.language, Modifier.weight(1f))
        Spacer(Modifier.height(12.dp))
        Text(
            localized(state.language, R.string.amount_isk, state.totalIsk),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontWeight = FontWeight.SemiBold,
            fontSize = 96.sp,
            letterSpacing = (-1.5).sp,
            // Green is the ONLY "settled" signal on this screen — the figure was
            // shown in Ink all the way through shopping, so the colour change is
            // what marks it as final rather than any change of wording.
            color = AppColors.Success,
        )
        Spacer(Modifier.height(20.dp))
        CloseDoorBanner(state.language)
        // Deliberately quiet: most people are fine and should not be invited to
        // complain. But it must not be so quiet that someone who WAS wrongly
        // charged misses it before the screen returns to idle — Siggi reviewed
        // this weight on the mockup and kept it.
        Spacer(Modifier.weight(1f))
        ComplaintEntryButton(state.language, onComplaint)
        Spacer(Modifier.height(6.dp))
    }
}

/**
 * Share of the row given to the narration column.
 *
 * Sized rather than weighted: giving it weight(1f) made it claim every spare
 * pixel, pushing the machine to the far edge and leaving a hole in the middle.
 * A fraction rather than a fixed width so it scales with the panel, and fixed
 * rather than wrap-content because the three narration lines differ in length —
 * a wrapping column would shunt the machine sideways on every crossfade.
 */
private const val TEXT_COLUMN_FRACTION = 0.42f


/**
 * The complaint entry point. Outlined rather than filled, in Muted rather than
 * Bronze: present for the person looking for it, not an invitation.
 */
@Composable
private fun ComplaintEntryButton(language: Language, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, AppColors.Clay, RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 22.dp, vertical = 11.dp),
    ) {
        Text(
            localized(language, R.string.complaint_entry),
            fontSize = 13.sp,
            color = AppColors.MutedSoft,
        )
    }
}
