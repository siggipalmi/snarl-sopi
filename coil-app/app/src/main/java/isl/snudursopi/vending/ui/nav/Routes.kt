package isl.snudursopi.vending.ui.nav

object Routes {
    const val Browse = "browse"
    const val Attract = "attract"
    const val Detail = "detail/{productId}"
    const val Payment = "payment"
    const val Success = "success"
    const val ComplaintForm = "complaint/form"
    const val ComplaintConfirmation = "complaint/confirmation"

    /** Admin entry — long-press the clock on any screen lands here. */
    const val PinEntry = "admin/pin"
    /** Diagnostics dashboard — reached after successful PIN. */
    const val Diagnostics = "admin/diagnostics"
    /** Debug-only hardware test screen — reached from diagnostics in debug builds. */
    const val HardwareTest = "admin/hardware-test"

    fun detail(productId: String) = "detail/$productId"
}
