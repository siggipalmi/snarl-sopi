package isl.snudursopi.vending.ui.screens.admin

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Backspace
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.sp
import isl.snudursopi.shared.AdminPin
import isl.snudursopi.shared.AdminPinGuard
import isl.snudursopi.shared.AdminPinHash
import isl.snudursopi.shared.AdminPinPrefs
import isl.snudursopi.vending.R
import isl.snudursopi.vending.domain.Language
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts
import isl.snudursopi.vending.ui.util.localized
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val PIN_LENGTH = 6

/**
 * Admin PIN entry. 6-digit code, numeric keypad, dot indicators.
 *
 * *** THE PIN IS THIS MACHINE'S OWN (0.80.6, as the fridge since 0.69.0). AG sets it in the
 * dashboard; the config carries only a hash ([pinHash]), checked here offline by the shared
 * AdminPin. No hash means the fleet's shared 123456, so a machine keeps working through the
 * rollout. Five wrong PINs lock the pad for five minutes, kept across restarts, and the backend
 * is told ([onPinEvent] "lockout") so AG gets an alert.
 */
@Composable
fun PinEntryScreen(
    onSuccess: () -> Unit,
    onCancel: () -> Unit,
    pinHash: AdminPinHash? = null,
    language: Language = Language.Icelandic,
    onPinEvent: (String) -> Unit = {},
) {
    val context = LocalContext.current
    val guard = remember { AdminPinGuard(AdminPinPrefs(context)) }
    var entered by remember { mutableStateOf("") }
    var wrong by remember { mutableStateOf(false) }
    var checking by remember { mutableStateOf(false) }
    var lockedMs by remember { mutableStateOf(guard.lockedForMs()) }
    val shake = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    // Count a lock down on screen, then reopen the pad by itself.
    LaunchedEffect(lockedMs > 0) {
        while (lockedMs > 0) { delay(1_000); lockedMs = guard.lockedForMs() }
    }

    fun verifyAndAdvance() {
        val pin = entered
        checking = true
        scope.launch {
            // PBKDF2 takes a moment on the board: off the main thread.
            val ok = withContext(Dispatchers.Default) { AdminPin.check(pinHash, pin) }
            checking = false
            if (ok) {
                guard.succeeded()
                onPinEvent("ok")
                onSuccess()
                return@launch
            }
            wrong = true
            if (guard.failed()) {
                lockedMs = guard.lockedForMs()
                onPinEvent("lockout")
            }
            shake.snapTo(0f)
            shake.animateTo(14f, animationSpec = tween(50))
            shake.animateTo(-14f, animationSpec = tween(50))
            shake.animateTo(10f, animationSpec = tween(50))
            shake.animateTo(-10f, animationSpec = tween(50))
            shake.animateTo(0f, animationSpec = tween(50))
            entered = ""
        }
    }

    LaunchedEffect(entered) {
        if (entered.length == PIN_LENGTH && !checking) {
            delay(120)   // brief pause so the last dot is visibly filled before shake/advance
            verifyAndAdvance()
        }
    }

    val title = when {
        lockedMs > 0 -> localized(language, R.string.admin_pin_locked, ((lockedMs + 59_999) / 60_000).toInt())
        wrong -> localized(language, R.string.admin_pin_wrong, guard.triesLeft())
        else -> localized(language, R.string.admin_pin_title)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AppColors.Ink)
            .padding(horizontal = 32.dp, vertical = 40.dp),
    ) {
        Text(
            text = title,
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontSize = 36.sp,
            color = if (wrong || lockedMs > 0) AppColors.Alert else AppColors.Cream,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = localized(language, R.string.admin_pin_subtitle),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontSize = 14.sp,
            color = AppColors.Cream.copy(alpha = 0.55f),
        )

        Spacer(Modifier.height(48.dp))

        // Dot indicators row — animated shake when wrong code is entered
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .graphicsLayer { translationX = shake.value },
            horizontalArrangement = Arrangement.Center,
        ) {
            repeat(PIN_LENGTH) { i ->
                PinDot(filled = i < entered.length)
            }
        }

        Spacer(Modifier.height(32.dp))
        Spacer(Modifier.weight(1f))

        Keypad(
            onDigit = { digit ->
                // A locked pad takes no digits; it reopens by itself when the lock runs out.
                if (lockedMs > 0 || checking) return@Keypad
                wrong = false
                if (entered.length < PIN_LENGTH) {
                    entered += digit
                }
            },
            onDelete = {
                if (entered.isNotEmpty()) {
                    entered = entered.dropLast(1)
                }
            },
            onCancel = onCancel,
        )
    }
}

@Composable
private fun PinDot(filled: Boolean) {
    if (filled) {
        Box(
            modifier = Modifier
                .padding(horizontal = 10.dp)
                .size(16.dp)
                .clip(CircleShape)
                .background(AppColors.Cream),
        )
    } else {
        Box(
            modifier = Modifier
                .padding(horizontal = 10.dp)
                .size(16.dp)
                .clip(CircleShape)
                .border(1.dp, AppColors.Cream.copy(alpha = 0.4f), CircleShape),
        )
    }
}

@Composable
private fun Keypad(
    onDigit: (String) -> Unit,
    onDelete: () -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        KeyRow {
            DigitKey("1", onDigit)
            DigitKey("2", onDigit)
            DigitKey("3", onDigit)
        }
        KeyRow {
            DigitKey("4", onDigit)
            DigitKey("5", onDigit)
            DigitKey("6", onDigit)
        }
        KeyRow {
            DigitKey("7", onDigit)
            DigitKey("8", onDigit)
            DigitKey("9", onDigit)
        }
        KeyRow {
            CancelKey(onCancel)
            DigitKey("0", onDigit)
            DeleteKey(onDelete)
        }
    }
}

@Composable
private fun KeyRow(content: @Composable RowScope.() -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        content = content,
    )
}

@Composable
private fun RowScope.DigitKey(digit: String, onDigit: (String) -> Unit) {
    KeyBase(onClick = { onDigit(digit) }) {
        Text(
            text = digit,
            color = AppColors.Cream,
            fontSize = 30.sp,
            fontWeight = FontWeight.Light,
        )
    }
}

@Composable
private fun RowScope.CancelKey(onClick: () -> Unit) {
    KeyBase(onClick = onClick) {
        Text(
            text = "hætta við",
            color = AppColors.Cream.copy(alpha = 0.55f),
            fontFamily = AppFonts.Cormorant,
            fontStyle = FontStyle.Italic,
            fontSize = 15.sp,
        )
    }
}

@Composable
private fun RowScope.DeleteKey(onClick: () -> Unit) {
    KeyBase(onClick = onClick) {
        Icon(
            imageVector = Icons.Outlined.Backspace,
            contentDescription = "Eyða",
            tint = AppColors.Cream.copy(alpha = 0.7f),
            modifier = Modifier.size(22.dp),
        )
    }
}

@Composable
private fun RowScope.KeyBase(onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .weight(1f)
            .aspectRatio(1.5f)
            .clip(RoundedCornerShape(14.dp))
            .background(AppColors.Cream.copy(alpha = 0.08f))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}
