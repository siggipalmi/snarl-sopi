package isl.snudursopi.vending.ui.screens.admin

import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.vending.BuildConfig
import isl.snudursopi.shared.ClockGuard
import isl.snudursopi.vending.domain.ConnectionState
import isl.snudursopi.vending.proxy.BackendConfig
import isl.snudursopi.vending.proxy.ProxyState
import isl.snudursopi.vending.ui.state.VendingState
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts

/**
 * Diagnostics screen — shown after successful PIN entry. Four sections:
 *  - tæki: read-only device identity
 *  - staða: live status (network, last fetch, products, basket)
 *  - aðgerðir: safe actions (refresh, system settings shortcuts)
 *  - óafturkræfar aðgerðir: destructive actions, behind confirmation dialogs
 *
 * The "stöðustiku stillingar" action temporarily reveals the Android system
 * bars so the technician can use Wi-Fi quicksettings etc.
 */
@Composable
fun DiagnosticsScreen(
    state: VendingState,
    onRefreshCatalog: () -> Unit,
    onResetDeviceCode: () -> Unit,
    onFactoryReset: () -> Unit,
    onShowSystemBars: () -> Unit,
    onForceTestError: () -> Unit,
    onReconnectProxy: () -> Unit,
    onHardwareTest: () -> Unit = {},
    onReadTemperature: () -> Unit = {},
    onSetCoolingTemp: (Double) -> Unit = {},
    onSetCooling: (Boolean) -> Unit = {},
    onDefrost: () -> Unit = {},
    onDumpOrders: () -> Unit = {},
    onCheckUpdate: () -> Unit = {},
    onExit: () -> Unit,
) {
    val context = LocalContext.current
    var confirmReset by remember { mutableStateOf(false) }
    var confirmFactoryReset by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AppColors.Cream),
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 24.dp),
        ) {
            Text(
                text = "stillingar.",
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 40.sp,
                color = AppColors.Ink,
                lineHeight = 42.sp,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = "tækjastjórnun · aðeins fyrir starfsmenn",
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 13.sp,
                color = AppColors.Muted,
            )

            Spacer(Modifier.height(28.dp))

            // --- tæki ---
            SectionLabel("tæki")
            InfoRow(label = "deviceCode", value = state.deviceCode ?: "—")
            InfoRow(label = "deviceName", value = state.machineName.ifBlank { "—" })
            InfoRow(label = "operator", value = state.settings.operatorName.ifBlank { "—" })
            InfoRow(label = "app version", value = appVersionLabel())

            Spacer(Modifier.height(20.dp))

            // --- staða ---
            SectionLabel("staða")
            val (netLabel, netStatus) = formatConnection(state.connectionState)
            InfoRow(label = "net", value = netLabel, status = netStatus)
            val (lastFetchLabel, lastFetchStatus) = formatLastFetch(state.lastFetchMillis)
            InfoRow(label = "gögn síðast sótt:", value = lastFetchLabel, status = lastFetchStatus)
            InfoRow(
                label = "vörur í boði",
                value = "${state.visibleProducts.size} af ${state.catalog.size} sætum",
            )
            InfoRow(
                label = "karfa",
                value = if (state.basket.isEmpty) "tóm" else "${state.basket.itemCount} vörur",
            )

            // --- proxy bridge (temporary) ---
            // Shown only when the proxy is feature-flagged on. When BackendConfig.ENABLED
            // is set to false, this entire section disappears with no other changes.
            if (BackendConfig.ENABLED) {
                Spacer(Modifier.height(20.dp))
                SectionLabel("bakendi (tímabundin brú)")
                val (proxyLabel, proxyColor) = formatProxyStatus(state.proxyState)
                InfoRow(label = "tenging", value = proxyLabel, status = proxyColor)
                InfoRow(
                    label = "beiðnir afgreiddar",
                    value = "${state.proxyState.requestsHandled}" +
                        if (state.proxyState.requestsFailed > 0)
                            " · ${state.proxyState.requestsFailed} mistókust"
                        else "",
                )
                if (state.proxyState.detail != null) {
                    InfoRow(
                        label = "smáatriði",
                        value = state.proxyState.detail!!,
                    )
                }
                ActionRow(
                    label = "endurtengja við bakenda",
                    trailing = "↻",
                    onClick = onReconnectProxy,
                )
            }

            Spacer(Modifier.height(20.dp))

            // --- aðgerðir ---
            SectionLabel("aðgerðir")
            ActionRow(label = "sækja vörur upp á nýtt", trailing = "↻", onClick = onRefreshCatalog)
            ActionRow(label = "skrá pantanir í logcat", trailing = "⤓", onClick = onDumpOrders)
            ActionRow(label = "lesa hitastig (kælir)", trailing = "↻", onClick = onReadTemperature)
            InfoRow(label = "hitastig", value = state.lastTempProbe ?: "—")

            Spacer(Modifier.height(20.dp))

            // Cooling control — VERIFICATION. The compressor on/off, defrost, and
            // temp-scaling params are best-guess until confirmed on a real machine;
            // this becomes a remote dashboard command once proven.
            SectionLabel("kæling · stýring (prófun)")
            ActionRow(label = "stilla hita á 4°C", trailing = "→", onClick = { onSetCoolingTemp(4.0) })
            ActionRow(label = "stilla hita á 12°C", trailing = "→", onClick = { onSetCoolingTemp(12.0) })
            ActionRow(label = "kæling á", trailing = "→", onClick = { onSetCooling(true) })
            ActionRow(label = "kæling af", trailing = "→", onClick = { onSetCooling(false) })
            ActionRow(label = "afísun (defrost)", trailing = "→", onClick = onDefrost)
            InfoRow(label = "síðasta aðgerð", value = state.lastCoolingAction ?: "—")
            ActionRow(
                label = "netstillingar",
                trailing = "→",
                onClick = {
                    // Reveal system bars first so the Android nav bar is available
                    // — otherwise the technician has no back button in the Settings
                    // activity and gets stuck. Bars re-hide when our window regains
                    // focus (MainActivity.onWindowFocusChanged).
                    onShowSystemBars()
                    openSettings(context, Settings.ACTION_WIFI_SETTINGS)
                },
            )
            ActionRow(
                label = "android stillingar",
                trailing = "→",
                onClick = {
                    onShowSystemBars()
                    openSettings(context, Settings.ACTION_SETTINGS)
                },
            )
            ActionRow(
                label = "sýna stöðustiku tímabundið",
                trailing = "→",
                onClick = onShowSystemBars,
            )

            Spacer(Modifier.height(20.dp))

            // Self-update test. "device owner" must read "já" for a silent install;
            // if it reads "nei", provision it once over adb (see the rollout runbook).
            SectionLabel("uppfærsla (prófun)")
            InfoRow(label = "device owner", value = if (state.isDeviceOwner) "já" else "nei")
            val clockWrong = ClockGuard.isWrong()
            InfoRow(
                label = "klukka",
                value = ClockGuard.shownAs() + if (clockWrong) " · röng" else "",
                status = if (clockWrong) DangerInk else OkInk,
            )
            val autoTimeOn = ClockGuard.isAutoTimeOn(context)
            InfoRow(
                label = "sjálfvirkur tími",
                value = if (autoTimeOn) "já" else "nei",
                status = if (autoTimeOn) OkInk else DangerInk,
            )
            ActionRow(label = "leita að uppfærslu", trailing = "↻", onClick = onCheckUpdate)
            InfoRow(label = "staða", value = state.lastUpdateCheck ?: "—")

            Spacer(Modifier.height(20.dp))

            // --- óafturkræfar aðgerðir ---
            SectionLabel("óafturkræfar aðgerðir", color = DangerInk)
            DangerActionRow(
                label = "setja upp nýjan sjálfsala",
                onClick = { confirmReset = true },
            )
            DangerActionRow(
                label = "endurræsa með verksmiðjustillingum",
                onClick = { confirmFactoryReset = true },
            )

            // --- debug-only ---
            // Compiled out of release builds via BuildConfig.DEBUG. Lets us
            // verify error/loading UI without breaking real things.
            if (BuildConfig.DEBUG) {
                Spacer(Modifier.height(20.dp))
                SectionLabel("debug · aðeins í prófunarútgáfu")
                ActionRow(
                    label = "force test error",
                    trailing = "⚡",
                    onClick = onForceTestError,
                )
                ActionRow(
                    label = "vélbúnaðarpróf",
                    trailing = "→",
                    onClick = onHardwareTest,
                )
            }

            Spacer(Modifier.height(24.dp))
        }

        // Fixed bottom exit button
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 16.dp),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(28.dp))
                    .background(AppColors.Ink)
                    .clickable(onClick = onExit)
                    .padding(vertical = 16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "loka · til baka í kiosk",
                    color = AppColors.Cream,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }

    if (confirmReset) {
        ConfirmDialog(
            title = "Setja upp nýjan sjálfsala?",
            body = "Tækjakóði verður hreinsaður og þú þarft að slá inn nýjan kóða " +
                "fyrir aðra vél. Karfa og staðbundnar stillingar haldast.",
            confirmLabel = "Halda áfram",
            onConfirm = {
                confirmReset = false
                onResetDeviceCode()
            },
            onDismiss = { confirmReset = false },
        )
    }
    if (confirmFactoryReset) {
        ConfirmDialog(
            title = "Verksmiðjustillingar?",
            body = "Allt verður endurræst — tækjakóði, karfa, tungumálastilling og " +
                "vistuð gögn. Þetta er það sama og að setja upp appið alveg upp á nýtt. " +
                "Þessi aðgerð er óafturkræf.",
            confirmLabel = "Endurræsa",
            danger = true,
            onConfirm = {
                confirmFactoryReset = false
                onFactoryReset()
            },
            onDismiss = { confirmFactoryReset = false },
        )
    }
}

// ----- bits -----

private val DangerInk = Color(0xFF8A2C0A)
private val DangerBg = Color(0xFFFDE8E0)
private val OkInk = Color(0xFF2D6E3A)
private val WarnInk = Color(0xFFC4501A)

@Composable
private fun SectionLabel(text: String, color: Color = AppColors.Muted) {
    Text(
        text = text.uppercase(),
        fontSize = 11.sp,
        color = color,
        letterSpacing = 1.5.sp,
        fontWeight = FontWeight.Medium,
        modifier = Modifier.padding(bottom = 8.dp),
    )
}

@Composable
private fun InfoRow(
    label: String,
    value: String,
    status: Color? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 6.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(AppColors.White)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(text = label, color = AppColors.Muted, fontSize = 13.sp)
        Text(
            text = value,
            color = status ?: AppColors.Ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            fontFamily = FontFamily.Monospace,
        )
    }
}

@Composable
private fun ActionRow(label: String, trailing: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 6.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(AppColors.White)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(text = label, color = AppColors.Ink, fontSize = 15.sp)
        Text(text = trailing, color = AppColors.Muted, fontSize = 18.sp)
    }
}

@Composable
private fun DangerActionRow(label: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 6.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(DangerBg)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(text = label, color = DangerInk, fontSize = 15.sp, fontWeight = FontWeight.Medium)
        Text(text = "→", color = DangerInk, fontSize = 18.sp)
    }
}

@Composable
private fun ConfirmDialog(
    title: String,
    body: String,
    confirmLabel: String,
    danger: Boolean = false,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    text = confirmLabel,
                    color = if (danger) DangerInk else AppColors.Ink,
                    fontWeight = FontWeight.Medium,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(text = "Hætta við", color = AppColors.Muted)
            }
        },
        containerColor = AppColors.Cream,
    )
}

private fun openSettings(context: Context, action: String) {
    val intent = Intent(action).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    try {
        context.startActivity(intent)
    } catch (e: Exception) {
        // Some emulator images don't have the corresponding settings activity.
        // Silently no-op — on real hardware these always resolve.
    }
}

private fun formatConnection(state: ConnectionState): Pair<String, Color?> {
    return when (state) {
        is ConnectionState.Wifi -> "wifi · ${state.bars}/4" to OkInk
        is ConnectionState.Cellular -> "${state.generation.lowercase()} · ${state.bars}/4" to OkInk
        ConnectionState.None -> "ekkert net" to WarnInk
    }
}

private fun formatLastFetch(epochMs: Long): Pair<String, Color?> {
    if (epochMs <= 0L) return "—" to AppColors.Muted
    val now = System.currentTimeMillis()
    val ageMs = now - epochMs
    val ageMinutes = ageMs / 60_000
    val label = when {
        ageMinutes < 1 -> "núna"
        ageMinutes < 60 -> "$ageMinutes mín síðan"
        ageMinutes < 1440 -> "${ageMinutes / 60} klst síðan"
        else -> "${ageMinutes / 1440} dagar síðan"
    }
    val color: Color = if (ageMinutes < 30) OkInk else WarnInk
    return label to color
}

private fun appVersionLabel(): String {
    val v = BuildConfig.VERSION_NAME
    val suffix = if (BuildConfig.DEBUG) " (debug)" else ""
    return "$v$suffix"
}

private fun formatProxyStatus(state: ProxyState): Pair<String, Color?> {
    return when (state.status) {
        ProxyState.Status.Disabled -> "óvirkt" to AppColors.Muted
        ProxyState.Status.Idle -> "ekki tengt" to AppColors.Muted
        ProxyState.Status.Connecting -> "tengist…" to WarnInk
        ProxyState.Status.Connected -> "tengt" to OkInk
        ProxyState.Status.Reconnecting -> "endurtengist (${state.reconnectAttempts})" to WarnInk
        ProxyState.Status.Failed -> "tókst ekki" to Color(0xFFC4501A)
    }
}
