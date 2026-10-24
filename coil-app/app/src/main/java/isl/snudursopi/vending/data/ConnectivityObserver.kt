package isl.snudursopi.vending.data

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import isl.snudursopi.vending.domain.ConnectionState
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/**
 * Observes Android's active network and emits ConnectionState updates whenever
 * connectivity changes (Wi-Fi connects/disconnects, cellular signal changes,
 * the user switches preferred network in Android settings, etc.).
 *
 * Uses ConnectivityManager.registerDefaultNetworkCallback so that whichever
 * network Android considers "active" is what we report — this respects the
 * user's network preferences set in Android Settings.
 *
 * Wi-Fi RSSI → bars mapping uses WifiManager.calculateSignalLevel (system API).
 * Cellular signal strength comes from TelephonyManager's SignalStrength.level
 * (0..4), available since API 29.
 *
 * READ_PHONE_STATE permission is requested at runtime; if not granted, we still
 * report Cellular with generation = "?" and bars = 0 rather than crashing.
 */
class ConnectivityObserver(
    private val context: Context,
) {
    private val connectivityManager: ConnectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val wifiManager: WifiManager =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    private val telephonyManager: TelephonyManager =
        context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager

    fun observe(): Flow<ConnectionState> = callbackFlow {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                trySend(currentState(network))
            }

            override fun onCapabilitiesChanged(
                network: Network,
                capabilities: NetworkCapabilities,
            ) {
                trySend(stateFromCapabilities(capabilities))
            }

            override fun onLost(network: Network) {
                trySend(ConnectionState.None)
            }
        }

        // Emit an initial state immediately so the UI doesn't start with stale data.
        trySend(snapshot())

        connectivityManager.registerDefaultNetworkCallback(callback)
        awaitClose { connectivityManager.unregisterNetworkCallback(callback) }
    }

    /** One-shot read of current connection state. */
    fun snapshot(): ConnectionState {
        val activeNetwork = connectivityManager.activeNetwork ?: return ConnectionState.None
        val caps = connectivityManager.getNetworkCapabilities(activeNetwork)
            ?: return ConnectionState.None
        return stateFromCapabilities(caps)
    }

    private fun currentState(network: Network): ConnectionState {
        val caps = connectivityManager.getNetworkCapabilities(network)
            ?: return ConnectionState.None
        return stateFromCapabilities(caps)
    }

    private fun stateFromCapabilities(caps: NetworkCapabilities): ConnectionState {
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> ConnectionState.Wifi(
                bars = wifiBars(),
            )
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> ConnectionState.Cellular(
                bars = cellularBars(),
                generation = cellularGeneration(),
            )
            else -> ConnectionState.None
        }
    }

    @SuppressLint("MissingPermission")
    private fun wifiBars(): Int {
        val rssi = wifiManager.connectionInfo?.rssi ?: return 0
        // calculateSignalLevel(rssi, 5) returns 0..4
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            wifiManager.calculateSignalLevel(rssi).coerceIn(0, 4)
        } else {
            @Suppress("DEPRECATION")
            WifiManager.calculateSignalLevel(rssi, 5).coerceIn(0, 4)
        }
    }

    @SuppressLint("MissingPermission")
    private fun cellularBars(): Int {
        if (!hasPhonePermission()) return 0
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                telephonyManager.signalStrength?.level?.coerceIn(0, 4) ?: 0
            } else {
                // Older API: rough fallback
                0
            }
        } catch (e: SecurityException) {
            0
        }
    }

    @SuppressLint("MissingPermission")
    private fun cellularGeneration(): String {
        if (!hasPhonePermission()) return "?"
        return try {
            val networkType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                telephonyManager.dataNetworkType
            } else {
                @Suppress("DEPRECATION")
                telephonyManager.networkType
            }
            when (networkType) {
                TelephonyManager.NETWORK_TYPE_NR -> "5G"
                TelephonyManager.NETWORK_TYPE_LTE -> "4G"
                TelephonyManager.NETWORK_TYPE_HSPAP,
                TelephonyManager.NETWORK_TYPE_HSDPA,
                TelephonyManager.NETWORK_TYPE_HSPA,
                TelephonyManager.NETWORK_TYPE_HSUPA,
                TelephonyManager.NETWORK_TYPE_UMTS,
                TelephonyManager.NETWORK_TYPE_EVDO_0,
                TelephonyManager.NETWORK_TYPE_EVDO_A,
                TelephonyManager.NETWORK_TYPE_EVDO_B -> "3G"
                TelephonyManager.NETWORK_TYPE_GPRS,
                TelephonyManager.NETWORK_TYPE_EDGE,
                TelephonyManager.NETWORK_TYPE_CDMA -> "2G"
                else -> "?"
            }
        } catch (e: SecurityException) {
            "?"
        }
    }

    private fun hasPhonePermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.READ_PHONE_STATE,
        ) == PackageManager.PERMISSION_GRANTED
    }
}
