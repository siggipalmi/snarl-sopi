package isl.snudursopi.vending.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddShoppingCart
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import isl.snudursopi.vending.domain.Money
import isl.snudursopi.vending.domain.Offer
import isl.snudursopi.vending.domain.Product
import isl.snudursopi.vending.domain.Language
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.R
import isl.snudursopi.vending.ui.util.localized

@Composable
fun ProductCard(
    product: Product,
    inBasket: Boolean,
    cartEnabled: Boolean,
    language: Language,
    offer: Offer? = null,
    onImageClick: () -> Unit,
    onCartClick: () -> Unit,
    onInfoClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val borderColor = if (inBasket) AppColors.Ink else AppColors.Line
    val borderWidth = if (inBasket) 2.dp else 0.5.dp
    val outOfStock = !product.inStock
    // Offer rendering (display-only; checkout quote is authoritative for the charge).
    val discountedPrice = offer?.discountedDisplayPriceIsk(product.priceIsk)
    val dealMain = if (!outOfStock) offer?.dealBarMain(language) else null
    val dealSub = if (!outOfStock) offer?.dealBarSub(language) else null

    Box(modifier = modifier.alpha(if (outOfStock) 0.5f else 1f)) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .clip(RoundedCornerShape(16.dp))
                .background(AppColors.White)
                .border(borderWidth, borderColor, RoundedCornerShape(16.dp))
                .padding(12.dp),
        ) {
            // Image — primary tap target
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .clip(RoundedCornerShape(10.dp))
                    .background(product.category.tileColor())
                    .clickable(enabled = !outOfStock, onClick = onImageClick),
                contentAlignment = Alignment.Center,
            ) {
                // Real product photo if we have a URL; silhouette as fallback
                if (!product.imagePath.isNullOrBlank()) {
                    AsyncImage(
                        model = product.imagePath,
                        contentDescription = product.name,
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(12.dp),
                        contentScale = ContentScale.Fit,
                    )
                } else {
                    ProductSilhouette(product)
                }
                if (outOfStock) {
                    Text(
                        text = localized(language, R.string.card_sold_out),
                        color = AppColors.Cream,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier
                            .align(Alignment.TopStart)
                            .padding(10.dp)
                            .background(AppColors.Ink, RoundedCornerShape(6.dp))
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                    )
                }
                if (product.featured && !outOfStock) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .padding(10.dp)
                            .size(10.dp)
                            .background(AppColors.Bronze, CircleShape),
                    )
                }
                // Offer bar (expiry / multibuy / combo) — alert red, like hero tiles.
                if (dealMain != null) {
                    Column(
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .background(AppColors.Alert)
                            .padding(vertical = 5.dp, horizontal = 8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            text = dealMain,
                            color = AppColors.White,
                            fontSize = 12.sp,
                            lineHeight = 14.sp,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            textAlign = TextAlign.Center,
                        )
                        if (dealSub != null) {
                            Text(
                                text = dealSub,
                                color = AppColors.White,
                                fontSize = 11.sp,
                                lineHeight = 13.sp,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))

            // Bottom area — name/subtitle/price on left, action icons stacked on right
            Box(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(end = 56.dp)) {
                    Text(
                        text = product.name,
                        color = AppColors.Ink,
                        fontSize = 18.sp,
                        lineHeight = 22.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = if (inBasket) "· " + localized(language, R.string.card_in_basket) else (product.subtitle ?: ""),
                        color = if (inBasket) AppColors.Ink else AppColors.Muted,
                        fontSize = 14.sp,
                        lineHeight = 16.sp,
                        fontWeight = if (inBasket) FontWeight.Medium else FontWeight.Normal,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Spacer(Modifier.height(6.dp))
                    if (discountedPrice != null && discountedPrice < product.priceIsk) {
                        Row(
                            verticalAlignment = Alignment.Bottom,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = Money(discountedPrice).format(),
                                color = AppColors.Bronze,
                                fontSize = 18.sp,
                                lineHeight = 20.sp,
                                fontWeight = FontWeight.Medium,
                            )
                            Text(
                                text = Money(product.priceIsk).format(),
                                color = AppColors.Muted,
                                fontSize = 13.sp,
                                lineHeight = 20.sp,
                                textDecoration = TextDecoration.LineThrough,
                            )
                        }
                    } else {
                        Text(
                            text = Money(product.priceIsk).format(),
                            color = AppColors.Bronze,
                            fontSize = 18.sp,
                            lineHeight = 20.sp,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                }

                // Stacked icon column — cart on top, info below
                Column(
                    modifier = Modifier.align(Alignment.BottomEnd),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    // Cart button
                    Box(
                        modifier = Modifier
                            .size(40.dp)
                            .alpha(if (cartEnabled && !outOfStock) 1f else 0.3f)
                            .clip(CircleShape)
                            .background(AppColors.Ink)
                            .clickable(
                                enabled = cartEnabled && !outOfStock,
                                onClick = onCartClick,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.AddShoppingCart,
                            contentDescription = "Bæta í körfu",
                            tint = AppColors.Cream,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                    // Info button
                    Box(
                        modifier = Modifier
                            .size(40.dp)
                            .clip(CircleShape)
                            .background(AppColors.CreamShadow)
                            .clickable(onClick = onInfoClick),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "i",
                            color = AppColors.InkSoft,
                            fontSize = 20.sp,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ProductSilhouette(product: Product) {
    val (color, sizes) = silhouetteFor(product)
    // Scale up silhouettes to match the larger card
    val scale = 2.2f
    Box(
        modifier = Modifier
            .size(
                width = (sizes.first * scale).dp,
                height = (sizes.second * scale).dp,
            )
            .background(color, RoundedCornerShape(6.dp)),
    )
}

private fun silhouetteFor(product: Product): Pair<Color, Pair<Int, Int>> {
    return when {
        "skyr" in product.name -> Color(0xFFC92929) to (16 to 38)
        "hydra" in product.name && "lemon" in product.name -> Color(0xFFA3D675) to (32 to 6)
        "hydra" in product.name && "ginger" in product.name -> Color(0xFFDDAA30) to (32 to 6)
        "hydra" in product.name && "berry" in product.name -> Color(0xFFD4537E) to (32 to 6)
        "corny" in product.name && "brown" in product.name -> Color(0xFF8C4A26) to (28 to 36)
        "corny" in product.name && "súkk" in product.name -> Color(0xFF5C3A1E) to (28 to 36)
        "corny" in product.name && "coconut" in product.name -> Color(0xFFB8823A) to (28 to 36)
        "corny" in product.name -> Color(0xFFA85B2A) to (28 to 36)
        "oat king" in product.name && "chocolate" in product.name -> Color(0xFF6B8B2E) to (28 to 36)
        "oat king" in product.name -> Color(0xFF8B6F4E) to (28 to 36)
        "powerade" in product.name && "blár" in product.name -> Color(0xFF3D6EC4) to (14 to 40)
        "powerade" in product.name -> Color(0xFFD4A30F) to (14 to 40)
        "pagen" in product.name -> Color(0xFFC4892A) to (28 to 26)
        "fylkis" in product.name -> Color(0xFFB8471F) to (14 to 40)
        "golfkúlur" in product.name -> Color.White to (18 to 18)
        "kaffi" in product.name -> Color(0xFF3D2817) to (14 to 38)
        else -> Color(0xFF888888) to (24 to 30)
    }
}
