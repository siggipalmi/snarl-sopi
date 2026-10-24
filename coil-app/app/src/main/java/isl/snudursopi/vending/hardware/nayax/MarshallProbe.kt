package isl.snudursopi.vending.hardware.nayax

import android.util.Log
import com.bitmick.marshall.models.vmc_configuration
import com.bitmick.marshall.vmc.vmc_framework
import com.bitmick.marshall.vmc.vmc_link

/**
 * Minimal proof harness for the Nayax Marshall Java SDK on Android.
 *
 * Goal of this stage: confirm our [AndroidMarshallSerial] transport works —
 * i.e. the SDK opens /dev/ttyS3, completes the Marshall handshake, and fires
 * onReady (which is what clears the terminal's Error V00). We do NOT run a
 * payment here; we just want to see the host session come up.
 *
 * Usage: create, call start(), watch the log callback. onReady = success.
 * Then stop().
 */
class MarshallProbe(
    private val portPath: String = "/dev/ttyS3",
    private val baud: Int = 115200,
    private val log: (String) -> Unit,
) {
    companion object { private const val TAG = "MarshallProbe" }

    private var vmc: vmc_framework? = null
    @Volatile var ready = false
        private set

    fun start() {
        try {
            val m = vmc_framework.getInstance()
            vmc = m
            emit("marshall sdk version: ${vmc_framework.get_version()}")

            val cfg = vmc_configuration()
            cfg.port_vpos = portPath
            cfg.port_vpos_baud = baud
            cfg.machine_type = vmc_configuration.machine_type_type_beverage
            cfg.model = "snarl-sopi"
            cfg.serial = "01234567"
            cfg.sw_ver = vmc_framework.get_version()
            cfg.hw_ver = "wm55"
            cfg.manuf_code = "agv"
            cfg.multi_vend_support = false
            cfg.multi_session_support = false
            cfg.price_not_final_support = false
            cfg.reader_always_on = false
            cfg.always_idle = false
            cfg.vend_denied_policy = vmc_configuration.vend_denied_policy_cancel
            cfg.explicit_vend_success = false
            cfg.mifare_approved_by_vmc_support = false
            cfg.mag_card_approved_by_vmc_support = false
            cfg.dump_packets_level = vmc_configuration.debug_level_dump_moderate
            cfg.debug = true

            m.link.set_lowlevel(AndroidMarshallSerial())
            m.link.configure(cfg)
            m.link.set_events(object : vmc_link.vmc_link_events_t {
                override fun onReady(config: vmc_link.vpos_config_t) {
                    ready = true
                    val serial = config.vpos_serial?.let { String(it).reversed() } ?: "?"
                    emit("✅ onReady — VPOS host session UP. serial=$serial")
                    emit("   main fw=${config.main_fw_ver} pos fw=${config.pos_fw_ver}")
                    emit("   decimal_place=${config.decimal_place} (ISK should be 0) default_credit=${config.default_credit}")
                    emit("   currency=${config.currency_code?.let { String(it) } ?: "?"}")
                }

                override fun onCommError() {
                    emit("⚠ onCommError")
                }
            })
            m.link.start()
            emit("link.start() called — waiting for onReady on $portPath @ $baud")
        } catch (t: Throwable) {
            Log.e(TAG, "probe start failed", t)
            emit("probe start threw: ${t.message}")
        }
    }

    fun stop() {
        try {
            vmc?.link?.stop()
            vmc?.stop()
            emit("marshall probe stopped")
        } catch (t: Throwable) {
            emit("probe stop threw: ${t.message}")
        }
        ready = false
        vmc = null
    }

    private fun emit(s: String) {
        Log.i(TAG, s)
        log(s)
    }
}
