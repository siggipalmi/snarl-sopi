package isl.snudursopi.vending.api

/**
 * Weimi API credentials. Hardcoded here for the prototype.
 * In a production build, these should come from a secure store, build config,
 * or an admin-configured runtime value — not committed to the repo.
 *
 * These are the credentials for the test/staging Weimi environment.
 */
object WeimiCredentials {
    const val APP_ID = "8c98f0207729893439e089e3703b6b37"
    const val SECRET_KEY = "1M1@#MLH4w#ko1k!/1D$"

    /** Toggle between test and production environments. */
    const val USE_TEST_ENDPOINT = false
}
