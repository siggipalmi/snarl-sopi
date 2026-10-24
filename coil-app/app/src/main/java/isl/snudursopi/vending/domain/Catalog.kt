package isl.snudursopi.vending.domain

/** Customer-facing display: visible only, sorted featured-first, then displayOrder, then name. */
fun List<Product>.forCustomerDisplay(disabledAisles: Set<String> = emptySet()): List<Product> =
    asSequence()
        .filter { it.isVisibleToCustomer }
        .filterNot { it.slot.uppercase() in disabledAisles }
        .sortedWith(
            compareByDescending<Product> { it.featured }
                .thenBy { it.displayOrder }
                .thenBy { it.name }
        )
        .toList()

/**
 * Customer-facing display honoring an operator-defined [gridOrder] (a list of
 * goodsIds == Product.id). Sold-out/hidden products are filtered exactly as in
 * [forCustomerDisplay]. Products listed in [gridOrder] come first, in that
 * order; any product NOT listed (newly loaded, or an un-arranged machine) falls
 * to the end in the default order. An empty [gridOrder] is identical to
 * [forCustomerDisplay] — safe to ship before any operator arranges a machine.
 */
fun List<Product>.forCustomerDisplay(
    gridOrder: List<String>,
    disabledAisles: Set<String> = emptySet(),
): List<Product> {
    if (gridOrder.isEmpty()) return forCustomerDisplay(disabledAisles)
    val rank = gridOrder.withIndex().associate { (i, id) -> id to i }
    val unlistedBase = gridOrder.size  // unlisted products sort after all listed
    return asSequence()
        .filter { it.isVisibleToCustomer }
        .filterNot { it.slot.uppercase() in disabledAisles }
        .sortedWith(
            // Listed products by their gridOrder index; unlisted products keep
            // the default order (featured, displayOrder, name) but after listed.
            compareBy<Product> { rank[it.id] ?: unlistedBase }
                .thenByDescending { it.featured }
                .thenBy { it.displayOrder }
                .thenBy { it.name }
        )
        .toList()
}

/** Admin view: shows everything including hidden + sold out. */
fun List<Product>.forAdminDisplay(): List<Product> =
    sortedWith(
        compareByDescending<Product> { it.featured }
            .thenBy { it.displayOrder }
            .thenBy { it.name }
    )

/** Renumber displayOrder in steps of 10 (after a drag reorder). */
fun List<Product>.withRenumberedDisplayOrder(): List<Product> =
    mapIndexed { i, p -> p.copy(displayOrder = (i + 1) * 10) }
