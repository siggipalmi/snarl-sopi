package isl.snudursopi.vending.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import isl.snudursopi.vending.domain.HeroLine
import isl.snudursopi.vending.domain.Money
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts

/**
 * Hero block — rendered inside the LazyVerticalGrid as a full-span item, so
 * the heroes scroll naturally with the rest of the catalog rather than
 * sitting in a separate pinned strip above it.
 *
 * Layout per tile:
 *  - Wider-than-tall (150dp height by default) colored rectangle
 *  - 1:1 product image floats centered; category color bleeds on the sides
 *  - Cart + info buttons stacked in the top-right gutter (outside the image)
 *
 * Below the row of tiles: a matching row of editorial captions (tag, name,
 * price) so the band stays clean and doesn't crowd the image.
 *
 * The caller wraps this in `item(span = { GridItemSpan(maxLineSpan) })`.
 */
@Composable
fun HeroBlock(
    heroes: List<HeroLine>,
    onHeroImageClick: (HeroLine) -> Unit,
    onHeroCartClick: (HeroLine) -> Unit,
    onHeroInfoClick: (HeroLine) -> Unit,
    basketIsFull: Boolean,
    modifier: Modifier = Modifier,
) {
    if (heroes.isEmpty()) return
    Column(modifier = modifier.fillMaxWidth()) {
        // Row of hero tiles — image + actions only, no copy
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            heroes.take(2).forEach { hero ->
                HeroTile(
                    hero = hero,
                    onImageClick = { onHeroImageClick(hero) },
                    onCartClick = { onHeroCartClick(hero) },
                    onInfoClick = { onHeroInfoClick(hero) },
                    cartDisabled = basketIsFull,
                    modifier = Modifier.weight(1f),
                )
            }
            // Pad out the row when only 1 hero so it stays half-width.
            if (heroes.size == 1) {
                Spacer(modifier = Modifier.weight(1f))
            }
        }
        Spacer(Modifier.height(6.dp))
        // Row of editorial captions, aligned column-for-column with tiles above
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            heroes.take(2).forEach { hero ->
                HeroCaption(
                    hero = hero,
                    modifier = Modifier.weight(1f),
                )
            }
            if (heroes.size == 1) {
                Spacer(modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun HeroTile(
    hero: HeroLine,
    onImageClick: () -> Unit,
    onCartClick: () -> Unit,
    onInfoClick: () -> Unit,
    cartDisabled: Boolean,
    modifier: Modifier = Modifier,
) {
    val product = hero.product
    // Hero tile sized so its image area is roughly 125% the height of a
    // regular product card's image area. Hero row spans the full grid width
    // (= 4 regular tiles + 3 gaps), so each hero tile is ~2x as wide as a
    // regular tile. aspectRatio(1.8f) keeps the height proportional to that.
    Box(
        modifier = modifier
            .aspectRatio(1.8f)
            .clip(RoundedCornerShape(14.dp))
            .background(product.category.tileColor())
            .clickable(onClick = onImageClick),
        contentAlignment = Alignment.Center,
    ) {
        // Square image centered inside the wider tile. The horizontal padding
        // is intentional — category color bleeds on either side.
        if (!product.imagePath.isNullOrBlank()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 30.dp, vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                AsyncImage(
                    model = product.imagePath,
                    contentDescription = product.name,
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Fit,
                )
            }
        }

        // Action buttons stacked in the top-right gutter — same 40dp style
        // as the regular grid tiles (solid ink cart, creamshadow info).
        Column(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // Cart button — solid ink, cream icon (matches ProductCard).
            Box(
                modifier = Modifier
                    .alpha(if (cartDisabled) 0.3f else 1f)
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(AppColors.Ink)
                    .clickable(enabled = !cartDisabled, onClick = onCartClick),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Outlined.AddShoppingCart,
                    contentDescription = "Bæta í körfu",
                    tint = AppColors.Cream,
                    modifier = Modifier.size(20.dp),
                )
            }
            // Info button — creamshadow circle with "i" (matches ProductCard).
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

        // Tag badge — bold italic serif, overlaying the bottom-left of the
        // tile in alert red so it pops against any category tint.
        if (hero.tag.isNotBlank()) {
            Text(
                text = hero.tag.lowercase(),
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontWeight = FontWeight.SemiBold,
                fontSize = 17.sp,
                color = AppColors.Cream,
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .clip(RoundedCornerShape(topEnd = 12.dp))
                    .background(AppColors.Alert)
                    .padding(start = 14.dp, end = 16.dp, top = 5.dp, bottom = 6.dp),
            )
        }
    }
}

@Composable
private fun HeroCaption(
    hero: HeroLine,
    modifier: Modifier = Modifier,
) {
    val product = hero.product
    Column(modifier = modifier.padding(horizontal = 4.dp)) {
        Text(
            text = product.name,
            color = AppColors.Ink,
            fontSize = 18.sp,
            lineHeight = 22.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
        Text(
            text = Money(product.priceIsk).format(),
            fontFamily = AppFonts.Geist,
            fontSize = 18.sp,
            lineHeight = 20.sp,
            fontWeight = FontWeight.Medium,
            color = AppColors.Bronze,
        )
    }
}
