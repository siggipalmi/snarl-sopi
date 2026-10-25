package isl.snudursopi.vending

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import isl.snudursopi.vending.ui.nav.NavGraph
import isl.snudursopi.vending.ui.state.VendingViewModel
import isl.snudursopi.vending.ui.state.VendingViewModelFactory
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.SnudurSopiTheme

class MainActivity : ComponentActivity() {

    private val viewModel: VendingViewModel by viewModels {
        VendingViewModelFactory(applicationContext)
    }

    // Liveness heartbeat: stamps "alive" every 30s while foreground so the watchdog
    // (SelfHealing) knows the app is healthy. Stops on pause; a stale stamp → relaunch.
    private val heartbeatHandler = Handler(Looper.getMainLooper())
    private val heartbeat = object : Runnable {
        override fun run() {
            Liveness.markAlive(this@MainActivity)
            heartbeatHandler.postDelayed(this, 30_000L)
        }
    }

    // Auto-revert health confirmation: if the app stays up (UI resumed) for ~25s, the
    // current build has proven itself — clear the pending flag and mark it known-good.
    private val healthConfirm = Runnable {
        RecoveryGuard.confirmHealthy(application)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Keep the screen on for a vending machine
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Hide Android status bar + nav bar via immersive sticky so customers
        // can't reach quicksettings, the app switcher, or back to the launcher.
        // The diagnostics screen calls SystemBarController.showSystemBars(window)
        // temporarily and re-hides on exit.
        SystemBarController.hideSystemBars(window)

        setContent {
            SnudurSopiTheme {
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(AppColors.Cream),
                    color = AppColors.Cream,
                ) {
                    NavGraph(viewModel = viewModel)
                }
            }
        }

        // True kiosk lockdown — escape-proof Lock Task Mode. No-op unless this
        // machine has been provisioned as Device Owner, so dev builds and
        // un-provisioned machines keep behaving exactly as before (immersive
        // only). The PIN-gated Diagnostics flow drops/re-asserts this for
        // maintenance.
        KioskManager.enableLockTask(this)

        // Automatic time back on at every start. The start after a power cut is
        // exactly when it matters: see ClockGuard.
        ClockGuard.enforceAutoTime(this)
    }

    override fun onResume() {
        super.onResume()
        heartbeatHandler.post(heartbeat) // marks alive now + every 30s while foreground
        heartbeatHandler.postDelayed(healthConfirm, 25_000L) // confirm build healthy after 25s up
    }

    override fun onPause() {
        super.onPause()
        heartbeatHandler.removeCallbacks(heartbeat)
        heartbeatHandler.removeCallbacks(healthConfirm)
    }

    /**
     * Re-hide the system bars whenever the window regains focus. Without this,
     * a user could swipe down to reveal the status bar and leave it visible.
     * Immersive sticky already auto-hides on a delay, but this is belt-and-
     * suspenders: if our window is in focus, the bars stay hidden.
     */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            SystemBarController.hideSystemBars(window)
        }
    }
}
