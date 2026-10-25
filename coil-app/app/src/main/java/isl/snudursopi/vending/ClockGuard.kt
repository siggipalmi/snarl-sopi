package isl.snudursopi.vending

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The machine's clock, and keeping it right.
 *
 * A wrong clock fails every TLS connection while the screen looks healthy. On
 * 62160479 (Grótta, 2026-10-24) the board came back from a power cut reading
 * 19 May 2023 with automatic time off, and for two days it sold nothing: the
 * Weimi catalog fetch failed, and the operator view showed a stack trace about
 * an "insecure hash function" in a Certum certificate — Conscrypt reporting the
 * last of several chain paths it tried, not the cause. Nobody on site could have
 * read that as "the clock is wrong". It took a remote session and a photo of the
 * pull-down shade to find out.
 *
 * Two jobs, so it can't happen silently again:
 *  - [isWrong] lets the screens say so in plain words ([ClockWarning]).
 *  - [enforceAutoTime] switches automatic time back on at every start, by
 *    whichever means this install has.
 */
object ClockGuard {
    private const val TAG = "ClockGuard"

    /**
     * 2026-10-25T00:00:00Z, the day this check was written. No correct clock reads
     * earlier, whatever its time zone, and the observed failure lands years below
     * it. A fixed date rather than the build time keeps builds reproducible; it
     * only ever errs towards missing a clock that is wrong by a little.
     */
    const val FLOOR_MILLIS = 1_792_886_400_000L

    fun isWrong(now: Long = System.currentTimeMillis()): Boolean = now < FLOOR_MILLIS

    /** The clock as the person at the machine sees it, e.g. "19.05.2023 02:09". */
    fun shownAs(now: Long = System.currentTimeMillis()): String =
        SimpleDateFormat("dd.MM.yyyy HH:mm", Locale.ROOT).format(Date(now))

    fun isAutoTimeOn(context: Context): Boolean =
        try {
            Settings.Global.getInt(context.contentResolver, Settings.Global.AUTO_TIME, 0) == 1
        } catch (e: Exception) {
            false
        }

    /**
     * Turn automatic time on. Called from MainActivity.onCreate, so every start —
     * including the one after a power cut — puts it back.
     *
     *  1. Device Owner: setAutoTimeEnabled (API 30, which the WM55 is), or
     *     setAutoTimeRequired below that. The latter also stops it being switched
     *     off from Settings.
     *  2. Not Device Owner, but WRITE_SECURE_SETTINGS granted once over adb:
     *       pm grant <package> android.permission.WRITE_SECURE_SETTINGS
     *     The grant survives app updates. Write the setting directly.
     *  3. Neither: nothing an app can do. Diagnostics shows the state, and
     *     [ClockWarning] says how to fix it by hand.
     */
    fun enforceAutoTime(context: Context): String {
        val result = when {
            KioskManager.isDeviceOwner(context) -> try {
                val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
                val admin = ComponentName(context, KioskAdminReceiver::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    dpm.setAutoTimeEnabled(admin, true)
                } else {
                    @Suppress("DEPRECATION")
                    dpm.setAutoTimeRequired(admin, true)
                }
                "enforced as device owner"
            } catch (e: Exception) {
                "device owner call failed: ${e.message}"
            }
            context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) ==
                PackageManager.PERMISSION_GRANTED -> try {
                Settings.Global.putInt(context.contentResolver, Settings.Global.AUTO_TIME, 1)
                "switched on via WRITE_SECURE_SETTINGS"
            } catch (e: Exception) {
                "settings write failed: ${e.message}"
            }
            else -> "cannot enforce: not device owner, WRITE_SECURE_SETTINGS not granted"
        }
        Log.i(TAG, "automatic time: $result · auto_time=${isAutoTimeOn(context)} · " +
            "clock ${shownAs()}${if (isWrong()) " (WRONG)" else ""}")
        return result
    }
}
