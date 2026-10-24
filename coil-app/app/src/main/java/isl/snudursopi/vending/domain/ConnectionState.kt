package isl.snudursopi.vending.domain

/**
 * Snapshot of the device's network connection. Updated by ConnectivityObserver
 * whenever Android's active network changes.
 *
 * `bars` is 0..4 (0 = no signal, 4 = excellent). For Wi-Fi this comes from
 * RSSI mapping; for cellular it comes from TelephonyManager's signal level.
 * `None` has bars = 0 by convention.
 *
 * `cellularGeneration` is null for Wi-Fi and "5G"/"4G"/"3G"/"2G" for cellular.
 */
sealed class ConnectionState {
    abstract val bars: Int

    /** No active network (airplane mode, both disconnected, etc.). */
    data object None : ConnectionState() {
        override val bars: Int = 0
    }

    /** Wi-Fi is the active network. */
    data class Wifi(
        override val bars: Int,
    ) : ConnectionState()

    /** Cellular is the active network. */
    data class Cellular(
        override val bars: Int,
        val generation: String,   // "5G", "4G", "3G", "2G"
    ) : ConnectionState()
}
