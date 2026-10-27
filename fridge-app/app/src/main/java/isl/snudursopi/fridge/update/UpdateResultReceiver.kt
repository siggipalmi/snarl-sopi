package isl.snudursopi.fridge.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import isl.snudursopi.shared.UpdateResultHandler

/**
 * Receives the PackageInstaller commit result for a self-update. Stays in this package
 * under this name: the installer callback created by the build being replaced is an
 * explicit Intent for it (see shared Kiosk.kt). What happens with the result is in
 * [UpdateResultHandler].
 */
class UpdateResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        UpdateResultHandler.onReceive(context, intent)
    }

    companion object {
        const val ACTION = "isl.snudursopi.fridge.UPDATE_RESULT"
    }
}
