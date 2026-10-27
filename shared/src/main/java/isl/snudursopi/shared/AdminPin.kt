package isl.snudursopi.shared

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * This machine's admin PIN, as the backend sends it (config.adminPin): a PBKDF2-SHA256 hash, never
 * the PIN. Checked here, offline, so the admin sheet opens with no network, which is exactly when
 * a technician needs it. The backend side is snarl-sopi-backend/src/adminPin.js. One copy for both apps (fridge 0.69.0, coil 0.80.6).
 *
 * No hash in the config (none set yet, or an older backend) means the shared code, 123456.
 */
data class AdminPinHash(val iterations: Int, val salt: ByteArray, val hash: ByteArray) {
    fun matches(pin: String): Boolean {
        val spec = PBEKeySpec(pin.toCharArray(), salt, iterations, hash.size * 8)
        val got = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        return MessageDigest.isEqual(got, hash)
    }

    companion object {
        /** From config.adminPin; null when absent or not a shape we can check. */
        fun fromConfig(algo: String?, iterations: Int?, saltB64: String?, hashB64: String?): AdminPinHash? {
            if (algo != "pbkdf2-sha256" || iterations == null || iterations < 1 || saltB64 == null || hashB64 == null) return null
            return runCatching {
                AdminPinHash(iterations, Base64.getDecoder().decode(saltB64), Base64.getDecoder().decode(hashB64))
            }.getOrNull()?.takeIf { it.salt.isNotEmpty() && it.hash.isNotEmpty() }
        }
    }

    // ByteArray fields: content equality, so state comparisons don't see a new config as a change.
    override fun equals(other: Any?): Boolean = other is AdminPinHash && iterations == other.iterations &&
        salt.contentEquals(other.salt) && hash.contentEquals(other.hash)
    override fun hashCode(): Int = 31 * (31 * iterations + salt.contentHashCode()) + hash.contentHashCode()
}

object AdminPin {
    /** The fleet's shared code, until AG sets one for this machine. */
    const val SHARED = "123456"

    fun check(pinHash: AdminPinHash?, pin: String): Boolean =
        if (pinHash == null) pin == SHARED else pinHash.matches(pin)
}

/**
 * Five wrong PINs lock the pad for five minutes. Kept in [store] so restarting the app doesn't
 * reset the count: the restart button is behind the PIN, but a power cycle isn't.
 */
class AdminPinGuard(private val store: Store, private val now: () -> Long = System::currentTimeMillis) {
    interface Store {
        var failures: Int
        var lockedUntilMs: Long
    }

    /** Milliseconds left on a lock; 0 when the pad is open. */
    fun lockedForMs(): Long = (store.lockedUntilMs - now()).coerceAtLeast(0)

    fun triesLeft(): Int = (MAX_TRIES - store.failures).coerceAtLeast(0)

    fun succeeded() { store.failures = 0; store.lockedUntilMs = 0 }

    /** A wrong PIN. Returns true when this one locked the pad. */
    fun failed(): Boolean {
        val n = store.failures + 1
        if (n >= MAX_TRIES) {
            store.failures = 0
            store.lockedUntilMs = now() + LOCK_MS
            return true
        }
        store.failures = n
        return false
    }

    companion object {
        const val MAX_TRIES = 5
        const val LOCK_MS = 5 * 60 * 1000L
    }
}

/** Where the PIN lockout lives, so a power cycle doesn't reset the count. */
class AdminPinPrefs(context: android.content.Context) : AdminPinGuard.Store {
    private val prefs = context.getSharedPreferences("admin_pin", android.content.Context.MODE_PRIVATE)
    override var failures: Int
        get() = prefs.getInt("failures", 0)
        set(v) { prefs.edit().putInt("failures", v).apply() }
    override var lockedUntilMs: Long
        get() = prefs.getLong("locked_until", 0L)
        set(v) { prefs.edit().putLong("locked_until", v).apply() }
}
