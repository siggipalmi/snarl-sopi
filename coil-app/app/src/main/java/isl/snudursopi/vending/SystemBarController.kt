package isl.snudursopi.vending

import android.view.Window
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Kiosk lockdown for the Android system bars.
 *
 * Default ([hideSystemBars]): status + navigation bars hidden via immersive
 * sticky. Customers can swipe edges to briefly reveal them but the system
 * auto-hides. They cannot reach quicksettings, the app switcher, or back
 * to the launcher.
 *
 * Diagnostics ([showSystemBars]): the bars are shown persistently — *not*
 * transient — so the technician can use Wi-Fi quicksettings etc. This works
 * by switching the controller behavior to BEHAVIOR_DEFAULT; the kiosk
 * lockdown is restored by [hideSystemBars] when leaving diagnostics.
 *
 * On real WM55 hardware we'd also want device-owner provisioning
 * (`adb dpm set-device-owner`) for true lockdown resilient to swipes.
 * Immersive sticky is the right baseline; device-owner is an additional
 * layer on top, not a replacement.
 */
object SystemBarController {

    fun hideSystemBars(window: Window) {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    fun showSystemBars(window: Window) {
        WindowCompat.setDecorFitsSystemWindows(window, true)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        // BEHAVIOR_DEFAULT keeps the bars visible until we explicitly hide them.
        // Without this, BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE from hideSystemBars
        // remains sticky and the system re-hides the bars almost immediately.
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
        controller.show(WindowInsetsCompat.Type.systemBars())
    }
}
