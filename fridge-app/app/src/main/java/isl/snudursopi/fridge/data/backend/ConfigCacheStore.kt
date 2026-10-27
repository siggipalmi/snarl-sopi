package isl.snudursopi.fridge.data.backend

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.fridgeConfigCache by preferencesDataStore(name = "fridge_config_cache")

/**
 * Caches the last good config response and its ETag.
 *
 * The cache isn't an optimisation — it's what lets the fridge KEEP SELLING when
 * it reboots with no network. Without it a power cut plus a dead uplink would
 * leave the machine with no planogram and therefore unable to open at all.
 */
class ConfigCacheStore(private val context: Context) {
    private val etagKey = stringPreferencesKey("etag")
    private val bodyKey = stringPreferencesKey("body_json")

    /**
     * *** THE CACHE IS TIED TO THE MACHINE THAT FILLED IT.
     *
     * Without this, a board re-provisioned to a different deviceCode loads the
     * PREVIOUS machine's planogram from cache and applies it as its own. Seen on
     * machine #2 (2026-08-27): re-pointed to 8626020716, restarted, and applied
     * the hostel single's 8-basket planogram — wrong cabinet count, wrong
     * prices, wrong support email on the info sheet, and no error anywhere.
     *
     * A planogram is what the machine charges people against, so a stale one
     * from another machine is worse than none: with none it fails visibly.
     */
    private val ownerKey = stringPreferencesKey("owner_device_code")

    suspend fun etag(): String? =
        context.fridgeConfigCache.data.map { it[etagKey] }.first()

    /**
     * The cached body, but ONLY if it was cached by [deviceCode]. A mismatch
     * returns null — better to start with no planogram and wait for a poll than
     * to sell from another machine's shelf layout.
     */
    suspend fun body(deviceCode: String?): String? {
        val prefs = context.fridgeConfigCache.data.first()
        val owner = prefs[ownerKey]
        if (owner != null && deviceCode != null && owner != deviceCode) return null
        return prefs[bodyKey]
    }

    suspend fun etagFor(deviceCode: String?): String? {
        val prefs = context.fridgeConfigCache.data.first()
        val owner = prefs[ownerKey]
        if (owner != null && deviceCode != null && owner != deviceCode) return null
        return prefs[etagKey]
    }

    suspend fun save(etag: String?, bodyJson: String, deviceCode: String?) {
        context.fridgeConfigCache.edit {
            if (etag.isNullOrBlank()) it.remove(etagKey) else it[etagKey] = etag
            it[bodyKey] = bodyJson
            if (deviceCode != null) it[ownerKey] = deviceCode
        }
    }
}
