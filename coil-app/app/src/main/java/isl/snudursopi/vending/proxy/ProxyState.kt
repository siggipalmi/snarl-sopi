package isl.snudursopi.vending.proxy

/**
 * Live state of the backend proxy WebSocket connection.
 *
 * Visible only in the diagnostics screen; customer-facing UI never reflects
 * proxy state. The proxy is invisible to customers by design.
 */
data class ProxyState(
    val status: Status = Status.Disabled,
    /** Epoch millis of the last successfully-received ping from the backend. */
    val lastPingAtMillis: Long = 0L,
    /** Number of proxy requests handled (successfully or otherwise) since app start. */
    val requestsHandled: Int = 0,
    /** Number of proxy requests that returned an error. */
    val requestsFailed: Int = 0,
    /** Reconnect attempts since last successful connection (resets to 0 on connect). */
    val reconnectAttempts: Int = 0,
    /** Human-readable reason for the current state (debug detail). */
    val detail: String? = null,
) {
    enum class Status {
        /** Proxy is feature-flagged off. */
        Disabled,
        /** Disconnected, not currently trying to connect (e.g. before init). */
        Idle,
        /** Mid-handshake. */
        Connecting,
        /** WebSocket open, accepting messages. */
        Connected,
        /** Disconnected, waiting before next reconnect attempt. */
        Reconnecting,
        /** Failed in a way that won't auto-recover (e.g. 401 on auth — key was revoked). */
        Failed,
    }
}
