package isl.snudursopi.fridge

import android.app.admin.DeviceAdminReceiver

/**
 * Device-admin receiver. Enables Device Owner (one-time, per machine, over ADB).
 *
 * NOTE THE PACKAGE vs CLASS SPLIT — the shorthand form does NOT work here.
 * Debug builds carry applicationIdSuffix ".debug", but the class stays in
 * isl.snudursopi.fridge, and `pkg/.Class` expands to `pkg.Class`. So:
 *
 *   fleet:    adb shell dpm set-device-owner \
 *               isl.snudursopi.fridge.debug/isl.snudursopi.fridge.KioskAdminReceiver
 *
 * EVERY MACHINE RUNS THE .debug PACKAGE: CI builds assembleDebug and signs it
 * with the fleet key, and that is what OTA and the download site ship. The
 * package-without-.debug form fails with "Unknown admin" (8626020713, 2026-10-13).
 * Check first with `adb shell pm list packages | grep snudursopi`.
 *
 * Device Owner is what enables escape-proof Lock Task Mode AND silent OTA
 * installs. Same mechanism as the coil app, separate package so the two fleets
 * never collide. It can only be set on a device with no other device owner and
 * no accounts — that gate is clear on the test unit.
 */
class KioskAdminReceiver : DeviceAdminReceiver()
