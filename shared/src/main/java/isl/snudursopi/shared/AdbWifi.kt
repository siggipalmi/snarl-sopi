package isl.snudursopi.shared

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Wireless debugging from the dashboard (Siggi, 2026-10-27: "I can not open shell access without
 * the human hand"). `adb_wifi { action: status | on | off }`, AG only. From the fridge app
 * (0.70.0); one copy for both apps (coil 0.80.8).
 *
 * Wireless debugging is the global setting `adb_wifi_enabled` (Android 11+). Writing it needs
 * WRITE_SECURE_SETTINGS, which Device Owner does NOT give; it is granted once over adb:
 *     adb shell pm grant <package> android.permission.WRITE_SECURE_SETTINGS
 * (coil-app/tools/adb-onepass.sh does it for the coil package; ClockGuard uses the same grant.)
 * Its port is random on every start, so the answer reads it (service.adb.tls.port) and names the
 * machine's addresses: nobody has to look at the screen. Only computers already paired with the
 * machine can connect; the transport is TLS.
 */
object AdbWifi {
    private const val SETTING = "adb_wifi_enabled"

    fun grantCmd(ctx: Context) = "adb shell pm grant ${ctx.packageName} android.permission.WRITE_SECURE_SETTINGS"

    /** Returns (ok, detail) for the command result. */
    suspend fun run(ctx: Context, action: String): Pair<Boolean, String> = when (action) {
        "status", "" -> true to status(ctx)
        "on" -> set(ctx, true)
        "off" -> set(ctx, false)
        else -> false to "action must be status, on or off"
    }

    private fun granted(ctx: Context) =
        ctx.checkSelfPermission(android.Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED

    private fun enabled(ctx: Context) =
        runCatching { Settings.Global.getInt(ctx.contentResolver, SETTING, 0) == 1 }.getOrDefault(false)

    private fun port(): Int? = runCatching {
        val p = Runtime.getRuntime().exec(arrayOf("getprop", "service.adb.tls.port"))
        p.inputStream.bufferedReader().readText().trim().toIntOrNull()?.takeIf { it > 0 }
    }.getOrNull()

    /** IPv4 addresses by interface, e.g. "tun0 100.81.204.80, wlan0 192.168.1.20" (tun0 = Tailscale). */
    private fun addresses(): String = runCatching {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { nif -> nif.inetAddresses.toList().filterIsInstance<Inet4Address>().map { "${nif.name} ${it.hostAddress}" } }
            .joinToString(", ")
    }.getOrDefault("").ifEmpty { "no address" }

    /** The address to connect to: Tailscale's 100.64.0.0/10 if present, else the first one. */
    private fun connectHost(): String? = runCatching {
        val all = NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList().filterIsInstance<Inet4Address>() }.map { it.hostAddress }
        all.firstOrNull { it.startsWith("100.") } ?: all.firstOrNull()
    }.getOrNull()

    private fun status(ctx: Context): String {
        val p = port()
        val on = enabled(ctx)
        return "Android ${Build.VERSION.RELEASE} (sdk ${Build.VERSION.SDK_INT}) · " +
            "permission ${if (granted(ctx)) "granted" else "NOT granted"} · wireless debugging ${if (on) "ON" else "off"}" +
            (if (on && p != null) " · port $p" else "") + " · " + addresses() +
            (if (on && p != null && connectHost() != null) " · connect: adb connect ${connectHost()}:$p" else "")
    }

    private suspend fun set(ctx: Context, on: Boolean): Pair<Boolean, String> {
        if (Build.VERSION.SDK_INT < 30) return false to "wireless debugging needs Android 11; this is ${Build.VERSION.RELEASE}"
        if (!granted(ctx)) return false to "needs a one-time grant over adb first: ${grantCmd(ctx)}"
        runCatching { Settings.Global.putInt(ctx.contentResolver, SETTING, if (on) 1 else 0) }
            .onFailure { return false to "could not change it: ${it.message}" }
        if (!on) return true to "wireless debugging off"
        // adbd takes a moment to pick a port.
        repeat(20) {
            port()?.let { p ->
                val host = connectHost()
                return true to "wireless debugging ON · port $p" + (host?.let { " · connect: adb connect $it:$p" } ?: "") + " · ${addresses()}"
            }
            kotlinx.coroutines.delay(500)
        }
        return true to "wireless debugging ON, but the port could not be read (${addresses()}) — run status in a minute"
    }
}
