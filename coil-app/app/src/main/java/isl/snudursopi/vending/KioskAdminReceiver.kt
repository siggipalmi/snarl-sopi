package isl.snudursopi.vending

import android.app.admin.DeviceAdminReceiver

/**
 * Device-admin receiver. Its only job is to exist as a component the system
 * can grant Device Owner to:
 *
 *   adb shell dpm set-device-owner isl.snudursopi.vending/.KioskAdminReceiver
 *
 * No policy callbacks are needed — being Device Owner is what unlocks true
 * Lock Task Mode (see [KioskManager]). Until a machine is provisioned, this
 * class sits inert and the app behaves exactly as before (immersive only).
 */
class KioskAdminReceiver : DeviceAdminReceiver()
