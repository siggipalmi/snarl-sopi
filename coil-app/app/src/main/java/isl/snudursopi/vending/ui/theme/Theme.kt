package isl.snudursopi.vending.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider

/** Applies a [Skin] to everything below: Material's scheme and type, and [LocalSkin] for our own tokens. */
@Composable
fun SnudurSopiTheme(skin: Skin = Skins.Classic, content: @Composable () -> Unit) {
    val c = skin.colors
    val scheme = lightColorScheme(
        primary = c.Ink, onPrimary = c.Cream,
        secondary = c.Bronze, onSecondary = c.Cream,
        background = c.Cream, onBackground = c.Ink,
        surface = c.White, onSurface = c.Ink,
        surfaceVariant = c.CreamShadow, onSurfaceVariant = c.InkSoft,
        outline = c.Line,
        error = c.Alert, onError = c.Cream,
    )
    val t = skin.type
    val typography = Typography(
        displayLarge = t.DisplayLarge, displayMedium = t.DisplayMedium, displaySmall = t.DisplaySmall,
        bodyLarge = t.BodyLarge, bodyMedium = t.BodyMedium, bodySmall = t.BodySmall,
        labelLarge = t.Label, labelMedium = t.Label, labelSmall = t.LabelSmall,
    )
    CompositionLocalProvider(LocalSkin provides skin) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
