package isl.snudursopi.fridge.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = AppColors.Ink,
    onPrimary = AppColors.Cream,
    secondary = AppColors.Bronze,
    onSecondary = AppColors.Cream,
    background = AppColors.Cream,
    onBackground = AppColors.Ink,
    surface = AppColors.White,
    onSurface = AppColors.Ink,
    surfaceVariant = AppColors.CreamShadow,
    onSurfaceVariant = AppColors.InkSoft,
    outline = AppColors.Line,
    error = AppColors.Alert,
    onError = AppColors.Cream,
)

/** Local access to our extended palette beyond Material3's defaults. */
val LocalAppColors = staticCompositionLocalOf { AppColors }

@Composable
fun SnudurSopiTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightColors,
        typography = AppMaterialTypography,
    ) {
        CompositionLocalProvider(LocalAppColors provides AppColors) {
            content()
        }
    }
}
