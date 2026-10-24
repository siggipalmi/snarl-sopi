package isl.snudursopi.vending.ui.screens.detail

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import isl.snudursopi.vending.R
import isl.snudursopi.vending.domain.ConnectionState
import isl.snudursopi.vending.domain.Language
import isl.snudursopi.vending.domain.Money
import isl.snudursopi.vending.domain.Nutrition
import isl.snudursopi.vending.domain.Product
import isl.snudursopi.vending.domain.ProductDetails
import isl.snudursopi.vending.ui.components.StatusBar
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppTypography
import isl.snudursopi.vending.ui.util.localized

/**
 * Product detail screen.
 *
 * With [details] present (and non-empty), shows pack size, an allergen pill
 * row, a nutrition table, ingredients, and notes — each section only when
 * its data exists. With no details, falls back to the photo-only screen:
 * enlarged photo, name, price.
 *
 * Static labels are localized via string resources (EN/IS). The
 * ingredients/allergens/notes TEXT is rendered as supplied by the backend.
 */
@Composable
fun DetailScreen(
    product: Product,
    details: ProductDetails?,
    language: Language,
    brand: String,
    currentTime: String,
    connectionState: ConnectionState,
    onBack: () -> Unit,
    onClockLongPress: () -> Unit = {},
) {
    val hasDetails = details?.hasAnyDetail == true

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(AppColors.Cream),
    ) {
        StatusBar(
            brand = brand,
            time = currentTime,
            connectionState = connectionState,
            onClockLongPress = onClockLongPress,
        )

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 28.dp, top = 14.dp, end = 28.dp, bottom = 12.dp),
        ) {
            Text(
                text = localized(language, R.string.detail_back),
                fontSize = 16.sp,
                color = AppColors.MutedSoft,
                modifier = Modifier.clickable(onClick = onBack),
            )
        }

        if (!hasDetails) {
            FallbackBody(product = product, language = language)
        } else {
            DetailedBody(product = product, details = details!!, language = language)
        }
    }
}

/** Photo-only fallback: large image, name, price. Today's behavior. */
@Composable
private fun ColumnScope.FallbackBody(product: Product, language: Language) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .weight(1f)
            .background(product.category.tileColor()),
        contentAlignment = Alignment.Center,
    ) {
        ProductPhoto(product, big = true)
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(0.5.dp)
            .background(AppColors.Line),
    )

    Column(
        modifier = Modifier.padding(start = 32.dp, top = 28.dp, end = 32.dp, bottom = 40.dp),
    ) {
        Text(
            text = product.name,
            style = AppTypography.DisplayLarge.copy(fontSize = 56.sp),
            color = AppColors.Ink,
        )
        product.subtitle?.let {
            Spacer(Modifier.height(8.dp))
            Text(text = it, fontSize = 18.sp, color = AppColors.MutedSoft)
        }
        Spacer(Modifier.height(24.dp))
        PriceBlock(product, language)
    }
}

/** Detailed body: compact hero + scrolling sections per the mockup. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ColumnScope.DetailedBody(
    product: Product,
    details: ProductDetails,
    language: Language,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(product.category.tileColor()),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.padding(top = 12.dp, bottom = 20.dp),
            ) {
                Box(
                    modifier = Modifier.size(width = 150.dp, height = 180.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    ProductPhoto(product, big = false)
                }
                Spacer(Modifier.height(10.dp))
                Text(
                    text = product.name,
                    style = AppTypography.DisplaySmall.copy(fontSize = 30.sp),
                    color = AppColors.Ink,
                )
                Spacer(Modifier.height(10.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    details.packSize?.takeIf { it.isNotBlank() }?.let { ps ->
                        Pill(text = ps)
                    }
                    Text(
                        text = Money(product.priceIsk).format(),
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = AppColors.Ink,
                    )
                }
            }
        }

        Column(
            modifier = Modifier.padding(start = 24.dp, top = 20.dp, end = 24.dp, bottom = 40.dp),
        ) {
            // ---- Allergens ----
            if (details.allergens.isNotEmpty() || details.mayContain.isNotEmpty()) {
                SectionHeader(localized(language, R.string.detail_allergens))
                Spacer(Modifier.height(8.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    details.allergens.forEach { AllergenChip(it, solid = true) }
                    details.mayContain.forEach { AllergenChip(it, solid = false) }
                }
                Spacer(Modifier.height(20.dp))
            }

            // ---- Nutrition ----
            if (details.nutrition?.hasAnyValue == true) {
                NutritionSection(details.nutrition, details.basis, language)
                details.notes?.takeIf { it.isNotBlank() }?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = it,
                        fontSize = 11.sp,
                        fontStyle = FontStyle.Italic,
                        color = AppColors.Muted,
                        lineHeight = 16.sp,
                    )
                }
                Spacer(Modifier.height(20.dp))
            } else {
                details.notes?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        text = it,
                        fontSize = 11.sp,
                        fontStyle = FontStyle.Italic,
                        color = AppColors.Muted,
                        lineHeight = 16.sp,
                    )
                    Spacer(Modifier.height(20.dp))
                }
            }

            // ---- Ingredients ----
            details.ingredients?.takeIf { it.isNotBlank() }?.let { ingr ->
                SectionHeader(localized(language, R.string.detail_ingredients))
                Spacer(Modifier.height(8.dp))
                Text(
                    text = ingr,
                    fontSize = 13.sp,
                    color = AppColors.InkSoft,
                    lineHeight = 20.sp,
                )
                Spacer(Modifier.height(20.dp))
            }

            PriceBlock(product, language)
        }
    }
}

// ---- pieces ----

@Composable
private fun ProductPhoto(product: Product, big: Boolean) {
    if (!product.imagePath.isNullOrBlank()) {
        AsyncImage(
            model = product.imagePath,
            contentDescription = product.name,
            modifier = if (big) {
                Modifier.fillMaxSize().padding(48.dp)
            } else {
                Modifier.fillMaxSize().padding(8.dp)
            },
            contentScale = ContentScale.Fit,
        )
    } else {
        Box(
            modifier = Modifier
                .size(width = if (big) 140.dp else 110.dp, height = if (big) 340.dp else 150.dp)
                .background(AppColors.Ink.copy(alpha = 0.7f), RoundedCornerShape(12.dp)),
        )
    }
}

@Composable
private fun PriceBlock(product: Product, language: Language) {
    Column {
        Text(
            text = localized(language, R.string.detail_price_label),
            fontSize = 13.sp,
            color = AppColors.MutedSoft,
            letterSpacing = 1.5.sp,
            fontWeight = FontWeight.Medium,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = Money(product.priceIsk).format(),
            style = AppTypography.DisplaySmall.copy(fontSize = 36.sp),
            color = AppColors.Bronze,
        )
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text.uppercase(),
        fontSize = 10.sp,
        letterSpacing = 1.6.sp,
        fontWeight = FontWeight.SemiBold,
        color = AppColors.Bronze,
    )
}

@Composable
private fun Pill(text: String) {
    Text(
        text = text,
        fontSize = 11.sp,
        color = AppColors.Muted,
        letterSpacing = 0.5.sp,
        modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(AppColors.White)
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(20.dp))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

@Composable
private fun AllergenChip(text: String, solid: Boolean) {
    if (solid) {
        Text(
            text = text,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = AppColors.White,
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .background(AppColors.Alert)
                .padding(horizontal = 10.dp, vertical = 5.dp),
        )
    } else {
        Text(
            text = text,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = AppColors.Alert,
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .background(AppColors.White)
                .border(1.dp, AppColors.Alert, RoundedCornerShape(6.dp))
                .padding(horizontal = 10.dp, vertical = 5.dp),
        )
    }
}

@Composable
private fun NutritionSection(nutrition: Nutrition, basis: String?, language: Language) {
    SectionHeader(localized(language, R.string.detail_nutrition))
    Spacer(Modifier.height(8.dp))

    // Resolve all labels here (Composable context) — buildNutritionRows is a
    // plain function and cannot call the @Composable localized() itself.
    val labels = NutritionLabels(
        energy = localized(language, R.string.nutrition_energy),
        fat = localized(language, R.string.nutrition_fat),
        saturates = localized(language, R.string.nutrition_saturates),
        carbs = localized(language, R.string.nutrition_carbs),
        sugars = localized(language, R.string.nutrition_sugars),
        protein = localized(language, R.string.nutrition_protein),
        fibre = localized(language, R.string.nutrition_fibre),
        salt = localized(language, R.string.nutrition_salt),
    )

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .border(0.5.dp, AppColors.Line, RoundedCornerShape(12.dp))
            .background(AppColors.White),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(AppColors.CreamShadow)
                .padding(horizontal = 13.dp, vertical = 7.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = localized(language, R.string.detail_nutrition_typical).uppercase(),
                fontSize = 9.5.sp,
                letterSpacing = 0.8.sp,
                color = AppColors.Muted,
            )
            basis?.takeIf { it.isNotBlank() }?.let {
                Text(
                    text = it,
                    fontSize = 9.5.sp,
                    letterSpacing = 0.8.sp,
                    color = AppColors.Muted,
                )
            }
        }

        val rows = buildNutritionRows(nutrition, labels)
        rows.forEachIndexed { i, row ->
            NutritionRow(row)
            if (i < rows.lastIndex) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(0.5.dp)
                        .background(AppColors.Line),
                )
            }
        }
    }
}

private data class NutritionLabels(
    val energy: String,
    val fat: String,
    val saturates: String,
    val carbs: String,
    val sugars: String,
    val protein: String,
    val fibre: String,
    val salt: String,
)

private data class NutRow(val label: String, val value: String, val major: Boolean, val sub: Boolean)

private fun fmt(v: Double): String =
    if (v == v.toLong().toDouble()) v.toLong().toString() else String.format("%.1f", v)

private fun buildNutritionRows(n: Nutrition, labels: NutritionLabels): List<NutRow> {
    val rows = mutableListOf<NutRow>()
    val energyParts = buildList {
        n.energyKj?.let { add("${fmt(it)} kJ") }
        n.energyKcal?.let { add("${fmt(it)} kcal") }
    }
    if (energyParts.isNotEmpty()) {
        rows += NutRow(labels.energy, energyParts.joinToString(" / "), major = true, sub = false)
    }
    n.fat?.let { rows += NutRow(labels.fat, "${fmt(it)} g", true, false) }
    n.saturates?.let { rows += NutRow(labels.saturates, "${fmt(it)} g", false, true) }
    n.carbs?.let { rows += NutRow(labels.carbs, "${fmt(it)} g", true, false) }
    n.sugars?.let { rows += NutRow(labels.sugars, "${fmt(it)} g", false, true) }
    n.protein?.let { rows += NutRow(labels.protein, "${fmt(it)} g", true, false) }
    n.fibre?.let { rows += NutRow(labels.fibre, "${fmt(it)} g", true, false) }
    n.salt?.let { rows += NutRow(labels.salt, "${fmt(it)} g", true, false) }
    return rows
}

@Composable
private fun NutritionRow(row: NutRow) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(
                start = if (row.sub) 27.dp else 13.dp,
                end = 13.dp,
                top = 8.dp,
                bottom = 8.dp,
            ),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = row.label,
            fontSize = 12.5.sp,
            color = if (row.sub) AppColors.Muted else AppColors.Ink,
            fontWeight = if (row.major) FontWeight.SemiBold else FontWeight.Normal,
        )
        Text(
            text = row.value,
            fontSize = 12.5.sp,
            color = if (row.sub) AppColors.Muted else AppColors.Ink,
        )
    }
}
