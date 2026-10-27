package isl.snudursopi.fridge.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.fridgeIdentityStore by preferencesDataStore(name = "fridge_identity")

/**
 * Where this machine's backend identity lives: its `deviceCode` (which machine
 * the backend thinks we are) and its `machineKey` (the `X-Machine-Key` secret).
 *
 * Same DataStore approach as the coil app's DataStoreDeviceIdentity, extended
 * with the key because the fridge talks to the admin backend from the start.
 *
 * Provisioning UI comes with the fleet work; until then these can be set from
 * the dev bar or adb, and the app degrades gracefully when they're absent
 * (no polling, settlements queue locally rather than being lost).
 */
class FridgeIdentityStore(private val context: Context) {
    private val deviceCodeKey = stringPreferencesKey("device_code")
    private val machineKeyKey = stringPreferencesKey("machine_key")

    suspend fun deviceCode(): String? =
        context.fridgeIdentityStore.data.map { it[deviceCodeKey] }.first()

    suspend fun machineKey(): String? =
        context.fridgeIdentityStore.data.map { it[machineKeyKey] }.first()

    suspend fun set(deviceCode: String, machineKey: String) {
        context.fridgeIdentityStore.edit {
            it[deviceCodeKey] = deviceCode
            it[machineKeyKey] = machineKey
        }
    }

    suspend fun clear() {
        context.fridgeIdentityStore.edit {
            it.remove(deviceCodeKey)
            it.remove(machineKeyKey)
        }
    }

    /** True when we have everything needed to talk to the backend. */
    suspend fun isProvisioned(): Boolean =
        !deviceCode().isNullOrBlank() && !machineKey().isNullOrBlank()
}
