package isl.snudursopi.fridge.ui.util

import android.content.Context
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import isl.snudursopi.fridge.domain.Language
import java.util.Locale

/**
 * Resolve a string resource for the in-app [Language] toggle (NOT the system
 * locale). The kiosk's language is chosen at runtime via the language pill,
 * so we must look strings up against [language].code ("is"/"en"/"pl"), not
 * whatever locale the tablet's OS happens to be set to.
 *
 * Strings live in res/values (Icelandic, default) and res/values-en. A code
 * with no matching values-<code> folder falls back to the default (Icelandic).
 *
 * Shared helper used by any screen that needs runtime EN/IS text.
 */
@Composable
fun localized(language: Language, resId: Int): String {
    val base = LocalContext.current
    return resolveString(base, language.code, resId)
}

/** Overload for formatted strings with args. */
@Composable
fun localized(language: Language, resId: Int, vararg formatArgs: Any): String {
    val base = LocalContext.current
    return resolveString(base, language.code, resId, *formatArgs)
}

private fun resolveString(base: Context, code: String, resId: Int, vararg formatArgs: Any): String {
    val locale = Locale(code)
    val config = android.content.res.Configuration(base.resources.configuration)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        config.setLocale(locale)
    } else {
        @Suppress("DEPRECATION")
        config.locale = locale
    }
    val localizedContext = base.createConfigurationContext(config)
    return if (formatArgs.isEmpty()) {
        localizedContext.getString(resId)
    } else {
        localizedContext.getString(resId, *formatArgs)
    }
}
