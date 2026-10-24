package isl.snudursopi.vending.hardware

/**
 * Parsers for the energy/cooling board replies (SDK section 3).
 *
 * These decode the raw ASCII-hex reply frames into human-readable
 * readings, using the substring offsets documented in the SDK manual.
 *
 * IMPORTANT — unproven until a chilled machine confirms: the offsets and
 * scaling below come straight from the SDK doc. They have NOT yet been
 * validated against a real energy-board frame (the bench machine had no
 * cooling board). Treat decoded values with suspicion until a probe on a
 * chilled machine confirms them. This is exactly why the test screen
 * shows the RAW frame alongside the decoded values.
 */
object EnergyReading {

    /**
     * Temperature reply (cmd == INSTRUCT_CTL_TEMP).
     *
     * Doc parse rules:
     *   status        = data[18,20) hex   (0 = ok, 1 = fail)
     *   cabinetTemp   = data[20,24) hex as signed short, ÷10 = °C
     *   cabinetHum    = data[24,28) hex
     *   evaporator    = data[28,32) hex
     *   statusFlag    = data[32,34) hex
     */
    data class Temperature(
        val cabinetTempC: Double?,
        val setpointC: Int?,
        val humidity: Int?,
        val evaporatorRaw: Int?,
        val statusOk: Boolean?,
        val detail: String,
    )

    fun parseTemperature(data: String?): Temperature {
        if (data == null || data.length < 34) {
            return Temperature(null, null, null, null, null, "frame too short (len=${data?.length ?: 0})")
        }
        val status = data.substringHex(18, 20)
        val tempRaw = data.substringHex(20, 24)
        // signed short ÷ 10
        val tempC = tempRaw?.let { (it.toShort()).toInt() / 10.0 }
        val hum = data.substringHex(24, 28)
        val evap = data.substringHex(28, 32)
        // Frame layout (confirmed live): the byte at [36:38] is the sub-command
        // echo (0 = temp read, 18 = compressor, 5 = defrost) and its value follows
        // at [38:40]. On a temp-read frame that value IS the stored setpoint (whole
        // degrees). Only trust it when the sub-command byte is 0, so a compressor/
        // defrost reply's value isn't mistaken for the setpoint.
        val subcmd = if (data.length >= 38) data.substringHex(36, 38) else null
        val setpoint = if (subcmd == 0 && data.length >= 40) data.substringHex(38, 40) else null
        return Temperature(
            cabinetTempC = tempC,
            setpointC = setpoint,
            humidity = hum,
            evaporatorRaw = evap,
            statusOk = status?.let { it == 0 },
            detail = "temp=${tempC?.let { "%.1f°C".format(it) } ?: "?"}, " +
                "set=${setpoint?.let { "$it°C" } ?: "?"}, " +
                "hum=${hum ?: "?"}, evap=${evap ?: "?"}, status=${status ?: "?"}",
        )
    }

    /**
     * Power/electrical reply (cmd == INSTRUCT_GET_ELE_INFO).
     *
     * Doc parse rules:
     *   battery/energy = data[18,26) hex, ÷100
     *   voltage        = data[26,30) hex, ÷100 = V
     *   current        = data[30,34) hex, ÷100 = A
     */
    data class Power(
        val energy: Double?,
        val voltageV: Double?,
        val currentA: Double?,
        val detail: String,
    )

    fun parsePower(data: String?): Power {
        if (data == null || data.length < 34) {
            return Power(null, null, null, "frame too short (len=${data?.length ?: 0})")
        }
        val energy = data.substringHex(18, 26)?.let { it / 100.0 }
        val voltage = data.substringHex(26, 30)?.let { it / 100.0 }
        val current = data.substringHex(30, 34)?.let { it / 100.0 }
        return Power(
            energy = energy,
            voltageV = voltage,
            currentA = current,
            detail = "energy=${energy?.let { "%.2f".format(it) } ?: "?"}, " +
                "V=${voltage?.let { "%.2f".format(it) } ?: "?"}, " +
                "A=${current?.let { "%.2f".format(it) } ?: "?"}",
        )
    }

    private fun String.substringHex(start: Int, end: Int): Int? =
        runCatching { substring(start, end).toInt(16) }.getOrNull()
}
