package isl.snudursopi.vending.data.backend

/**
 * Configuration for the AG Vending admin backend.
 *
 * Separate from [isl.snudursopi.vending.proxy.BackendConfig] which is
 * specifically about the temporary Weimi-proxy WebSocket bridge. This
 * file is for permanent admin-backend integration (currently:
 * complaints; later: config sync, sales events, etc.).
 */
object AdminBackendConfig {
    /**
     * Base URL of the admin backend.
     *
     * TODO: move to BuildConfig or runtime config when we have separate
     * dev/staging/prod environments. Hardcoded for now.
     */
    const val BASE_URL = "https://snarl-sopi-production.up.railway.app"

    /**
     * Maximum number of queued items in the complaint retry queue.
     * If we exceed this (very unlikely in practice — would require
     * many sustained-outage complaints), oldest ones get dropped.
     */
    const val COMPLAINT_QUEUE_MAX_SIZE = 50

    /**
     * After this duration since first submission attempt, the kiosk
     * stops retrying a complaint and logs the drop. By this point the
     * machine has been offline so long that the operator already
     * knows something's wrong via other channels.
     */
    const val COMPLAINT_QUEUE_TTL_MS = 24L * 60L * 60L * 1000L  // 24 hours

    /**
     * Sales retry queue cap. More generous than complaints: a sale is a
     * stock decrement + revenue, so we'd rather hold a lot through a long
     * outage than drop any. Replays are safe (backend dedupes by saleId).
     */
    const val SALES_QUEUE_MAX_SIZE = 500

    /**
     * How long to keep retrying a queued sale. 7 days — long, because
     * losing a sale loses stock accuracy and revenue, and idempotent
     * replay makes a late delivery harmless.
     */
    const val SALES_QUEUE_TTL_MS = 7L * 24L * 60L * 60L * 1000L  // 7 days
}
