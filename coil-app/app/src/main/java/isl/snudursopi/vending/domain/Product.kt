package isl.snudursopi.vending.domain

import androidx.compose.ui.graphics.Color
import kotlinx.serialization.Serializable

/**
 * A product available in the machine.
 *
 * Note on slots: a single product may live in multiple physical slots
 * (e.g. the same chocolate bar in slots A1, A2, A3 to increase available
 * stock). [slots] is the full list; [slot] is just the first one (the
 * primary, displayed in detail screens). When dispensing, the hardware
 * adapter picks the next in-stock slot from [slots].
 */
@Serializable
data class Product(
    val id: String,
    val slot: String,                          // friendly internal slot, e.g. "A35"
    val slots: List<String> = listOf(slot),    // all slots holding this product
    val name: String,
    val subtitle: String? = null,
    val priceIsk: Int,
    val category: Category,
    val imagePath: String? = null,
    /**
     * True when [imagePath] has a baked-in (non-transparent) background — set by
     * the backend's `images` block, which auto-detects it. False for cut-outs with
     * a transparent background, and the default for un-migrated Weimi images.
     * Drives the tile's two-mode framing.
     */
    val imageHasBackground: Boolean = false,
    val heroImagePath: String? = null,         // optional larger image for hero tiles
    val stock: Int = 0,                        // sum across all slots
    val displayOrder: Int = Int.MAX_VALUE,
    val hidden: Boolean = false,
    val featured: Boolean = false,
    val hideWhenEmpty: Boolean = true,
) {
    val inStock: Boolean get() = stock > 0

    /** Single source of truth for "should the customer see this?" */
    val isVisibleToCustomer: Boolean
        get() = when {
            hidden -> false
            hideWhenEmpty && !inStock -> false
            else -> true
        }
}

/** Product categories drive tile color and admin grouping. */
@Serializable
enum class Category(val displayName: String) {
    Drinks("drykkir"),
    Snacks("snakk"),
    Sweet("sætt"),
    Healthy("hollt"),
    Coffee("kaffi"),
    Other("annað");

    /** Pastel tile color for cards in this category. */
    fun tileColor(): Color = when (this) {
        Drinks -> Color(0xFFDFE9F4)
        Snacks -> Color(0xFFF4E6D4)
        Sweet -> Color(0xFFEEDDEC)
        Healthy -> Color(0xFFDCEBDD)
        Coffee -> Color(0xFFE6D9CC)
        Other -> Color(0xFFEDEDEA)
    }
}

/**
 * Money in ISK. Internal storage is whole krónur as an Int (no decimals).
 */
@Serializable
data class Money(val amountIsk: Int) {
    operator fun plus(other: Money) = Money(amountIsk + other.amountIsk)
    operator fun times(qty: Int) = Money(amountIsk * qty)

    /** Format as "1.285 kr" with period thousands separator, no decimals. */
    fun format(): String = "${formatIskNumber(amountIsk)} kr"

    companion object {
        val Zero = Money(0)
        fun isk(kr: Int) = Money(kr)

        /** "1285" → "1.285", deterministic regardless of system locale. */
        fun formatIskNumber(n: Int): String {
            if (n == 0) return "0"
            val abs = kotlin.math.abs(n).toString()
            val grouped = abs.reversed().chunked(3).joinToString(".").reversed()
            return if (n < 0) "-$grouped" else grouped
        }
    }
}

/**
 * Customer's shopping basket. Capped at 5 items per session.
 */
@Serializable
data class Basket(val lines: List<BasketLine> = emptyList()) {
    val itemCount: Int get() = lines.sumOf { it.quantity }
    val total: Money get() = Money(lines.sumOf { it.product.priceIsk * it.quantity })
    val isEmpty: Boolean get() = lines.isEmpty()

    fun add(product: Product): Basket {
        if (itemCount >= MAX_ITEMS) return this
        val existing = lines.indexOfFirst { it.product.id == product.id }
        return if (existing >= 0) {
            val updated = lines[existing].copy(quantity = lines[existing].quantity + 1)
            copy(lines = lines.toMutableList().also { it[existing] = updated })
        } else {
            copy(lines = lines + BasketLine(product, 1))
        }
    }

    fun remove(productId: String): Basket =
        copy(lines = lines.filterNot { it.product.id == productId })

    fun clear() = Basket()

    companion object {
        const val MAX_ITEMS = 5
    }
}

@Serializable
data class BasketLine(val product: Product, val quantity: Int)
