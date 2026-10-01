package isl.snudursopi.fridge.ui.components

import android.app.Activity
import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import isl.snudursopi.fridge.data.FridgeIdentityStore
import isl.snudursopi.fridge.data.backend.PairResult
import isl.snudursopi.fridge.data.backend.PairingClient
import isl.snudursopi.fridge.scheduleAppRelaunch
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * *** PROVISIONING WITHOUT A LAPTOP.
 *
 * An admin issues a six-digit code on the machine's dashboard page; whoever is
 * standing at the machine opens this behind the admin PIN and types it. The app
 * exchanges it for the device code and machine key ([PairingClient]), stores
 * them, and restarts.
 *
 * The restart is not optional: the backend clients, the config cache scope and
 * the command poller are all bound to the identity at startup — the same reason
 * adb provisioning needs a force-stop first. Restarting here is the restart_app
 * path, which is proven on Device Owner machines.
 *
 * Nothing about the key is ever shown or logged. The code is dead after one use.
 */
@Composable
internal fun PairingPane(currentDeviceCode: String?, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var messageIsError by remember { mutableStateOf(false) }

    Text(
        "pörun",
        fontFamily = AppFonts.Cormorant,
        fontStyle = FontStyle.Italic,
        fontWeight = FontWeight.SemiBold,
        fontSize = 34.sp,
        color = AppColors.Ink,
    )
    Spacer(Modifier.height(6.dp))
    Text(
        "Sláðu inn sex stafa kóðann af síðu vélarinnar í stjórnborðinu.",
        fontFamily = AppFonts.Geist,
        fontSize = 15.sp,
        textAlign = TextAlign.Center,
        color = AppColors.InkSoft,
    )
    if (currentDeviceCode != null) {
        // Pairing rotates the key. On a working machine that is a deliberate
        // re-identification, never a casual tap — say so before it happens.
        Spacer(Modifier.height(8.dp))
        Text(
            "Vélin er nú skráð sem $currentDeviceCode. Pörun skiptir um auðkenni og lykil.",
            fontFamily = AppFonts.Geist,
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
            color = AppColors.Alert,
        )
    }
    Spacer(Modifier.height(18.dp))

    // Digits shown, not dots: the operator is copying them off a screen and has
    // to be able to check what they typed.
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        repeat(6) { i ->
            Box(
                Modifier
                    .size(52.dp, 64.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(AppColors.White)
                    .border(0.5.dp, AppColors.Line, RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    code.getOrNull(i)?.toString() ?: "",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 30.sp,
                    color = AppColors.Ink,
                )
            }
        }
    }
    Spacer(Modifier.height(18.dp))

    val onDigit: (String) -> Unit = { d ->
        if (!busy && code.length < 6) {
            code += d
            message = null
        }
    }
    listOf("123", "456", "789").forEach { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            row.forEach { c -> Key(c.toString()) { onDigit(c.toString()) } }
        }
        Spacer(Modifier.height(12.dp))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(96.dp, 68.dp))
        Key("0") { onDigit("0") }
        Key("<") { if (!busy && code.isNotEmpty()) code = code.dropLast(1) }
    }

    message?.let {
        Spacer(Modifier.height(14.dp))
        Text(
            it,
            fontFamily = AppFonts.Geist,
            fontSize = 14.sp,
            textAlign = TextAlign.Center,
            color = if (messageIsError) AppColors.Alert else AppColors.InkSoft,
        )
    }
    Spacer(Modifier.height(18.dp))

    SheetButton(
        if (busy) "sæki auðkenni…" else "para vél",
        if (code.length == 6 && !busy) AppColors.Bronze else AppColors.MutedSoft,
    ) {
        if (busy || code.length != 6) return@SheetButton
        busy = true
        messageIsError = false
        message = "sæki auðkenni…"
        // *** NOT THE SHEET'S SCOPE. Tapping outside closes the sheet, which
        // would cancel a request already in flight — after the backend has
        // spent the code and rotated the key, but before the app stored it.
        // On a machine that was already paired that leaves it locked out. The
        // activity's scope outlives the sheet.
        val runIn = (context as? LifecycleOwner)?.lifecycleScope ?: scope
        runIn.launch {
            when (val r = PairingClient().pair(code)) {
                is PairResult.Paired -> {
                    val stored = runCatching {
                        withContext(NonCancellable) {
                            FridgeIdentityStore(context.applicationContext).set(r.deviceCode, r.machineKey)
                        }
                    }
                    if (stored.isFailure) {
                        Log.e("AdminClock", "pairing: could not store identity", stored.exceptionOrNull())
                        busy = false
                        messageIsError = true
                        message = "Auðkenni barst en vistaðist ekki. Búðu til nýjan kóða og reyndu aftur."
                        return@launch
                    }
                    // Same line and tag as intent provisioning, so the relayed
                    // log and the provisioning checklist read the same either way.
                    Log.i("FridgeBackend", "provisioned deviceCode=${r.deviceCode} (pairing)")
                    message = "pöruð sem ${r.deviceCode} — endurræsi…"
                    delay(1_500)
                    Log.w("AdminClock", "pairing done — relaunching in 2s")
                    scheduleAppRelaunch(context.applicationContext, 2_000L, PAIRING_RELAUNCH_REQUEST_CODE)
                    (context as? Activity)?.finishAndRemoveTask()
                    kotlin.system.exitProcess(0)
                }
                PairResult.InvalidCode -> {
                    Log.w("AdminClock", "pairing refused: invalid code")
                    busy = false
                    code = ""
                    messageIsError = true
                    message = "Kóðinn gildir ekki. Hann gæti verið útrunninn, notaður eða rangt " +
                        "sleginn. Búðu til nýjan í stjórnborðinu."
                }
                PairResult.RateLimited -> {
                    Log.w("AdminClock", "pairing refused: rate limited")
                    busy = false
                    messageIsError = true
                    message = "Of margar tilraunir. Bíddu í mínútu og reyndu aftur."
                }
                is PairResult.Failed -> {
                    Log.w("AdminClock", "pairing failed: ${r.reason}")
                    busy = false
                    messageIsError = true
                    message = "Næ ekki sambandi við bakenda. Athugaðu netið og að klukkan sé rétt.\n${r.reason}"
                }
            }
        }
    }
    Spacer(Modifier.height(10.dp))
    SheetButton("til baka", AppColors.InkSoft) { if (!busy) onBack() }
}

/** Distinct from watchdog (9), crash recovery (7), post-install (11), admin (13), restart_app (4711). */
private const val PAIRING_RELAUNCH_REQUEST_CODE = 17
