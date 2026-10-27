package isl.snudursopi.fridge

import android.content.Context
import androidx.core.content.pm.PackageInfoCompat

/**
 * The version of the build that is actually installed, read from Android.
 *
 * *** NEVER COMPARE AGAINST BuildConfig.VERSION_CODE.
 *
 * It is a compile-time constant, so the compiler copies its value into every
 * file that uses it. An incremental build that does not recompile one of those
 * files ships the OLD number inside it. On 2026-10-01 machine 8626020623 ran
 * 0.57.0 (138), which Android and the admin sheet both reported, while the
 * updater — unchanged since 0.55.0 and so not recompiled on the Mac — told the
 * backend it was 136. The compiled class still held `sipush 136`. The same
 * stale number fed the "is this offer newer?" check and RecoveryGuard's "is the
 * running build the one being watched?".
 *
 * The package manager's record cannot go stale that way. CI builds are clean
 * and unaffected; this is for every build made anywhere else.
 */
object AppVersion {
    @Volatile
    var code: Int = BuildConfig.VERSION_CODE
        private set

    @Volatile
    var name: String = BuildConfig.VERSION_NAME
        private set

    /** First thing in Application.onCreate, before anything reads the version. */
    fun init(context: Context) {
        runCatching {
            @Suppress("DEPRECATION")
            val pi = context.packageManager.getPackageInfo(context.packageName, 0)
            code = PackageInfoCompat.getLongVersionCode(pi).toInt()
            name = pi.versionName ?: name
        }
    }
}
