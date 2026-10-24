package isl.snudursopi.vending.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import isl.snudursopi.vending.domain.DeviceIdentity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.deviceIdentityStore by preferencesDataStore(name = "device_identity")

class DataStoreDeviceIdentity(private val context: Context) : DeviceIdentity {
    private val deviceCodeKey = stringPreferencesKey("device_code")
    private val machineKeyKey = stringPreferencesKey("machine_key")
    private val directPushRowsKey = stringPreferencesKey("direct_push_rows")
    private val dropSensorOverrideKey = stringPreferencesKey("drop_sensor_override")

    override suspend fun deviceCode(): String? =
        context.deviceIdentityStore.data
            .map { it[deviceCodeKey] }
            .first()

    override suspend fun setDeviceCode(code: String) {
        context.deviceIdentityStore.edit { it[deviceCodeKey] = code }
    }

    override suspend fun clearDeviceCode() {
        context.deviceIdentityStore.edit { it.remove(deviceCodeKey) }
    }

    override suspend fun directPushRows(): String? =
        context.deviceIdentityStore.data
            .map { it[directPushRowsKey]?.takeIf { v -> v.isNotBlank() } }
            .first()

    override suspend fun setDirectPushRows(rows: String) {
        context.deviceIdentityStore.edit { it[directPushRowsKey] = rows.trim() }
    }

    override suspend fun dropSensorOverride(): String? =
        context.deviceIdentityStore.data
            .map { it[dropSensorOverrideKey]?.takeIf { v -> v.isNotBlank() } }
            .first()

    override suspend fun setDropSensorOverride(value: String) {
        context.deviceIdentityStore.edit { it[dropSensorOverrideKey] = value.trim() }
    }

    override suspend fun machineKey(): String? =
        context.deviceIdentityStore.data
            .map { it[machineKeyKey]?.takeIf { k -> k.isNotBlank() } }
            .first()

    override suspend fun setMachineKey(key: String) {
        context.deviceIdentityStore.edit { it[machineKeyKey] = key.trim() }
    }

    override suspend fun clearMachineKey() {
        context.deviceIdentityStore.edit { it.remove(machineKeyKey) }
    }
}
