package isl.snudursopi.vending.domain

/**
 * A featured product resolved against the live catalog, ready to render
 * in the hero zone. The ViewModel builds this list by looking up each
 * FeaturedProduct's goodsId in the current catalog and skipping any that
 * are out of stock, hidden, or missing from the catalog.
 */
data class HeroLine(
    val product: Product,
    val tag: String,
)
