package isl.snudursopi.vending.ui.screens.browse

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.vending.domain.Basket
import isl.snudursopi.vending.domain.Product
import isl.snudursopi.vending.ui.components.ActionButton
import isl.snudursopi.vending.ui.components.AdRegion
import isl.snudursopi.vending.ui.components.ContactIcon
import isl.snudursopi.vending.ui.components.HeroBlock
import isl.snudursopi.vending.ui.components.LanguagePill
import isl.snudursopi.vending.ui.components.ProductCard
import isl.snudursopi.vending.ui.components.ScrollIndicator
import isl.snudursopi.vending.ui.components.StatusBar
import isl.snudursopi.vending.ui.components.TopToast
import isl.snudursopi.vending.ui.state.VendingState
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppTypography
import isl.snudursopi.vending.R
import isl.snudursopi.vending.ui.util.localized

@Composable
fun BrowseScreen(
    state: VendingState,
    onProductImageClick: (Product) -> Unit,
    onProductCartClick: (Product) -> Unit,
    onProductInfoClick: (Product) -> Unit,
    onContactClick: () -> Unit,
    onLanguageClick: () -> Unit,
    onCheckoutClick: () -> Unit,
    onClockLongPress: () -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(AppColors.Cream),
        ) {
            StatusBar(
                brand = state.brandLine,
                time = state.currentTime,
                connectionState = state.connectionState,
                onClockLongPress = onClockLongPress,
            )

            if (state.settings.showAdRegion && state.settings.ads.isNotEmpty()) {
                AdRegion(
                    ads = state.settings.ads,
                    config = state.settings.adRotation,
                )
            }

            CombinedHeader(
                state = state,
                onContactClick = onContactClick,
                onLanguageClick = onLanguageClick,
                onCheckoutClick = onCheckoutClick,
            )

            ProductGrid(
                state = state,
                onProductImageClick = onProductImageClick,
                onProductCartClick = onProductCartClick,
                onProductInfoClick = onProductInfoClick,
                modifier = Modifier.weight(1f),
            )
        }

        TopToast(
            message = state.toastMessage,
            visible = state.toastMessage != null,
        )
    }
}


/**
 * Combined header row: greeting + sub-line on the left, and either the
 * checkout pill (when basket has items) or the contact/language icons
 * (when basket is empty) on the right. Mutually exclusive so the row
 * stays a single height regardless of basket state.
 */
@Composable
private fun CombinedHeader(
    state: VendingState,
    onContactClick: () -> Unit,
    onLanguageClick: () -> Unit,
    onCheckoutClick: () -> Unit,
) {
    val greeting = if (state.isEvening) {
        localized(state.language, R.string.greeting_evening)
    } else {
        localized(state.language, R.string.greeting_day)
    }
    val subtitle = localized(state.language, R.string.greeting_sub_empty, state.visibleProducts.size)
    val basketHasItems = !state.basket.isEmpty

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 28.dp, end = 20.dp, top = 16.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = greeting,
                style = AppTypography.DisplayLarge.copy(fontSize = 48.sp),
                color = AppColors.Ink,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = subtitle,
                fontSize = 14.sp,
                color = AppColors.Muted,
            )
        }
        if (basketHasItems) {
            CheckoutPill(state = state, onClick = onCheckoutClick)
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ActionButton(icon = { ContactIcon() }, onClick = onContactClick)
                LanguagePill(code = state.language.code, onClick = onLanguageClick)
            }
        }
    }
}

/**
 * Compact dark pill replacing the old full-width CheckoutBar.
 * Fits in the right side of the combined header row.
 */
@Composable
private fun CheckoutPill(
    state: VendingState,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .background(AppColors.Ink, RoundedCornerShape(28.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Small circular count badge so the customer sees how many items at a glance.
        val itemCount = state.basket.itemCount
        Box(
            modifier = Modifier
                .size(28.dp)
                .background(AppColors.Cream.copy(alpha = 0.18f), RoundedCornerShape(50)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "$itemCount",
                color = AppColors.Cream,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
            )
        }
        Text(
            text = state.basket.total.format(),
            color = AppColors.Cream,
            fontSize = 17.sp,
            fontWeight = FontWeight.Medium,
        )
        Text(
            text = localized(state.language, R.string.basket_pay) + " →",
            color = AppColors.Cream.copy(alpha = 0.85f),
            fontSize = 15.sp,
        )
    }
}

@Composable
private fun ProductGrid(
    state: VendingState,
    onProductImageClick: (Product) -> Unit,
    onProductCartClick: (Product) -> Unit,
    onProductInfoClick: (Product) -> Unit,
    modifier: Modifier = Modifier,
) {
    val cartEnabled = state.basket.itemCount < Basket.MAX_ITEMS
    val gridState = rememberLazyGridState()

    // Box wraps the grid so we can overlay the floating scroll indicator
    Box(modifier = modifier.fillMaxWidth()) {
        LazyVerticalGrid(
            state = gridState,
            columns = GridCells.Fixed(4),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
            contentPadding = PaddingValues(vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Heroes scroll along with the rest of the catalog. Rendered as a
            // single full-width item spanning all 4 columns.
            if (state.heroes.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }, key = "hero-block") {
                    HeroBlock(
                        heroes = state.heroes,
                        basketIsFull = state.basket.itemCount >= Basket.MAX_ITEMS,
                        onHeroImageClick = { hero -> onProductImageClick(hero.product) },
                        onHeroCartClick = { hero -> onProductCartClick(hero.product) },
                        onHeroInfoClick = { hero -> onProductInfoClick(hero.product) },
                    )
                }
            }
            items(state.visibleProducts, key = { it.id }) { product ->
                val isInBasket = state.basket.lines.any { it.product.id == product.id }
                ProductCard(
                    product = product,
                    inBasket = isInBasket,
                    cartEnabled = cartEnabled,
                    language = state.language,
                    offer = state.offers[product.id],
                    onImageClick = { onProductImageClick(product) },
                    onCartClick = { onProductCartClick(product) },
                    onInfoClick = { onProductInfoClick(product) },
                    modifier = Modifier.aspectRatio(0.78f),
                )
            }
        }

        ScrollIndicator(
            gridState = gridState,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 16.dp),
        )
    }
}
