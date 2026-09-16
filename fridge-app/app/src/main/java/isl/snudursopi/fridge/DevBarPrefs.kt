package isl.snudursopi.fridge

import android.content.Context
import androidx.compose.runtime.mutableStateOf

/**
 * Whether the developer bar is shown.
 *
 * *** THE FLEET RUNS DEBUG BUILDS, SO BuildConfig.DEBUG IS NOT A GUARD.
 *
 * The dev bar was gated behind `BuildConfig.DEBUG` on the reasonable assumption
 * that production machines would be release builds. They are not: Device Owner
 * is bound to the `.debug` applicationId, so a machine in the field runs the
 * debug variant and the bar was showing to paying customers — visible in
 * Siggi's photos of the complaint screen, a row of black test buttons under a
 * form about something having gone wrong.
 *
 * So visibility is a runtime setting, defaulting to OFF, toggled from the admin
 * sheet behind the PIN. The tools stay available to whoever is standing at the
 * machine with the code; they are simply not on display.
 *
 * Persisted rather than in-memory because the app relaunches by itself four
 * minutes after an admin visits Settings — an in-memory flag would vanish
 * mid-service. Written with `.commit()`, per the rule learned the hard way on
 * the revert path: a process that dies before an async write flushes loses it.
 */
object DevBarPrefs {
    private const val PREFS = "dev_bar"
    private const val KEY_VISIBLE = "visible"

    /**
     * Snapshot state as well as a pref, so toggling from the admin sheet takes
     * effect on the next composition rather than at the next restart. A plain
     * `remember { isVisible() }` in MainActivity would hold the stale value and
     * the button would appear to do nothing.
     */
    private val state = mutableStateOf<Boolean?>(null)

    fun isVisible(ctx: Context): Boolean =
        state.value ?: ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_VISIBLE, false)
            .also { state.value = it }

    fun setVisible(ctx: Context, visible: Boolean) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_VISIBLE, visible)
            .commit()
        state.value = visible
    }
}
