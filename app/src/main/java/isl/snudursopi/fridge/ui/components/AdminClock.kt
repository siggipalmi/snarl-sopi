package isl.snudursopi.fridge.ui.components

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.util.Log
import isl.snudursopi.fridge.BuildConfig
import isl.snudursopi.fridge.DevBarPrefs
import isl.snudursopi.fridge.KioskManager
import isl.snudursopi.fridge.hardware.nayax.MarshallPaymentController
import isl.snudursopi.fridge.hardware.nayax.NayaxLink
import isl.snudursopi.fridge.scheduleAppRelaunch
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.compose.runtime.rememberCoroutineScope
import isl.snudursopi.fridge.R
import isl.snudursopi.fridge.domain.AdminPin
import isl.snudursopi.fridge.domain.AdminPinGuard
import isl.snudursopi.fridge.domain.AdminPinHash
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.ui.util.localized
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import android.net.Uri

/**
 * The clock — and the way in.
 *
 * *** LONG-PRESS OPENS ADMIN. Same gesture as the coil kiosk, deliberately, so
 * one habit works on every machine in the fleet. A plain tap does nothing, which
 * is what makes it safe in front of customers: a curious tap looks like an
 * unresponsive clock rather than an invitation.
 *
 * This is a PERMANENT feature, not debug-only. Once Device Owner and Lock Task
 * are set there is no other way off the app, and a technician standing at one of
 * 46 machines will not have a laptop. Being locked out of a working machine has
 * already cost more time than any feature here.
 */
@Composable
fun AdminClock(
    onLongPress: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var now by remember { mutableStateOf(clockText()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = clockText()
            delay(10_000)
        }
    }
    Text(
        text = now,
        fontFamily = FontFamily.Monospace,
        fontSize = 15.sp,
        letterSpacing = 0.5.sp,
        color = AppColors.MutedSoft,
        modifier = modifier
            .padding(10.dp)
            .pointerInput(Unit) {
                detectTapGestures(onLongPress = { onLongPress() })
            },
    )
}

private fun clockText(): String =
    SimpleDateFormat("HH:mm", Locale.US).format(Date())

/** Where the PIN lockout lives, so a power cycle doesn't reset the count. */
private class AdminPinPrefs(context: Context) : AdminPinGuard.Store {
    private val prefs = context.getSharedPreferences("admin_pin", Context.MODE_PRIVATE)
    override var failures: Int
        get() = prefs.getInt("failures", 0)
        set(v) { prefs.edit().putInt("failures", v).apply() }
    override var lockedUntilMs: Long
        get() = prefs.getLong("locked_until", 0L)
        set(v) { prefs.edit().putLong("locked_until", v).apply() }
}

/**
 * PIN gate, then the actions.
 *
 * *** THE PIN IS THIS MACHINE'S OWN (0.69.0). AG sets it in the dashboard; the config carries only
 * a hash ([pinHash]), checked here offline. No hash means the fleet's shared 123456, so a machine
 * keeps working through the rollout. Five wrong PINs lock the pad for five minutes, kept across
 * restarts, and the backend is told (onPinEvent "lockout") so AG gets an alert.
 */
@Composable
fun AdminSheet(
    onClose: () -> Unit,
    deviceCode: String? = null,
    lastPollOkMs: Long? = null,
    pinHash: AdminPinHash? = null,
    language: Language = Language.Icelandic,
    onPinEvent: (String) -> Unit = {},
) {
    val context = LocalContext.current
    val guard = remember { AdminPinGuard(AdminPinPrefs(context)) }
    val scope = rememberCoroutineScope()
    var entered by remember { mutableStateOf("") }
    var unlocked by remember { mutableStateOf(false) }
    var wrong by remember { mutableStateOf(false) }
    var checking by remember { mutableStateOf(false) }
    var lockedMs by remember { mutableStateOf(guard.lockedForMs()) }
    var pairing by remember { mutableStateOf(false) }
    // Count a lock down on screen, then reopen the pad by itself.
    LaunchedEffect(lockedMs > 0) {
        while (lockedMs > 0) { delay(1_000); lockedMs = guard.lockedForMs() }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(AppColors.Ink.copy(alpha = 0.72f))
            .clickable(onClick = onClose),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier
                .width(560.dp)
                .clip(RoundedCornerShape(20.dp))
                .background(AppColors.Cream)
                .clickable(enabled = false) {}
                // The pairing keypad is taller than the action list; on a short
                // panel the buttons under it must stay reachable.
                .verticalScroll(rememberScrollState())
                .padding(40.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (!unlocked) {
                val title = when {
                    lockedMs > 0 -> localized(language, R.string.admin_pin_locked, ((lockedMs + 59_999) / 60_000).toInt())
                    wrong -> localized(language, R.string.admin_pin_wrong, guard.triesLeft())
                    else -> localized(language, R.string.admin_pin_title)
                }
                PinPad(
                    title = title,
                    entered = entered,
                    wrong = wrong || lockedMs > 0,
                    onDigit = {
                        if (lockedMs > 0 || checking) return@PinPad
                        wrong = false
                        if (entered.length < 6) entered += it
                        if (entered.length == 6) {
                            val pin = entered
                            checking = true
                            // PBKDF2 takes a moment on a tablet: off the main thread.
                            scope.launch {
                                val ok = withContext(Dispatchers.Default) { AdminPin.check(pinHash, pin) }
                                checking = false
                                entered = ""
                                if (ok) {
                                    guard.succeeded(); unlocked = true; onPinEvent("ok")
                                } else {
                                    wrong = true
                                    if (guard.failed()) { lockedMs = guard.lockedForMs(); onPinEvent("lockout") }
                                }
                            }
                        }
                    },
                    onBack = { if (entered.isNotEmpty()) entered = entered.dropLast(1) },
                )
            } else if (pairing) {
                PairingPane(deviceCode) { pairing = false }
            } else {
                Actions(onClose, deviceCode, lastPollOkMs) { pairing = true }
            }
            Spacer(Modifier.height(24.dp))
            SheetButton("loka", AppColors.Ink, onClose)
        }
    }
}

@Composable
private fun PinPad(
    title: String,
    entered: String,
    wrong: Boolean,
    onDigit: (String) -> Unit,
    onBack: () -> Unit,
) {
    Text(
        title,
        fontFamily = AppFonts.Cormorant,
        fontStyle = FontStyle.Italic,
        fontWeight = FontWeight.SemiBold,
        fontSize = 34.sp,
        color = if (wrong) AppColors.Alert else AppColors.Ink,
    )
    Spacer(Modifier.height(18.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        repeat(6) { i ->
            Box(
                Modifier
                    .size(16.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(if (i < entered.length) AppColors.Ink else AppColors.Clay),
            )
        }
    }
    Spacer(Modifier.height(24.dp))
    listOf("123", "456", "789").forEach { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            row.forEach { c -> Key(c.toString()) { onDigit(c.toString()) } }
        }
        Spacer(Modifier.height(12.dp))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(96.dp, 68.dp))
        Key("0") { onDigit("0") }
        Key("<") { onBack() }
    }
}

@Composable
internal fun Key(label: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(96.dp, 68.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(AppColors.White)
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontFamily = AppFonts.Geist, fontSize = 26.sp, color = AppColors.Ink)
    }
}

@Composable
private fun Actions(
    onClose: () -> Unit,
    deviceCode: String?,
    lastPollOkMs: Long?,
    onPair: () -> Unit,
) {
    val context = LocalContext.current
    Text(
        "vélarstillingar",
        fontFamily = AppFonts.Cormorant,
        fontStyle = FontStyle.Italic,
        fontWeight = FontWeight.SemiBold,
        fontSize = 34.sp,
        color = AppColors.Ink,
    )
    Spacer(Modifier.height(6.dp))
    Text(
        "${isl.snudursopi.fridge.AppVersion.name} (${isl.snudursopi.fridge.AppVersion.code})",
        fontFamily = FontFamily.Monospace,
        fontSize = 14.sp,
        color = AppColors.MutedSoft,
    )
    Spacer(Modifier.height(14.dp))
    Diagnostics(deviceCode, lastPollOkMs)
    Spacer(Modifier.height(20.dp))

    // First on an unprovisioned machine, because it is the only thing that
    // machine needs; below the everyday tools once it has an identity.
    if (deviceCode == null) {
        SheetButton("para vél með kóða", AppColors.Bronze, onPair)
        Spacer(Modifier.height(10.dp))
    }

    // *** ORDER MATTERS: Lock Task must be released BEFORE launching Settings,
    // or the launch is silently blocked and the button looks broken.
    SheetButton("opna stillingar", AppColors.Bronze) {
        leaveForSettings(context, Settings.ACTION_SETTINGS, onClose)
    }
    Spacer(Modifier.height(10.dp))
    SheetButton("opna wi-fi stillingar", AppColors.Bronze) {
        leaveForSettings(context, Settings.ACTION_WIFI_SETTINGS, onClose)
    }
    Spacer(Modifier.height(10.dp))
    // Leaves kiosk mode without opening anything — for when the machine needs to
    // be handed over, or another app run briefly.
    // The dev bar is a service tool, not customer-facing. Off by default; an
    // admin standing at the machine with the PIN can turn it on and off again.
    val devOn = DevBarPrefs.isVisible(context)
    SheetButton(
        if (devOn) "fela prófunarstiku" else "sýna prófunarstiku",
        AppColors.InkSoft,
    ) {
        DevBarPrefs.setVisible(context, !devOn)
        // The bar is read when the activity resumes, so bounce the sheet shut
        // and let the change land on the next composition.
        onClose()
    }
    Spacer(Modifier.height(10.dp))
    /*
     * *** SUPPORT TOOLS. The point of these is that an OPERATOR can reach them.
     *
     * When a machine goes quiet the fastest route has been a remote screen —
     * TeamViewer survived a reboot on 8626020619 when adb over Tailscale did
     * not, because it needs no port and no pairing. But it only helps if the
     * person standing at the machine can start it, and today that means talking
     * them through Settings on a kiosk with no navigation bar.
     *
     * These two buttons make it: open TeamViewer if installed, or open the Play
     * Store / a browser to get it. Both release Lock Task first for the same
     * reason the Settings buttons do, and arm the relaunch so nobody is
     * stranded in a browser.
     */
    /*
     * *** THE TWO SCREENS A REMOTE DEVICE OWNER SETUP NEEDS.
     *
     * The zero-laptop flow is: operator installs the app and enters the pairing
     * code on screen, then Siggi sets Device Owner from his desk over Tailscale.
     * For that the operator has to reach two Settings pages on a kiosk with no
     * navigation bar — Developer options for wireless debugging, and the
     * Tailscale app to enter the auth key. Talking someone through Settings
     * menus on the phone is exactly the step these buttons remove.
     */
    SheetButton("þráðlaus kembing", AppColors.Bronze) {
        leaveForSettings(
            context,
            Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS,
            onClose,
        )
    }
    Spacer(Modifier.height(10.dp))
    SheetButton("opna tailscale", AppColors.Bronze) {
        openOrDownload(context, TAILSCALE_PKG, TAILSCALE_URL, onClose)
    }
    Spacer(Modifier.height(10.dp))
    SheetButton("opna teamviewer", AppColors.Bronze) {
        openSupportTool(context, onClose)
    }
    Spacer(Modifier.height(10.dp))
    SheetButton("sækja teamviewer", AppColors.Bronze) {
        leaveForUrl(context, TEAMVIEWER_URL, onClose)
    }
    Spacer(Modifier.height(10.dp))
    if (deviceCode != null) {
        SheetButton("para vél með kóða", AppColors.InkSoft, onPair)
        Spacer(Modifier.height(10.dp))
    }
    SheetButton("slökkva á kioskham", AppColors.InkSoft) {
        (context as? Activity)?.let { KioskManager.disableLockTask(it) }
        onClose()
    }
}

/**
 * *** THE THREE THINGS YOU NEED WHEN A MACHINE GOES QUIET.
 *
 * Which machine it thinks it is, when it last reached the backend, and what the
 * clock says. All three are invisible today, which is why a machine that had
 * come up with a years-wrong clock — failing every TLS handshake and reaching
 * nobody — looked completely healthy on screen for an afternoon.
 *
 * Deliberately readable by whoever is standing at the machine, not just by
 * someone with adb: hostel staff, a refiller, or Siggi over a remote screen.
 * A time since last poll that keeps climbing is the whole diagnosis.
 */
@Composable
private fun Diagnostics(deviceCode: String?, lastPollOkMs: Long?) {
    val now = System.currentTimeMillis()
    val age = lastPollOkMs?.let { now - it }
    val pollText = when {
        age == null -> "aldrei"
        age < 90_000 -> "rétt í þessu"
        age < 3_600_000 -> "fyrir ${age / 60_000} mín"
        else -> "fyrir ${age / 3_600_000} klst"
    }
    // Anything over five minutes means the 60s poll has failed repeatedly.
    val stale = age == null || age > 5 * 60_000

    Column {
        DiagLine("vél", deviceCode ?: "ÓSKRÁÐ", deviceCode == null)
        DiagLine("síðasta svar", pollText, stale)
        // Payment port, and whether the link is up on it. "leitar" (searching)
        // for more than a few minutes means neither candidate port answers.
        val payState = NayaxLink.controller.state
        val payUp = payState == MarshallPaymentController.State.READY ||
            payState == MarshallPaymentController.State.AWAITING_CARD ||
            payState == MarshallPaymentController.State.VENDING
        DiagLine(
            "posi",
            NayaxLink.describe() +
                if (payUp) " · tengdur" else " · ótengdur",
            !payUp,
        )
        DiagLine(
            "klukka",
            SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date(now)),
            false,
        )
    }
}

@Composable
private fun DiagLine(label: String, value: String, warn: Boolean) {
    Row(Modifier.padding(vertical = 2.dp)) {
        Text(
            label,
            fontFamily = AppFonts.Geist,
            fontSize = 13.sp,
            color = AppColors.Muted,
            modifier = Modifier.width(120.dp),
        )
        Text(
            value,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            color = if (warn) AppColors.Alert else AppColors.InkSoft,
        )
    }
}

@Composable
internal fun SheetButton(label: String, color: androidx.compose.ui.graphics.Color, onClick: () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(62.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(color)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontFamily = AppFonts.Geist,
            fontWeight = FontWeight.Medium,
            fontSize = 19.sp,
            textAlign = TextAlign.Center,
            color = AppColors.Cream,
        )
    }
}

/**
 * *** THERE IS NO WAY BACK FROM SETTINGS ON THIS HARDWARE.
 *
 * These kiosk boards ship with the navigation bar removed in the system build,
 * so there is no Home button anywhere on the panel — which is why Settings was
 * unreachable before the admin clock existed, and why, once you are IN Settings,
 * nothing gets you out again. Before v0.37.0 the only route back was a power
 * cycle.
 *
 * So leaving for Settings also arms an alarm that brings the app back by itself.
 * It reuses the watchdog's proven mechanism deliberately: an activity
 * PendingIntent through AlarmManager, because a plain startActivity() from the
 * background is silently blocked on API 29+.
 *
 * The operator does their work and the app returns on its own; nobody is
 * stranded, and no nav bar is needed. MainActivity.onResume re-asserts Lock Task,
 * so the machine locks itself back down on arrival.
 *
 * NOTE the exit-kiosk button deliberately does NOT arm this — that one exists for
 * handing the machine over or running something else on it, and yanking the app
 * back mid-task would defeat the purpose.
 */
private const val SETTINGS_RETURN_MS = 4L * 60L * 1000L

/** Distinct from the watchdog (9), crash recovery (7) and post-install (11). */
private const val RELAUNCH_REQUEST_CODE = 13

private fun leaveForSettings(context: Context, action: String, onClose: () -> Unit) {
    (context as? Activity)?.let { KioskManager.disableLockTask(it) }
    scheduleAppRelaunch(context, SETTINGS_RETURN_MS, RELAUNCH_REQUEST_CODE)
    Log.i(
        "AdminClock",
        "left for settings ($action) — app relaunches in ${SETTINGS_RETURN_MS / 60_000} min",
    )
    openSettings(context, action)
    onClose()
}

private const val TAILSCALE_PKG = "com.tailscale.ipn"
private const val TAILSCALE_URL =
    "https://play.google.com/store/apps/details?id=com.tailscale.ipn"

/** Launch a package if installed, else open its store page. Never silently nothing. */
private fun openOrDownload(context: Context, pkg: String, url: String, onClose: () -> Unit) {
    val launch = context.packageManager.getLaunchIntentForPackage(pkg)
    if (launch == null) {
        leaveForUrl(context, url, onClose)
        return
    }
    (context as? Activity)?.let { KioskManager.disableLockTask(it) }
    scheduleAppRelaunch(context, SETTINGS_RETURN_MS, RELAUNCH_REQUEST_CODE)
    Log.i("AdminClock", "launching $pkg — app relaunches in 4 min")
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(launch) }
    onClose()
}

private const val TEAMVIEWER_PKG = "com.teamviewer.quicksupport.market"
private const val TEAMVIEWER_URL =
    "https://play.google.com/store/apps/details?id=com.teamviewer.quicksupport.market"

/**
 * Launch TeamViewer QuickSupport if it is installed; otherwise fall through to
 * the download page rather than doing nothing. A button that silently fails is
 * worse than no button, especially when the person pressing it is on the phone
 * to you.
 */
private fun openSupportTool(context: Context, onClose: () -> Unit) {
    val launch = context.packageManager.getLaunchIntentForPackage(TEAMVIEWER_PKG)
    if (launch == null) {
        leaveForUrl(context, TEAMVIEWER_URL, onClose)
        return
    }
    (context as? Activity)?.let { KioskManager.disableLockTask(it) }
    scheduleAppRelaunch(context, SETTINGS_RETURN_MS, RELAUNCH_REQUEST_CODE)
    Log.i("AdminClock", "launching TeamViewer — app relaunches in 4 min")
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(launch) }
    onClose()
}

/** Same escape-and-return shape as [leaveForSettings], for a web page. */
private fun leaveForUrl(context: Context, url: String, onClose: () -> Unit) {
    (context as? Activity)?.let { KioskManager.disableLockTask(it) }
    scheduleAppRelaunch(context, SETTINGS_RETURN_MS, RELAUNCH_REQUEST_CODE)
    Log.i("AdminClock", "opening $url — app relaunches in 4 min")
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
    runCatching { context.startActivity(intent) }
    onClose()
}

private fun openSettings(context: Context, action: String) {
    val intent = Intent(action).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
    runCatching { context.startActivity(intent) }
}
