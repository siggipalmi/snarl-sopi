package isl.snudursopi.fridge.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import isl.snudursopi.fridge.R
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.ui.state.CartTile
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import isl.snudursopi.fridge.ui.util.localized

/**
 * The cart, on both the shopping screen and the receipt.
 *
 * *** LEGAL REQUIREMENT: EVERY product taken must be shown. No truncation, no
 * "+3 more" — the customer has to be able to see what they're being charged for
 * even though they picked it up themselves. So the grid adapts by SHRINKING,
 * and past a certain count switches to a list rather than hiding anything.
 *
 * TILES ARE PORTRAIT AND SIZE-CAPPED. The first version used a fixed 4-column
 * grid, which on a 22" panel gave a two-item cart two 440dp-wide tiles with a
 * 96dp image — wide and low, and nothing like the shape of a can. Tiles now
 * take their width from the item count, capped, and the image is 3:4 so the
 * product stands up in it.
 */
@Composable
fun CartTiles(
    cart: List<CartTile>,
    language: Language,
    modifier: Modifier = Modifier,
) {
    if (cart.isEmpty()) return

    if (cart.size > LIST_THRESHOLD) {
        CartList(cart, language, modifier)
        return
    }

    BoxWithConstraints(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        // Columns follow the count rather than being fixed, so a small cart gets
        // big tiles instead of four thin ones.
        val columns = when {
            cart.size <= 4 -> cart.size
            cart.size <= 6 -> 3
            else -> 4
        }
        val rows = (cart.size + columns - 1) / columns

        // Constrain by BOTH axes. Width alone isn't enough: on a panel this wide
        // every count hit the cap, so twelve items became three rows of ~500dp
        // tiles in a ~600dp space and simply overflowed. A tile is roughly
        // TILE_TO_WIDTH times its width once the image and the two text lines
        // are counted, so the height budget sets its own ceiling.
        val byWidth = (maxWidth - GAP * (columns - 1)) / columns
        val byHeight = ((maxHeight - GAP * (rows - 1)) / rows) / TILE_TO_WIDTH
        val width = minOf(byWidth, byHeight).coerceIn(MIN_TILE, MAX_TILE)

        Column(
            verticalArrangement = Arrangement.spacedBy(GAP),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            cart.chunked(columns).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(GAP)) {
                    row.forEach { tile -> Tile(tile, language, width) }
                }
            }
        }
    }
}

@Composable
private fun Tile(tile: CartTile, language: Language, width: Dp) {
    // THE TRUST BEAT. The customer has waited a second or so since lifting the
    // item; a tile that simply exists doesn't tell them the machine noticed.
    // A bronze ring that flares and fades does. Keyed on quantity as well as
    // name, so taking a SECOND of something re-fires rather than sitting silent.
    val flash = remember(tile.name) { Animatable(0f) }
    LaunchedEffect(tile.name, tile.quantity) {
        flash.snapTo(1f)
        flash.animateTo(0f, tween(durationMillis = FLASH_MS))
    }
    val f = flash.value

    Column(
        Modifier
            .width(width)
            .graphicsLayer {
                // A touch of scale with the flash — it reads as the tile landing
                // rather than merely appearing.
                val s = 1f + 0.035f * f
                scaleX = s
                scaleY = s
            }
            .clip(RoundedCornerShape(14.dp))
            .background(AppColors.White)
            .border(
                width = (2.5f * f).dp,
                color = AppColors.Bronze.copy(alpha = f),
                shape = RoundedCornerShape(14.dp),
            ),
    ) {
        Box(Modifier.fillMaxWidth()) {
            if (tile.imageUrl != null) {
                AsyncImage(
                    model = tile.imageUrl,
                    contentDescription = tile.name,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(IMAGE_ASPECT)
                        .background(AppColors.CreamShadow)
                        .padding(12.dp),
                )
            } else {
                // No photo: set the name instead of showing a grey rectangle.
                // A typographic tile still identifies the product, which is the
                // whole job here.
                Box(
                    Modifier
                        .fillMaxWidth()
                        .aspectRatio(IMAGE_ASPECT)
                        .background(AppColors.CreamShadow)
                        .padding(16.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        tile.name,
                        fontFamily = AppFonts.Cormorant,
                        fontStyle = FontStyle.Italic,
                        fontSize = (width.value * 0.11f).sp,
                        lineHeight = (width.value * 0.13f).sp,
                        textAlign = TextAlign.Center,
                        color = AppColors.Muted,
                    )
                }
            }

            // Quantity as a MULTIPLIER, not duplicate tiles — two of the same
            // drink is one product bought twice, and the cart should read that way.
            if (tile.quantity > 1) {
                Box(
                    Modifier
                        .padding(10.dp)
                        .align(Alignment.TopEnd)
                        .clip(RoundedCornerShape(999.dp))
                        .background(AppColors.Bronze)
                        .padding(horizontal = 14.dp, vertical = 4.dp),
                ) {
                    Text(
                        localized(language, R.string.quantity_badge, tile.quantity),
                        fontFamily = AppFonts.Geist,
                        fontWeight = FontWeight.Medium,
                        fontSize = (width.value * 0.10f).sp,
                        color = AppColors.Cream,
                    )
                }
            }
        }

        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
            Text(
                tile.name,
                fontFamily = AppFonts.Geist,
                fontWeight = FontWeight.Medium,
                fontSize = (width.value * 0.075f).sp,
                lineHeight = (width.value * 0.095f).sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                color = AppColors.Ink,
            )
            Text(
                localized(language, R.string.amount_isk, tile.priceIsk * tile.quantity),
                fontFamily = AppFonts.Geist,
                fontSize = (width.value * 0.068f).sp,
                color = AppColors.MutedSoft,
            )
        }
    }
}

/**
 * The list form, for carts too big to tile legibly. Every line keeps its name,
 * quantity and price — which is what the legal requirement actually asks for.
 * Two columns so a big cart still fits without scrolling; the scroll is only a
 * safety valve for the extreme case of a double fridge with dozens of distinct
 * products.
 */
@Composable
private fun CartList(
    cart: List<CartTile>,
    language: Language,
    modifier: Modifier = Modifier,
) {
    val half = (cart.size + 1) / 2
    Row(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(40.dp),
    ) {
        listOf(cart.take(half), cart.drop(half)).forEach { column ->
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                column.forEach { tile -> ListRow(tile, language) }
            }
        }
    }
}

@Composable
private fun ListRow(tile: CartTile, language: Language) {
    val flash = remember(tile.name) { Animatable(0f) }
    LaunchedEffect(tile.name, tile.quantity) {
        flash.snapTo(1f)
        flash.animateTo(0f, tween(durationMillis = FLASH_MS))
    }
    val f = flash.value

    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(AppColors.White)
            .border((2f * f).dp, AppColors.Bronze.copy(alpha = f), RoundedCornerShape(10.dp))
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (tile.imageUrl != null) {
            AsyncImage(
                model = tile.imageUrl,
                contentDescription = tile.name,
                contentScale = ContentScale.Fit,
                modifier = Modifier.size(44.dp),
            )
        }
        Text(
            tile.name,
            fontFamily = AppFonts.Geist,
            fontWeight = FontWeight.Medium,
            fontSize = 20.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            color = AppColors.Ink,
            modifier = Modifier.weight(1f).padding(horizontal = 14.dp),
        )
        if (tile.quantity > 1) {
            Text(
                localized(language, R.string.quantity_badge, tile.quantity),
                fontFamily = AppFonts.Geist,
                fontWeight = FontWeight.Medium,
                fontSize = 20.sp,
                color = AppColors.Bronze,
                modifier = Modifier.padding(end = 14.dp),
            )
        }
        Text(
            localized(language, R.string.amount_isk, tile.priceIsk * tile.quantity),
            fontFamily = AppFonts.Geist,
            fontSize = 19.sp,
            color = AppColors.MutedSoft,
        )
    }
}

/** Products are cans and bottles — they stand up, so the tile should too. */
private const val IMAGE_ASPECT = 3f / 4f

/**
 * A tile's total height as a multiple of its width: the 4:3-tall image plus the
 * name and price beneath. Used to budget height so multi-row carts fit instead
 * of running off the bottom.
 */
private const val TILE_TO_WIDTH = 1.62f
/**
 * Past this many items, tiles stop fitting legibly and the list is genuinely
 * better. The signed-off mockup said tiles up to 12, but that was drawn without
 * real dimensions: on the actual panel, 12 tiles want three rows of ~490dp in a
 * ~600dp cart area, and shrinking them to fit leaves a name at ~11sp — smaller
 * than the list's 20sp. Most sessions are one to three items anyway, so tiles
 * are optimised for those and anything larger gets a readable list.
 */
private const val LIST_THRESHOLD = 6
private const val FLASH_MS = 1100
private val GAP = 18.dp
private val MIN_TILE = 150.dp
private val MAX_TILE = 300.dp
