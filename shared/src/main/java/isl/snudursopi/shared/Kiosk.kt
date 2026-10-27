package isl.snudursopi.shared

import android.app.Application
import android.app.admin.DeviceAdminReceiver
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context

/**
 * What the shared code needs to know about the app it runs in. Set once, first thing
 * in Application.onCreate, before anything else here is touched.
 *
 * *** THE RECEIVER CLASSES STAY IN EACH APP, UNDER THEIR OLD NAMES.
 *
 * A watchdog alarm or a PackageInstaller callback created by the build being replaced
 * is an explicit Intent for a class name. Android keeps alarms across an update, so if
 * the new build had renamed or moved the receiver, the next tick would go to a class
 * that no longer exists — and the first self-update after this refactor would have
 * left every machine down with its safety net gone. The same goes for the Device
 * Owner admin component, which is recorded by name in the system when the machine is
 * provisioned. So the apps keep `WatchdogReceiver`, `update.UpdateResultReceiver` and
 * `KioskAdminReceiver` where they are, as thin shells, and tell this object which
 * classes those are.
 */
object Kiosk {
    @Volatile private var config: Config? = null

    class Config(
        val watchdogReceiver: Class<out BroadcastReceiver>,
        val updateResultReceiver: Class<out BroadcastReceiver>,
        val updateResultAction: String,
        val adminReceiver: Class<out DeviceAdminReceiver>,
    )

    fun init(app: Application, config: Config) {
        this.config = config
        AppVersion.init(app)
    }

    internal val watchdogReceiver: Class<out BroadcastReceiver>
        get() = require().watchdogReceiver
    internal val updateResultReceiver: Class<out BroadcastReceiver>
        get() = require().updateResultReceiver
    internal val updateResultAction: String
        get() = require().updateResultAction

    fun adminComponent(context: Context): ComponentName = ComponentName(context, require().adminReceiver)

    private fun require(): Config =
        config ?: error("Kiosk.init(app, config) must run first thing in Application.onCreate")
}
