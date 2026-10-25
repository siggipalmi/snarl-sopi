package isl.snudursopi.vending.ui.screens.setup

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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import isl.snudursopi.vending.ui.components.ClockWarning
import isl.snudursopi.vending.ui.components.StatusBar
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts
import isl.snudursopi.vending.ui.theme.AppTypography
import kotlinx.coroutines.launch

/**
 * First-run setup. Sub-operator enters an 8-digit machine code. Before
 * committing, we run a quick check:
 *   1) is the device online?  (uses [connectionState])
 *   2) does the code resolve to a real machine via the data service?
 * If both pass we show a confirmation card with the machine's friendly name,
 * and require an explicit "yes, continue" tap before saving the code — this
 * catches digit typos before they become long debugging sessions.
 *
 * Generic vendor wording ("vefþjónusta") on purpose — sub-operators
 * shouldn't see the underlying vendor name.
 */
@Composable
fun SetupScreen(
    connectionState: ConnectionState,
    currentTime: String,
    onSetupCompleted: (code: String, machineKey: String) -> Unit,
    onClockLongPress: () -> Unit = {},
    onTestCode: suspend (String) -> CodeCheckResult,
    onTestKey: suspend (code: String, key: String) -> KeyCheckResult,
    onPair: suspend (code: String) -> PairResult,
) {
    var input by remember { mutableStateOf("") }
    var keyInput by remember { mutableStateOf("") }
    var pairInput by remember { mutableStateOf("") }
    // Pairing is the way in. The vélarnúmer-plus-key flow below it still works
    // and is reachable from the link, because a backend that cannot issue a
    // code should not leave a machine unsetuppable.
    var phase: SetupPhase by remember { mutableStateOf(SetupPhase.PairIdle) }
    val scope = rememberCoroutineScope()
    val isValid = input.length == 8 && input.all { it.isDigit() }
    val isPairValid = pairInput.length == 6 && pairInput.all { it.isDigit() }

    // A machine key looks like mk_live_<hex>. We check the shape only — the
    // real test is the first backend call, and a typo there hard-fails the
    // proxy, so it is worth refusing the obviously-wrong ones here.
    var keyError by remember { mutableStateOf<String?>(null) }
    var keyChecking by remember { mutableStateOf(false) }
    val trimmedKey = keyInput.trim()
    val isKeyValid = trimmedKey.startsWith("mk_") && trimmedKey.length >= 20

    fun runPair() {
        if (!isPairValid) return
        if (connectionState is ConnectionState.None) {
            phase = SetupPhase.PairFailed(
                title = "Engin internettenging",
                description = "tækið nær ekki sambandi við netið. athugaðu wifi stillingar í android stillingum.",
            )
            return
        }
        phase = SetupPhase.PairChecking
        scope.launch {
            phase = when (val r = onPair(pairInput)) {
                is PairResult.Ok ->
                    SetupPhase.PairDone(deviceName = r.deviceName, code = r.deviceCode, machineKey = r.machineKey)
                PairResult.Rejected ->
                    SetupPhase.PairFailed(
                        title = "Kóðinn gengur ekki",
                        description = "kóðinn er útrunninn, þegar notaður eða rangt sleginn. " +
                            "búðu til nýjan í stjórnborðinu. kóði gildir í tvo tíma.",
                    )
                PairResult.NoNetwork ->
                    SetupPhase.PairFailed(
                        title = "Engin internettenging",
                        description = "tækið nær ekki sambandi við netið. athugaðu wifi stillingar í android stillingum.",
                    )
                PairResult.ServerError ->
                    SetupPhase.PairFailed(
                        title = "Tæknileg villa",
                        description = "tókst ekki að ná sambandi við vefþjónustu. reyndu aftur eftir smástund.",
                    )
                PairResult.ClockWrong ->
                    SetupPhase.PairFailed(
                        title = "Klukkan í vélinni er röng",
                        description = "örugg tenging næst ekki fyrr en klukkan er rétt. kóðinn er enn í gildi — " +
                            "lagaðu klukkuna og reyndu aftur.",
                    )
            }
        }
    }

    fun runCheck() {
        if (!isValid) return
        if (connectionState is ConnectionState.None) {
            phase = SetupPhase.ErrorNoNet
            return
        }
        phase = SetupPhase.Checking
        scope.launch {
            phase = when (val result = onTestCode(input)) {
                is CodeCheckResult.Found ->
                    SetupPhase.Confirming(deviceName = result.deviceName, code = input)
                CodeCheckResult.NotFound ->
                    SetupPhase.ErrorNotFound(code = input)
                CodeCheckResult.NoNetwork ->
                    SetupPhase.ErrorNoNet
                CodeCheckResult.ServerError ->
                    SetupPhase.ErrorServerError
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AppColors.Cream)
            .imePadding(),
    ) {
        StatusBar(
            brand = "snarl & sopi",
            time = currentTime,
            connectionState = connectionState,
            onClockLongPress = onClockLongPress,
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp, vertical = 24.dp),
        ) {
            Text(
                text = "vélin er óstillt.",
                style = AppTypography.DisplayLarge.copy(fontSize = 44.sp),
                color = AppColors.Ink,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = when (phase) {
                    SetupPhase.PairIdle, SetupPhase.PairChecking,
                    is SetupPhase.PairDone, is SetupPhase.PairFailed ->
                        "sláðu inn pörunarkóða úr stjórnborðinu."
                    else -> "sláðu inn vélarnúmer til að byrja."
                },
                fontSize = 14.sp,
                color = AppColors.MutedSoft,
            )
            // Ahead of everything else here: with the clock wrong, every path below
            // fails as a "network" error, which sends people the wrong way.
            ClockWarning(Modifier.padding(top = 18.dp))
            Spacer(Modifier.height(36.dp))

            // Phase-dependent content
            when (val p = phase) {
                SetupPhase.PairIdle, SetupPhase.PairChecking ->
                    PairInputBlock(
                        input = pairInput,
                        onInputChange = { pairInput = it },
                        locked = p == SetupPhase.PairChecking,
                        onSubmit = { runPair() },
                        onManual = { phase = SetupPhase.Idle },
                    )

                is SetupPhase.PairDone ->
                    ConfirmCard(deviceName = p.deviceName, code = p.code, label = "vél tengd")

                is SetupPhase.PairFailed -> {
                    ErrorCard(icon = "!", title = p.title, description = p.description)
                    Spacer(Modifier.height(14.dp))
                    PairInputBlock(
                        input = pairInput,
                        onInputChange = { pairInput = it },
                        locked = false,
                        onSubmit = { runPair() },
                        onManual = { phase = SetupPhase.Idle },
                    )
                }

                SetupPhase.Idle, SetupPhase.Checking ->
                    InputBlock(
                        input = input,
                        onInputChange = { input = it },
                        locked = p == SetupPhase.Checking,
                        showInfoText = p == SetupPhase.Checking,
                        onSubmit = { runCheck() },
                    )

                is SetupPhase.Confirming ->
                    ConfirmCard(
                        deviceName = p.deviceName,
                        code = p.code,
                    )

                is SetupPhase.EnteringKey ->
                    KeyInputBlock(
                        deviceName = p.deviceName,
                        input = keyInput,
                        onInputChange = { keyInput = it; keyError = null },
                        error = keyError,
                    )

                is SetupPhase.ErrorNotFound -> {
                    ErrorCard(
                        icon = "?",
                        title = "Vél fannst ekki",
                        description = "engin vél er skráð með númerinu ${p.code}. athugaðu hvort þú slóst inn rétt númer.",
                    )
                    Spacer(Modifier.height(14.dp))
                    InputBlock(
                        input = input,
                        onInputChange = { input = it },
                        locked = false,
                        showInfoText = false,
                        onSubmit = { runCheck() },
                    )
                }
                SetupPhase.ErrorNoNet -> {
                    ErrorCard(
                        icon = "!",
                        title = "Engin internettenging",
                        description = "tækið nær ekki sambandi við netið. athugaðu wifi stillingar í android stillingum.",
                    )
                    Spacer(Modifier.height(14.dp))
                    InputBlock(
                        input = input,
                        onInputChange = { input = it },
                        locked = false,
                        showInfoText = false,
                        onSubmit = { runCheck() },
                    )
                }
                SetupPhase.ErrorServerError -> {
                    ErrorCard(
                        icon = "!",
                        title = "Tæknileg villa",
                        description = "tókst ekki að ná sambandi við vefþjónustu. reyndu aftur eftir smástund.",
                    )
                    Spacer(Modifier.height(14.dp))
                    InputBlock(
                        input = input,
                        onInputChange = { input = it },
                        locked = false,
                        showInfoText = false,
                        onSubmit = { runCheck() },
                    )
                }
            }

            Spacer(Modifier.weight(1f))

            // Bottom action area — varies by phase
            when (val p = phase) {
                SetupPhase.PairIdle -> {
                    PrimaryButton(
                        label = "áfram →",
                        enabled = isPairValid,
                        onClick = ::runPair,
                    )
                }
                SetupPhase.PairChecking -> {
                    LoadingButton(label = "parar vél…")
                }
                is SetupPhase.PairDone -> {
                    // No "back" here on purpose. Pairing has already happened and
                    // the key is already stored; there is nothing to cancel. Wrong
                    // machine? Pair again with the right code and it rotates again.
                    PrimaryButton(
                        label = "áfram →",
                        enabled = true,
                        onClick = { onSetupCompleted(p.code, p.machineKey) },
                    )
                }
                is SetupPhase.PairFailed -> {
                    PrimaryButton(
                        label = "reyna aftur",
                        enabled = isPairValid,
                        onClick = ::runPair,
                    )
                }
                SetupPhase.Idle -> {
                    PrimaryButton(
                        label = "áfram →",
                        enabled = isValid,
                        onClick = ::runCheck,
                    )
                }
                SetupPhase.Checking -> {
                    LoadingButton(label = "athugar…")
                }
                is SetupPhase.Confirming -> {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        SecondaryButton(
                            label = "til baka",
                            onClick = { phase = SetupPhase.Idle },
                            modifier = Modifier.weight(1f),
                        )
                        PrimaryButton(
                            label = "já, áfram →",
                            enabled = true,
                            onClick = {
                                phase = SetupPhase.EnteringKey(
                                    deviceName = p.deviceName,
                                    code = p.code,
                                )
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                is SetupPhase.EnteringKey -> {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        SecondaryButton(
                            label = "til baka",
                            onClick = {
                                phase = SetupPhase.Confirming(
                                    deviceName = p.deviceName,
                                    code = p.code,
                                )
                            },
                            modifier = Modifier.weight(1f),
                        )
                        PrimaryButton(
                            label = if (keyChecking) "athuga…" else "ljúka uppsetningu →",
                            enabled = isKeyValid && !keyChecking,
                            onClick = {
                                keyError = null
                                keyChecking = true
                                scope.launch {
                                    when (onTestKey(p.code, trimmedKey)) {
                                        KeyCheckResult.Ok,
                                        KeyCheckResult.Unverified ->
                                            onSetupCompleted(p.code, trimmedKey)
                                        KeyCheckResult.Invalid -> {
                                            keyChecking = false
                                            keyError = "lykillinn passar ekki við þessa vél. " +
                                                "athugaðu að hann sé af réttri vélarsíðu."
                                        }
                                    }
                                }
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                is SetupPhase.ErrorNotFound,
                SetupPhase.ErrorNoNet,
                SetupPhase.ErrorServerError -> {
                    PrimaryButton(
                        label = "reyna aftur",
                        enabled = isValid,
                        onClick = ::runCheck,
                    )
                }
            }
        }
    }
}

// ---------- subcomponents ----------

/**
 * Machine-key entry. Deliberately a plain text field rather than the digit
 * keypad used for the machine number: the key is long, mixed-case and hyphen-
 * free, and on a kiosk screen it will usually be pasted rather than typed.
 *
 * We do not mask it. Masking a value the operator is copying character by
 * character off a dashboard, on a machine standing in a shop, trades a real
 * usability cost for very little — and a mistyped key hard-fails the backend
 * connection in a way that is tedious to diagnose from a phone.
 */
@Composable
private fun KeyInputBlock(
    deviceName: String,
    input: String,
    onInputChange: (String) -> Unit,
    error: String? = null,
) {
    Text(
        text = deviceName,
        style = AppTypography.LabelSmall,
        color = AppColors.MutedSoft,
    )
    Spacer(Modifier.height(10.dp))
    Text(
        text = "vélarlykill",
        style = AppTypography.LabelSmall,
        color = AppColors.MutedSoft,
    )
    Spacer(Modifier.height(10.dp))

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(color = AppColors.White, shape = RoundedCornerShape(12.dp))
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(12.dp))
            .padding(horizontal = 20.dp, vertical = 18.dp),
    ) {
        BasicTextField(
            value = input,
            onValueChange = { new -> onInputChange(new.filter { !it.isWhitespace() }) },
            textStyle = TextStyle(
                fontSize = 16.sp,
                color = AppColors.Ink,
                fontWeight = FontWeight.Medium,
                fontFamily = AppFonts.Geist,
            ),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Text,
                imeAction = ImeAction.Done,
            ),
            enabled = true,
            modifier = Modifier.fillMaxWidth(),
        )
        if (input.isEmpty()) {
            Text(
                text = "mk_live_…",
                fontSize = 16.sp,
                color = AppColors.MutedSoft,
                fontFamily = AppFonts.Geist,
            )
        }
    }
    Spacer(Modifier.height(10.dp))
    Text(
        text = error ?: "lykilinn er að finna á vélarsíðunni í stjórnborðinu (sýna lykil).",
        fontSize = 13.sp,
        color = if (error != null) Color(0xFFC4501A) else AppColors.MutedSoft,
    )
}

/**
 * Pairing-code entry: six digits, generated in the dashboard against one
 * machine, single-use, valid for two hours.
 *
 * A number keypad, and it accepts nothing but digits — which is the point.
 * The machine-key field further down is a plain text field because a key is 56
 * mixed characters; when someone tried to put one into a digits-only field on
 * 62160479 every letter was silently dropped and the machine spent three days
 * presenting nonsense. Six digits need no such compromise.
 */
@Composable
private fun PairInputBlock(
    input: String,
    onInputChange: (String) -> Unit,
    locked: Boolean,
    onSubmit: () -> Unit = {},
    onManual: () -> Unit = {},
) {
    Text(
        text = "pörunarkóði",
        style = AppTypography.LabelSmall,
        color = AppColors.MutedSoft,
    )
    Spacer(Modifier.height(10.dp))

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                color = if (locked) AppColors.Cream else AppColors.White,
                shape = RoundedCornerShape(12.dp),
            )
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(12.dp))
            .padding(horizontal = 20.dp, vertical = 18.dp),
    ) {
        BasicTextField(
            value = input,
            onValueChange = { new ->
                if (!locked && new.length <= 6 && new.all { it.isDigit() }) {
                    onInputChange(new)
                }
            },
            textStyle = TextStyle(
                fontSize = 28.sp,
                color = if (locked) AppColors.MutedSoft else AppColors.Ink,
                letterSpacing = 8.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = AppFonts.Geist,
            ),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Number,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { onSubmit() }),
            enabled = !locked,
            modifier = Modifier.fillMaxWidth(),
        )
    }
    if (locked) {
        Spacer(Modifier.height(6.dp))
        Text(
            text = "parar vél…",
            fontSize = 12.sp,
            color = AppColors.MutedSoft,
            fontFamily = AppFonts.Geist,
        )
    }

    Spacer(Modifier.height(18.dp))
    Text(
        text = "slá inn vélarnúmer og lykil handvirkt →",
        fontSize = 12.sp,
        color = AppColors.MutedSoft,
        fontFamily = AppFonts.Geist,
        modifier = Modifier.clickable(enabled = !locked, onClick = onManual),
    )
}

@Composable
private fun InputBlock(
    input: String,
    onInputChange: (String) -> Unit,
    locked: Boolean,
    showInfoText: Boolean,
    onSubmit: () -> Unit = {},
) {
    Text(
        text = "vélarnúmer",
        style = AppTypography.LabelSmall,
        color = AppColors.MutedSoft,
    )
    Spacer(Modifier.height(10.dp))

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                color = if (locked) AppColors.Cream else AppColors.White,
                shape = RoundedCornerShape(12.dp),
            )
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(12.dp))
            .padding(horizontal = 20.dp, vertical = 18.dp),
    ) {
        BasicTextField(
            value = input,
            onValueChange = { new ->
                if (!locked && new.length <= 8 && new.all { it.isDigit() }) {
                    onInputChange(new)
                }
            },
            textStyle = TextStyle(
                fontSize = 24.sp,
                color = if (locked) AppColors.MutedSoft else AppColors.Ink,
                letterSpacing = 3.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = AppFonts.Geist,
            ),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Number,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { onSubmit() }),
            enabled = !locked,
            modifier = Modifier.fillMaxWidth(),
        )
    }
    if (showInfoText) {
        Spacer(Modifier.height(6.dp))
        Text(
            text = "athugar tengingu og vélarnúmer…",
            fontSize = 12.sp,
            color = AppColors.MutedSoft,
            fontFamily = AppFonts.Geist,
        )
    }
}

@Composable
private fun ConfirmCard(deviceName: String, code: String, label: String = "vél fannst") {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(AppColors.White, RoundedCornerShape(12.dp))
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(12.dp))
            .padding(20.dp),
    ) {
        Column {
            // Green checkmark
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .background(Color(0xFF2D6E3A), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "✓",
                    color = AppColors.Cream,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                )
            }
            Spacer(Modifier.height(14.dp))
            Text(
                text = label,
                style = AppTypography.LabelSmall,
                color = AppColors.MutedSoft,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = deviceName.ifBlank { "—" },
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 32.sp,
                fontWeight = FontWeight.Medium,
                color = AppColors.Ink,
                lineHeight = 32.sp,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = code,
                fontSize = 13.sp,
                color = AppColors.MutedSoft,
                fontFamily = AppFonts.Geist,
            )
            Spacer(Modifier.height(18.dp))
            Text(
                text = "áfram með þessa vél?",
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 18.sp,
                color = AppColors.Ink,
            )
        }
    }
}

@Composable
private fun ErrorCard(icon: String, title: String, description: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFFFDE8E0), RoundedCornerShape(12.dp))
            .padding(horizontal = 18.dp, vertical = 16.dp),
    ) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(20.dp)
                        .background(Color(0xFFC4501A), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = icon,
                        color = AppColors.Cream,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
                Spacer(Modifier.size(8.dp))
                Text(
                    text = title,
                    color = Color(0xFF8A2C0A),
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    fontFamily = AppFonts.Geist,
                )
            }
            Spacer(Modifier.height(10.dp))
            Text(
                text = description,
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 14.sp,
                color = Color(0xFF8A2C0A),
                lineHeight = 19.sp,
            )
        }
    }
}

@Composable
private fun PrimaryButton(
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(56.dp)
            .background(
                color = if (enabled) AppColors.Ink else AppColors.Clay,
                shape = RoundedCornerShape(12.dp),
            )
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = AppColors.Cream,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            fontFamily = AppFonts.Geist,
        )
    }
}

@Composable
private fun SecondaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(56.dp)
            .background(AppColors.Cream, RoundedCornerShape(12.dp))
            .border(0.5.dp, AppColors.Ink, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = AppColors.Ink,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            fontFamily = AppFonts.Geist,
        )
    }
}

@Composable
private fun LoadingButton(label: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .background(AppColors.Ink.copy(alpha = 0.75f), RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            CircularProgressIndicator(
                color = AppColors.Cream,
                strokeWidth = 1.5.dp,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = label,
                color = AppColors.Cream,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = AppFonts.Geist,
            )
        }
    }
}

// ---------- state machine ----------

/** UI states for the setup flow. */
sealed class SetupPhase {
    /** Pairing-code entry. The default way in since v0.79.0. */
    data object PairIdle : SetupPhase()
    data object PairChecking : SetupPhase()
    /** Paired AND stored. Shows which machine this became; cannot be undone. */
    data class PairDone(val deviceName: String, val code: String, val machineKey: String) : SetupPhase()
    data class PairFailed(val title: String, val description: String) : SetupPhase()

    data object Idle : SetupPhase()
    data object Checking : SetupPhase()
    data class Confirming(val deviceName: String, val code: String) : SetupPhase()
    /** Code confirmed; operator now types the machine key from the dashboard. */
    data class EnteringKey(val deviceName: String, val code: String) : SetupPhase()
    data class ErrorNotFound(val code: String) : SetupPhase()
    data object ErrorNoNet : SetupPhase()
    data object ErrorServerError : SetupPhase()
}

/** Result of a setup-time code check via the data service. */
/** Outcome of verifying a typed machine key against the backend. */
sealed class KeyCheckResult {
    /** The backend accepted it. */
    data object Ok : KeyCheckResult()
    /** The backend rejected it — wrong key, or a key for another machine. */
    data object Invalid : KeyCheckResult()
    /** Could not reach the backend. Stored anyway; see testMachineKey. */
    data object Unverified : KeyCheckResult()
}

/**
 * Outcome of exchanging a pairing code. [Ok] means the identity is ALREADY
 * STORED — see VendingViewModel.pairWithCode for why there is no uncommitted
 * state to confirm.
 */
sealed class PairResult {
    data class Ok(val deviceCode: String, val deviceName: String, val machineKey: String) : PairResult()
    /** Unknown, expired, already used, mistyped, or too many attempts. */
    data object Rejected : PairResult()
    data object NoNetwork : PairResult()
    data object ServerError : PairResult()
    /**
     * Failed, and the clock reads before [isl.snudursopi.vending.ClockGuard.FLOOR_MILLIS].
     * TLS fails before the request leaves the machine, so the code was never spent.
     */
    data object ClockWrong : PairResult()
}

sealed class CodeCheckResult {
    data class Found(val deviceName: String) : CodeCheckResult()
    data object NotFound : CodeCheckResult()
    data object NoNetwork : CodeCheckResult()
    data object ServerError : CodeCheckResult()
}
