package isl.snudursopi.fridge.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import isl.snudursopi.fridge.R
import isl.snudursopi.fridge.domain.Language
import isl.snudursopi.fridge.ui.state.FridgeUiState
import isl.snudursopi.fridge.ui.state.RestockCell
import isl.snudursopi.fridge.ui.state.RestockCellState
import isl.snudursopi.fridge.ui.theme.AppColors
import isl.snudursopi.fridge.ui.theme.AppFonts
import isl.snudursopi.fridge.ui.util.localized

/**
 * The restock screen.
 *
 * *** A REFERENCE DISPLAY, NOT A TOOL. The whole restocking flow runs from the
 * backend — placement and the door both — so there is deliberately no PIN, no
 * buttons and no on-screen "done". It has exactly two jobs: tell anyone walking
 * past that the machine is being refilled, and show the operator WHAT GOES
 * WHERE. Placement is the primary information; the live figure from the scales
 * is secondary confirmation.
 *
 * Only ONE door opens at a time during restocking, so the grid always shows a
 * single cabinet's sixteen baskets, labelled with its letter. Same layout on a
 * single or a double — bigger cells, and the operator can't fill the wrong side.
 */
@Composable
fun RestockScreen(state: FridgeUiState) {
    Column(Modifier.fillMaxSize()) {
        Header(state)
        Spacer(Modifier.height(20.dp))
        Box(Modifier.weight(1f).fillMaxWidth()) {
            Grid(state.language, state.restockCells)
        }
        Spacer(Modifier.height(14.dp))
        Text(
            localized(state.language, R.string.restock_footer),
            fontFamily = AppFonts.Geist,
            fontSize = 15.sp,
            color = AppColors.Muted,
        )
    }
}

@Composable
private fun Header(state: FridgeUiState) {
    val letter = if (state.restockCabinet == 2) "B" else "A"
    Row(verticalAlignment = Alignment.CenterVertically) {
        PulsingDot()
        Spacer(Modifier.width(18.dp))
        Column(Modifier.weight(1f)) {
            Text(
                localized(state.language, R.string.restock_title),
                fontFamily = AppFonts.Cormorant,
                fontStyle = FontStyle.Italic,
                fontWeight = FontWeight.SemiBold,
                fontSize = 56.sp,
                color = AppColors.Ink,
            )
            // Naming the door in bronze is the point: on a double, filling the
            // wrong side is the easy mistake and it's silent when it happens.
            Text(
                localized(state.language, R.string.restock_door_open, letter),
                fontFamily = AppFonts.Geist,
                fontSize = 20.sp,
                color = AppColors.Bronze,
            )
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(
                localized(state.language, R.string.restock_no_charging),
                fontFamily = AppFonts.Geist,
                fontSize = 17.sp,
                color = AppColors.MutedSoft,
            )
            if (state.machineLabel.isNotBlank()) {
                Text(
                    localized(state.language, R.string.restock_machine, state.machineLabel),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 15.sp,
                    color = AppColors.Muted,
                )
            }
        }
    }
}

/** A slow pulse, so a glance from across the room reads "in progress". */
@Composable
private fun PulsingDot() {
    val transition = rememberInfiniteTransition(label = "restock")
    val a by transition.animateFloat(
        initialValue = 0.25f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1100), RepeatMode.Reverse),
        label = "pulse",
    )
    Box(
        Modifier
            .size(22.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(AppColors.Bronze.copy(alpha = a)),
    )
}

@Composable
private fun Grid(language: Language, cells: List<RestockCell>) {
    if (cells.isEmpty()) return
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val cellW = (maxWidth - GAP * 3) / 4
        val cellH = (maxHeight - GAP * 3) / 4
        Column(verticalArrangement = Arrangement.spacedBy(GAP)) {
            cells.chunked(4).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(GAP)) {
                    row.forEach { cell -> Cell(language, cell, cellW, cellH) }
                }
            }
        }
    }
}

@Composable
private fun Cell(
    language: Language,
    cell: RestockCell,
    w: androidx.compose.ui.unit.Dp,
    h: androidx.compose.ui.unit.Dp,
) {
    // Each state gets its own border and weight, so the three things an operator
    // must notice are separable at a glance rather than by reading.
    val border: Color = when (cell.state) {
        RestockCellState.FAULT -> AppColors.Alert
        RestockCellState.EMPTY -> AppColors.Clay
        RestockCellState.DISABLED -> AppColors.Line
        RestockCellState.STOCKED -> AppColors.Line
    }
    val faded = cell.state == RestockCellState.DISABLED

    Column(
        Modifier
            .width(w)
            .height(h)
            .clip(RoundedCornerShape(12.dp))
            .background(if (cell.state == RestockCellState.FAULT) AppColors.Alert.copy(alpha = 0.06f) else AppColors.White)
            .border(if (cell.state == RestockCellState.FAULT) 2.dp else 1.dp, border, RoundedCornerShape(12.dp))
            .padding(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                cell.label,
                fontFamily = FontFamily.Monospace,
                fontSize = 15.sp,
                color = if (faded) AppColors.Clay else AppColors.Bronze,
            )
            Spacer(Modifier.weight(1f))
            // The right-hand figure is what the SCALES see now — deliberately
            // secondary to placement, but it's how an operator confirms a basket
            // actually registered what they put in it.
            when (cell.state) {
                RestockCellState.FAULT -> Text(
                    "!",
                    fontFamily = AppFonts.Geist,
                    fontWeight = FontWeight.Medium,
                    fontSize = 22.sp,
                    color = AppColors.Alert,
                )
                RestockCellState.DISABLED -> Unit
                else -> Text(
                    "${cell.units ?: 0}",
                    fontFamily = AppFonts.Geist,
                    fontWeight = FontWeight.Medium,
                    fontSize = 26.sp,
                    color = if (cell.state == RestockCellState.EMPTY) AppColors.Clay else AppColors.Ink,
                )
            }
        }

        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            if (cell.imageUrl != null && !faded) {
                AsyncImage(
                    model = cell.imageUrl,
                    contentDescription = cell.name,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().padding(4.dp),
                )
            }
        }

        Text(
            when (cell.state) {
                RestockCellState.DISABLED -> localized(language, R.string.restock_disabled)
                RestockCellState.FAULT -> localized(language, R.string.restock_sensor)
                RestockCellState.EMPTY -> localized(language, R.string.restock_empty)
                RestockCellState.STOCKED -> cell.name
            },
            fontFamily = AppFonts.Geist,
            fontSize = 14.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            color = when (cell.state) {
                RestockCellState.STOCKED -> AppColors.Ink
                RestockCellState.FAULT -> AppColors.Alert
                else -> AppColors.Muted
            },
        )
        if (cell.grams != null && cell.state != RestockCellState.DISABLED) {
            Text(
                "${cell.grams} g",
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                color = AppColors.MutedSoft,
            )
        }
    }
}

private val GAP = 12.dp
