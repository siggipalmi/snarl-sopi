package isl.snudursopi.fridge.data.backend

/**
 * Configuration for the AG Vending admin backend, fridge side.
 *
 * Mirrors the coil app's AdminBackendConfig — same backend, same host, same
 * machine-key auth. Kept separate so fridge tuning (queue sizes, poll cadence)
 * can diverge from the coil kiosk without touching it.
 */
object FridgeBackendConfig {

    /**
     * Base URL of the admin backend.
     *
     * *** NEVER POINT A MACHINE AT THE RAW `*.up.railway.app` HOST AGAIN.
     *
     * On 2026-07-29 machine 8626020618 sealed itself: the Railway certificate
     * renewed onto Let's Encrypt's Generation Y hierarchy and the tablet's trust
     * store rejected the chain it was served, which killed the config poll, the
     * command poll AND the OTA path in one stroke — with Lock Task active there
     * was then no way in at all, and it took a factory reset to recover.
     *
     * `api.agvending.is` is Cloudflare-fronted with a Google Trust Services
     * certificate (WE1 -> GTS Root R4), a shorter chain than the cross-signed
     * Let's Encrypt path, and it is the origin we authenticate against for
     * everything else. From v0.37.0 we also bundle our own trust anchors (see
     * res/xml/network_security_config.xml), so a root changing under us no
     * longer depends on this device's frozen store either.
     */
    const val BASE_URL = "https://api.agvending.is"

    /**
     * Settlement retry queue cap. Generous: a settlement is revenue plus a
     * stock decrement, and the customer already has the goods, so we would
     * much rather hold a long backlog than drop one. Replay is safe — the
     * backend is idempotent on orderId.
     */
    const val SETTLEMENT_QUEUE_MAX_SIZE = 500

    /**
     * Complaints queue far smaller than settlements, deliberately. A settlement
     * is money already taken and MUST survive; a complaint is a customer telling
     * us something, and 100 undelivered ones means something is very wrong
     * anyway. Cap agreed with Siggi.
     */
    const val COMPLAINT_QUEUE_MAX_SIZE = 100

    /**
     * How long to keep retrying a queued settlement. 7 days: losing one means
     * losing money we've already handed out stock for, and a late delivery is
     * harmless thanks to orderId idempotency.
     */
    const val SETTLEMENT_QUEUE_TTL_MS = 7L * 24L * 60L * 60L * 1000L

    /** Same 7 days as settlements — a complaint older than that is stale news. */
    const val COMPLAINT_QUEUE_TTL_MS = 7L * 24L * 60L * 60L * 1000L

    /** Config poll cadence. Also the presence heartbeat, as on the coil app. */
    const val CONFIG_POLL_INTERVAL_MS = 60_000L
}
