package isl.snudursopi.vending.proxy

/**
 * Configuration for the temporary Weimi-proxy bridge to the admin backend.
 *
 * This whole module exists as a workaround for Weimi's WAF blocking the
 * backend's Railway IP. Once Weimi allow-lists the backend (or we move to
 * a mobile/residential proxy), set [ENABLED] to false, ship a new kiosk
 * build, and the proxy code becomes dormant. After confirming nothing
 * depends on it in production, the entire `proxy/` package can be deleted.
 *
 * Do not add any kiosk feature that depends on this being available.
 * Customer-facing behavior must work identically whether the proxy is on
 * or off.
 */
object BackendConfig {
    /**
     * Master switch for the proxy. Flip to false to disable the WebSocket
     * connection entirely. No restart required beyond the next app launch.
     */
    const val ENABLED = true

    /**
     * Base URL for the admin backend's WebSocket proxy endpoint.
     * The `/proxy` path is appended automatically.
     */
    const val WS_BASE_URL = "wss://snarl-sopi-production.up.railway.app"

    /** Path on [WS_BASE_URL] that accepts the proxy upgrade. */
    const val WS_PROXY_PATH = "/proxy"

    /**
     * How long to wait for a Weimi response before giving up. Backend's
     * own timeout is 30s (per addendum); we respond a little faster so
     * any error reaches the backend before its timeout fires.
     */
    const val PROXY_REQUEST_TIMEOUT_MS = 25_000L

    /**
     * Ping cadence enforced by the backend (sends ping every 25s).
     * If we go this long without a ping we assume the connection is dead.
     */
    const val PING_DEADLINE_MS = 60_000L

    /** Reconnect backoff in seconds. Last value is the cap. */
    val RECONNECT_BACKOFF_SECONDS = intArrayOf(1, 2, 5, 15, 60)
}
