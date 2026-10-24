package isl.snudursopi.vending.domain

/**
 * Read-only access to the machine's identity and backend credential.
 *
 * The deviceCode is set during first-run setup (operator types 8-digit code)
 * and persisted in DataStore. The machineKey is entered in the same flow, on
 * the step after the code is confirmed.
 *
 * The key lives here rather than in BuildConfig so that ONE apk serves the
 * whole fleet. Baking it in meant a separate build per machine, and — worse —
 * every hosted apk carried a live `mk_live_` credential for whoever found the
 * URL. Neither is workable at 46 machines.
 *
 * Never editable except via admin re-setup.
 */
interface DeviceIdentity {
    suspend fun deviceCode(): String?
    suspend fun setDeviceCode(code: String)
    suspend fun clearDeviceCode()

    /**
     * Rows whose lanes are DIRECT-PUSH, as a comma-separated list ("5,6").
     *
     * A pusher never completes a rotation, so the board reports a perfectly
     * good push as 0x05 "turned <1 turn". On a spiral that code means a genuine
     * stall, so it must stay a failure everywhere else — this list is what keeps
     * the exception confined to the lanes that need it.
     */
    suspend fun directPushRows(): String?

    /**
     * Local override for the board's infrared drop sensor: "on", "off", or null
     * to follow config.
     *
     * Needed because config re-applies its value on EVERY poll. With
     * hardware.dropSensor absent the default is off, so a sensor switched on by
     * hand was silently switched back within two minutes — and on a direct-push
     * lane the sensor is what stops the stroke. Without it the board pushes a
     * fixed distance instead of stopping when the product drops.
     */
    suspend fun dropSensorOverride(): String?
    suspend fun setDropSensorOverride(value: String)
    suspend fun setDirectPushRows(rows: String)

    /** The backend machine key for this machine, or null if never provisioned. */
    suspend fun machineKey(): String?
    suspend fun setMachineKey(key: String)
    suspend fun clearMachineKey()
}
