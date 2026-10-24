package isl.snudursopi.vending.ui.screens.payment

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import isl.snudursopi.vending.R
import isl.snudursopi.vending.domain.Basket
import isl.snudursopi.vending.domain.BasketLine
import isl.snudursopi.vending.domain.CartQuote
import isl.snudursopi.vending.domain.ComboNearMiss
import isl.snudursopi.vending.domain.Product
import isl.snudursopi.vending.domain.QuoteLine
import isl.snudursopi.vending.domain.ConnectionState
import isl.snudursopi.vending.domain.Language
import isl.snudursopi.vending.domain.Money
import isl.snudursopi.vending.ui.components.StatusBar
import isl.snudursopi.vending.ui.state.PaymentPhase
import isl.snudursopi.vending.ui.theme.AppColors
import isl.snudursopi.vending.ui.theme.AppFonts
import isl.snudursopi.vending.ui.util.localized

/**
 * Merged order + live-reader screen (Stage 3b). There is NO "pay" button —
 * arriving here means the Nayax is already (being) armed with the current
 * total. The customer either taps their card, or edits the order (each edit
 * debounces a cancel + re-arm). The bottom zone is driven by [phase].
 */
@Composable
fun PaymentScreen(
    basket: Basket,
    phase: PaymentPhase,
    brand: String,
    currentTime: String,
    connectionState: ConnectionState,
    language: Language,
    quote: CartQuote? = null,
    catalog: List<Product> = emptyList(),
    onCancel: () -> Unit,
    onAddMore: () -> Unit,
    onIncItem: (String) -> Unit,
    onDecItem: (String) -> Unit,
    onAddCandidate: (String) -> Unit = {},
    onClockLongPress: () -> Unit = {},
) {
    if (phase == PaymentPhase.ReaderDown) {
        ReaderDownScreen(brand, currentTime, connectionState, language, onClockLongPress)
        return
    }

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

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 22.dp, vertical = 14.dp),
        ) {
            if (phase == PaymentPhase.Declined) {
                DeclinedBanner(language)
                Spacer(Modifier.height(12.dp))
            }

            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f, fill = false),
            ) {
                items(basket.lines, key = { it.product.id }) { line ->
                    OrderRow(
                        line = line,
                        quoteLine = quote?.lines?.firstOrNull { it.goodsId == line.product.id },
                        onInc = { onIncItem(line.product.id) },
                        onDec = { onDecItem(line.product.id) },
                    )
                }
            }

            // Combo/multibuy near-miss nudge: one item short of a deal → offer to
            // complete it, one tap. Hidden at MAX_ITEMS or if no in-stock candidates
            // resolve. Only the first hint is shown to keep the checkout calm.
            val nudge = quote?.nearMiss?.firstOrNull()
            if (nudge != null && basket.itemCount < Basket.MAX_ITEMS) {
                val candidates = nudge.candidateGoodsIds
                    .mapNotNull { id -> catalog.firstOrNull { it.id == id } }
                    .filter { it.stock > 0 }
                    .take(3)
                if (candidates.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    ComboNudgeCard(
                        nudge = nudge,
                        candidates = candidates,
                        language = language,
                        onAddCandidate = onAddCandidate,
                    )
                }
            }

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .border(1.dp, AppColors.Clay, RoundedCornerShape(12.dp))
                    .clickable(onClick = onAddMore)
                    .padding(vertical = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = localized(language, R.string.payment_add_item),
                    fontFamily = AppFonts.Geist,
                    fontSize = 18.sp,
                    color = AppColors.Bronze,
                )
            }

            Spacer(Modifier.height(14.dp))

            val displayTotal = quote?.let { Money(it.totalIsk) } ?: basket.total
            val saved = quote?.discountIsk ?: 0

            if (saved > 0) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.Bottom,
                ) {
                    Text(
                        text = if (language == Language.English) "You save" else "Þú sparar",
                        fontFamily = AppFonts.Geist,
                        fontSize = 16.sp,
                        color = AppColors.Alert,
                    )
                    Text(
                        text = Money(saved).format(),
                        fontFamily = AppFonts.Geist,
                        fontWeight = FontWeight.Medium,
                        fontSize = 18.sp,
                        color = AppColors.Alert,
                    )
                }
                Spacer(Modifier.height(4.dp))
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Bottom,
            ) {
                Text(
                    text = localized(language, R.string.basket_total_label),
                    fontFamily = AppFonts.Geist,
                    fontSize = 16.sp,
                    color = AppColors.Muted,
                )
                Text(
                    text = displayTotal.format(),
                    fontFamily = AppFonts.Cormorant,
                    fontStyle = FontStyle.Italic,
                    fontSize = 40.sp,
                    color = AppColors.Ink,
                )
            }

            Spacer(Modifier.weight(1f))

            ReaderZone(phase = phase, totalLabel = displayTotal.format(), language = language)

            Spacer(Modifier.height(8.dp))

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onCancel)
                    .padding(vertical = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = localized(language, R.string.payment_cancel),
                    fontFamily = AppFonts.Geist,
                    fontSize = 16.sp,
                    color = AppColors.Muted,
                )
            }
        }
    }
}

@Composable
private fun ComboNudgeCard(
    nudge: ComboNearMiss,
    candidates: List<Product>,
    language: Language,
    onAddCandidate: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(AppColors.Alert.copy(alpha = 0.05f))
            .border(1.dp, AppColors.Alert.copy(alpha = 0.35f), RoundedCornerShape(12.dp))
            .padding(horizontal = 11.dp, vertical = 11.dp),
    ) {
        // Eyebrow: the deal name (e.g. "snarl combo")
        Text(
            text = nudge.label.ifBlank { localized(language, R.string.combo_nudge_eyebrow) },
            fontFamily = AppFonts.Geist,
            fontWeight = FontWeight.Medium,
            fontSize = 11.sp,
            color = AppColors.Alert,
        )
        Spacer(Modifier.height(3.dp))
        // Headline: "bættu við einni vöru fyrir 150 kr"
        Text(
            text = localized(language, R.string.combo_nudge_add_for) + " " +
                Money(nudge.addOnPriceIsk).format(),
            fontFamily = AppFonts.Geist,
            fontSize = 15.sp,
            color = AppColors.Ink,
        )
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            candidates.forEach { product ->
                Box(modifier = Modifier.weight(1f)) {
                    CandidateChip(product = product, onClick = { onAddCandidate(product.id) })
                }
            }
        }
    }
}

@Composable
private fun CandidateChip(product: Product, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(62.dp)
                .clip(RoundedCornerShape(9.dp))
                .background(product.category.tileColor()),
            contentAlignment = Alignment.Center,
        ) {
            if (!product.imagePath.isNullOrBlank()) {
                AsyncImage(
                    model = product.imagePath,
                    contentDescription = product.name,
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(6.dp),
                    contentScale = ContentScale.Fit,
                )
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(
            text = product.name,
            fontFamily = AppFonts.Geist,
            fontSize = 12.sp,
            color = AppColors.Ink,
            maxLines = 1,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun OrderRow(line: BasketLine, quoteLine: QuoteLine?, onInc: () -> Unit, onDec: () -> Unit) {
    val hasDiscount = quoteLine != null && quoteLine.lineDiscountIsk > 0
    val dealName = quoteLine?.appliedDealName?.takeIf { it.isNotBlank() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = line.product.name,
                fontFamily = AppFonts.Geist,
                fontSize = 20.sp,
                color = AppColors.Ink,
            )
            Text(
                text = if (hasDiscount && dealName != null) dealName else "hólf ${line.product.slot}",
                fontFamily = AppFonts.Geist,
                fontSize = 13.sp,
                fontWeight = if (hasDiscount && dealName != null) FontWeight.Medium else FontWeight.Normal,
                color = if (hasDiscount && dealName != null) AppColors.Alert else AppColors.Muted,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            StepButton("−", onDec)
            Text(
                text = line.quantity.toString(),
                fontFamily = AppFonts.Geist,
                fontSize = 20.sp,
                color = AppColors.Ink,
                modifier = Modifier.padding(horizontal = 14.dp),
            )
            StepButton("+", onInc)
        }
        Column(
            modifier = Modifier.padding(start = 14.dp),
            horizontalAlignment = Alignment.End,
        ) {
            if (hasDiscount) {
                Text(
                    text = Money(quoteLine!!.lineTotalIsk).format(),
                    fontFamily = AppFonts.Geist,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Medium,
                    color = AppColors.Ink,
                    textAlign = TextAlign.End,
                )
                Text(
                    text = Money(quoteLine.lineBaseIsk).format(),
                    fontFamily = AppFonts.Geist,
                    fontSize = 14.sp,
                    color = AppColors.Muted,
                    textDecoration = TextDecoration.LineThrough,
                    textAlign = TextAlign.End,
                )
            } else {
                Text(
                    text = Money(line.product.priceIsk * line.quantity).format(),
                    fontFamily = AppFonts.Geist,
                    fontSize = 20.sp,
                    color = AppColors.InkSoft,
                    textAlign = TextAlign.End,
                )
            }
        }
    }
}

@Composable
private fun StepButton(symbol: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(34.dp)
            .border(1.dp, AppColors.Clay, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(symbol, fontFamily = AppFonts.Geist, fontSize = 22.sp, color = AppColors.Bronze)
    }
}

@Composable
private fun ReaderZone(phase: PaymentPhase, totalLabel: String, language: Language) {
    val busy = phase == PaymentPhase.Arming || phase == PaymentPhase.Dispensing
    val msg = when (phase) {
        PaymentPhase.Arming -> localized(language, R.string.pay_arming)
        PaymentPhase.Dispensing -> localized(language, R.string.pay_dispensing)
        else -> localized(language, R.string.pay_reader_live)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, AppColors.Bronze, RoundedCornerShape(14.dp))
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (busy) Spinner(28.dp) else PulsingReaderDot()
        Column {
            Text(
                text = msg,
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 20.sp,
                color = AppColors.InkSoft,
            )
            if (phase == PaymentPhase.AwaitingCard || phase == PaymentPhase.Declined) {
                Text(
                    text = totalLabel,
                    fontFamily = AppFonts.Geist,
                    fontSize = 15.sp,
                    color = AppColors.Muted,
                )
            }
        }
    }
}

@Composable
private fun PulsingReaderDot() {
    val t = rememberInfiniteTransition(label = "pulse")
    val a by t.animateFloat(
        initialValue = 1f,
        targetValue = 0.4f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse),
        label = "a",
    )
    Box(
        modifier = Modifier
            .size(40.dp)
            .alpha(a)
            .border(2.dp, AppColors.Bronze, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text("⊙", fontSize = 20.sp, color = AppColors.Bronze)
    }
}

@Composable
private fun Spinner(sz: androidx.compose.ui.unit.Dp) {
    val t = rememberInfiniteTransition(label = "spin")
    val r by t.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing)),
        label = "r",
    )
    Box(
        modifier = Modifier
            .size(sz)
            .graphicsLayer { rotationZ = r }
            .border(3.dp, AppColors.Line, CircleShape),
    )
}

@Composable
private fun DeclinedBanner(language: Language) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(AppColors.CreamShadow, RoundedCornerShape(12.dp))
            .border(1.dp, AppColors.Alert, RoundedCornerShape(12.dp))
            .padding(12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = localized(language, R.string.pay_declined),
            fontFamily = AppFonts.Geist,
            fontSize = 14.sp,
            color = AppColors.Alert,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun ReaderDownScreen(
    brand: String,
    currentTime: String,
    connectionState: ConnectionState,
    language: Language,
    onClockLongPress: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().background(AppColors.Cream)) {
        StatusBar(brand = brand, time = currentTime, connectionState = connectionState, onClockLongPress = onClockLongPress)
        Column(
            modifier = Modifier.fillMaxSize().padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = localized(language, R.string.pay_reader_down_title),
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontSize = 26.sp,
                color = AppColors.Alert,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(14.dp))
            Text(
                text = localized(language, R.string.pay_reader_down_body),
                fontFamily = AppFonts.Geist,
                fontSize = 15.sp,
                color = AppColors.InkSoft,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(20.dp))
            Spinner(34.dp)
            Spacer(Modifier.height(20.dp))
            Text(
                text = localized(language, R.string.pay_reader_down_note),
                fontFamily = AppFonts.Geist,
                fontSize = 12.sp,
                color = AppColors.Muted,
                textAlign = TextAlign.Center,
            )
        }
    }
}
