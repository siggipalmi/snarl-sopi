package isl.snudursopi.vending.ui.screens.attract

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import isl.snudursopi.vending.domain.IdleCard
import isl.snudursopi.vending.domain.IdleCardType
import isl.snudursopi.vending.domain.IdleItem
import isl.snudursopi.vending.domain.Language
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts
import kotlinx.coroutines.delay
import java.text.NumberFormat
import java.util.Locale

/**
 * Full-screen attract/idle deal loop. Renders the backend-resolved [cards] in
 * order and cycles them every [rotationSeconds]. Tapping anywhere exits into
 * the shopping UI (via [onExit]). The kiosk does no filtering or discount math
 * — see the backend render-spec memo.
 */
@Composable
fun AttractScreen(
    cards: List<IdleCard>,
    rotationSeconds: Int,
    language: Language,
    onExit: () -> Unit,
) {
    // Caller only routes here when cards are non-empty, but guard anyway.
    if (cards.isEmpty()) {
        PlainAttract(onExit = onExit, language = language)
        return
    }

    var index by remember(cards.size) { mutableStateOf(0) }
    LaunchedEffect(cards.size, rotationSeconds) {
        if (cards.size <= 1) return@LaunchedEffect
        while (true) {
            delay(rotationSeconds.coerceAtLeast(2) * 1000L)
            index = (index + 1) % cards.size
        }
    }
    val card = cards.getOrNull(index) ?: cards.first()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(gradientFor(card.type))
            .noRippleTap(onExit),
        contentAlignment = Alignment.Center,
    ) {
        Crossfade(targetState = card, animationSpec = tween(450), label = "attract-card") { c ->
            CardContent(card = c, language = language)
        }

        // Progress dots (only when more than one card).
        if (cards.size > 1) {
            Row(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 28.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                cards.indices.forEach { i ->
                    Box(
                        modifier = Modifier
                            .size(if (i == index) 10.dp else 7.dp)
                            .clip(CircleShape)
                            .background(if (i == index) AppColors.Cream else AppColors.Cream.copy(alpha = 0.4f)),
                    )
                }
            }
        }
    }
}

// ============ card content router ============

@Composable
private fun CardContent(card: IdleCard, language: Language) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 32.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        TagLabel(text = tagFor(card, language))
        Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) {
            when (card.type) {
                IdleCardType.Expiry -> ExpiryHero(card, language)
                IdleCardType.Markdown -> MarkdownHero(card, language)
                IdleCardType.Multibuy -> MultibuyHero(card, language)
                IdleCardType.Combo -> ComboHero(card, language)
                IdleCardType.Unknown -> {}
            }
        }
        FooterLabel(text = str(language, "snertu til að versla", "touch to shop"))
    }
}

// ============ heroes ============

@Composable
private fun ExpiryHero(card: IdleCard, language: Language) {
    val shown = card.items.take(4)
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        if (shown.size <= 1) {
            val item = shown.firstOrNull()
            ProductTile(item, big = true)
            Spacer(Modifier.height(20.dp))
            BigNumber("−${item?.percent ?: card.discount.maxPercent ?: 0}%")
            Spacer(Modifier.height(8.dp))
            ProductName(item?.name.orEmpty())
            Spacer(Modifier.height(12.dp))
            PriceRow(item?.priceIsk, item?.discountedPriceIsk)
        } else {
            BigNumber(str(language, "allt að −${card.discount.maxPercent ?: 0}%", "up to −${card.discount.maxPercent ?: 0}%"))
            Spacer(Modifier.height(20.dp))
            ThumbRow(shown)
            MoreLine(card, shown.size, language)
        }
    }
}

@Composable
private fun MarkdownHero(card: IdleCard, language: Language) {
    val shown = card.items.take(4)
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        if (shown.size <= 1) {
            val item = shown.firstOrNull()
            ProductTile(item, big = true)
            Spacer(Modifier.height(20.dp))
            BigNumber(markdownBadge(card))
            Spacer(Modifier.height(8.dp))
            ProductName(item?.name.orEmpty())
            Spacer(Modifier.height(12.dp))
            PriceRow(item?.priceIsk, item?.discountedPriceIsk)
        } else {
            BigNumber(markdownBadge(card))
            Spacer(Modifier.height(20.dp))
            ThumbRow(shown)
            MoreLine(card, shown.size, language)
        }
    }
}

@Composable
private fun MultibuyHero(card: IdleCard, language: Language) {
    val shown = card.items.take(3)
    val qty = card.discount.qty ?: 0
    val total = card.discount.totalKr ?: 0
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        if (shown.size <= 1) {
            val item = shown.firstOrNull()
            ProductTile(item, big = true)
            Spacer(Modifier.height(16.dp))
            ProductName(item?.name.orEmpty())
            Spacer(Modifier.height(16.dp))
            BigNumber(str(language, "$qty fyrir ${kr(total)}", "$qty for ${kr(total)}"))
        } else {
            ThumbRow(shown)
            Spacer(Modifier.height(20.dp))
            BigNumber(str(language, "$qty fyrir ${kr(total)}", "$qty for ${kr(total)}"))
            MoreLine(card, shown.size, language)
        }
    }
}

@Composable
private fun ComboHero(card: IdleCard, language: Language) {
    val reward = when (card.discount.mode) {
        "percent" -> "−${card.discount.value ?: 0}%"
        else -> kr(card.discount.value ?: 0)  // "price" (default)
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            card.groups.forEachIndexed { i, group ->
                if (i > 0) {
                    Text(
                        text = "+",
                        color = AppColors.Cream,
                        fontFamily = AppFonts.Cormorant,
                        fontStyle = FontStyle.Italic,
                        fontSize = 80.sp,
                    )
                }
                ProductTile(group.firstOrNull(), big = false)
            }
        }
        Spacer(Modifier.height(24.dp))
        BigNumber(reward)
    }
}

// ============ shared pieces ============

@Composable
private fun ProductTile(item: IdleItem?, big: Boolean) {
    val side = if (big) 440.dp else 180.dp
    Box(
        modifier = Modifier
            .size(side)
            .clip(RoundedCornerShape(20.dp))
            .background(AppColors.White),
        contentAlignment = Alignment.Center,
    ) {
        val url = item?.imgUrl
        if (url != null) {
            AsyncImage(
                model = ImageRequest.Builder(LocalContext.current).data(url).crossfade(true).build(),
                contentDescription = item.name,
                contentScale = ContentScale.Fit,  // show the WHOLE product, never crop
                modifier = Modifier.fillMaxSize().padding(14.dp),
            )
        } else {
            // No image → name on the neutral tile.
            Text(
                text = item?.name.orEmpty(),
                color = AppColors.Ink,
                fontFamily = AppFonts.Geist,
                fontSize = 28.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(12.dp),
            )
        }
    }
}

@Composable
private fun ThumbRow(items: List<IdleItem>) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        items.forEach { ProductTile(it, big = false) }
    }
}

@Composable
private fun MoreLine(card: IdleCard, shownCount: Int, language: Language) {
    val extra = card.itemCount - shownCount
    if (extra > 0) {
        Spacer(Modifier.height(14.dp))
        Text(
            text = str(language, "+$extra fleiri vörur", "+$extra more items"),
            color = AppColors.Cream.copy(alpha = 0.85f),
            fontFamily = AppFonts.Geist,
            fontSize = 28.sp,
        )
    }
}

@Composable
private fun BigNumber(text: String) {
    Text(
        text = text,
        color = AppColors.Cream,
        fontFamily = AppFonts.Cormorant,
        fontStyle = FontStyle.Italic,
        fontWeight = FontWeight.Medium,
        fontSize = 120.sp,
        textAlign = TextAlign.Center,
    )
}

@Composable
private fun ProductName(name: String) {
    if (name.isBlank()) return
    Text(
        text = name,
        color = AppColors.Cream,
        fontFamily = AppFonts.Geist,
        fontWeight = FontWeight.Medium,
        fontSize = 44.sp,
        textAlign = TextAlign.Center,
    )
}

@Composable
private fun PriceRow(priceIsk: Int?, discountedPriceIsk: Int?) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (priceIsk != null && discountedPriceIsk != null && discountedPriceIsk != priceIsk) {
            Text(
                text = kr(priceIsk),
                color = AppColors.Cream.copy(alpha = 0.6f),
                fontFamily = AppFonts.Geist,
                fontSize = 38.sp,
                textDecoration = TextDecoration.LineThrough,
            )
            Text(
                text = kr(discountedPriceIsk),
                color = AppColors.Cream,
                fontFamily = AppFonts.Geist,
                fontWeight = FontWeight.Medium,
                fontSize = 52.sp,
            )
        } else {
            val p = discountedPriceIsk ?: priceIsk
            if (p != null) {
                Text(
                    text = kr(p),
                    color = AppColors.Cream,
                    fontFamily = AppFonts.Geist,
                    fontWeight = FontWeight.Medium,
                    fontSize = 52.sp,
                )
            }
        }
    }
}

@Composable
private fun TagLabel(text: String) {
    Text(
        text = text.uppercase(),
        color = AppColors.Cream.copy(alpha = 0.85f),
        fontFamily = FontFamily.Monospace,
        fontSize = 24.sp,
        letterSpacing = 2.sp,
    )
}

@Composable
private fun FooterLabel(text: String) {
    Text(
        text = text.uppercase(),
        color = AppColors.Cream.copy(alpha = 0.7f),
        fontFamily = FontFamily.Monospace,
        fontSize = 22.sp,
        letterSpacing = 2.sp,
    )
}

@Composable
private fun PlainAttract(onExit: () -> Unit, language: Language) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(gradientFor(IdleCardType.Markdown))
            .noRippleTap(onExit),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = "snarl & sopi",
                color = AppColors.Cream,
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 52.sp,
            )
            Spacer(Modifier.height(20.dp))
            FooterLabel(text = str(language, "snertu til að versla", "touch to shop"))
        }
    }
}

// ============ helpers ============

private fun Modifier.noRippleTap(onTap: () -> Unit): Modifier = this.composed {
    val interaction = remember { MutableInteractionSource() }
    this.clickable(interactionSource = interaction, indication = null) { onTap() }
}

private fun gradientFor(type: IdleCardType): Brush = when (type) {
    IdleCardType.Multibuy -> Brush.verticalGradient(listOf(Color(0xFF4A6B2E), Color(0xFF2C4019)))
    IdleCardType.Combo -> Brush.verticalGradient(listOf(Color(0xFF5B4A7A), Color(0xFF332649)))
    else -> Brush.verticalGradient(listOf(Color(0xFF8B6B3E), Color(0xFF5A4427)))  // expiry + markdown
}

private fun markdownBadge(card: IdleCard): String = when (card.discount.kind) {
    "percent" -> "−${card.discount.value ?: 0}%"
    "fixed" -> "−${kr(card.discount.value ?: 0)}"
    "price" -> kr(card.discount.value ?: 0)
    else -> "−${card.discount.value ?: 0}%"
}

private fun tagFor(card: IdleCard, language: Language): String = when (card.type) {
    IdleCardType.Expiry -> str(language, "Síðasti söludagur", "Last sale day")
    IdleCardType.Combo -> str(language, "Tilboð", "Combo")
    else -> str(language, "Tilboð", "Offer")
}

/** Icelandic-grouped price with the "kr. " prefix, e.g. kr. 1.290. */
private fun kr(n: Int): String {
    val grouped = NumberFormat.getInstance(Locale("is", "IS")).format(n.toLong())
    return "kr. $grouped"
}

private fun str(language: Language, ice: String, eng: String): String =
    if (language == Language.English) eng else ice
