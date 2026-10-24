package isl.snudursopi.vending.ui.screens.admin

/**
 * Auth gate for the diagnostics screen.
 *
 * DEV: hardcoded 6-digit PIN. This is intentional and isolated to one
 * function so the swap to TOTP later is surgical.
 *
 * TODO (admin backend): replace [verify] with TOTP verification against a
 * per-device secret fetched from the admin backend at sync time and stored
 * in DataStore (encrypted via EncryptedSharedPreferences). The shape of
 * verify(code: String) stays the same so the caller doesn't change.
 */
object DiagnosticsAuth {
    /** Set this before deploying anywhere. */
    private const val DEV_PIN = "123456"

    fun verify(code: String): Boolean {
        return code == DEV_PIN
    }
}
