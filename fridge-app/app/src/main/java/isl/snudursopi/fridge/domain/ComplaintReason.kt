package isl.snudursopi.fridge.domain

import isl.snudursopi.fridge.R

/**
 * The six reasons the backend's enum accepts, in the order they appear on screen.
 *
 * *** THE WIRE CODES ARE ENFORCED SERVER-SIDE. A value not in this list is
 * rejected with a 400, so these strings must match the backend exactly — do not
 * "tidy" them.
 *
 * The last two arrived when this flow stopped being purely a wrong-charge form
 * and became the general "something is wrong" route: a customer standing at an
 * open fridge door is the person best placed to tell us the stock is off. They
 * are not really complaints — [EXPIRED_PRODUCT] and [COOLING_FAULT] end with
 * someone driving to the machine rather than with a refund decision — and the
 * backend alerts on them differently as a result (v5.94): a cooling fault raises
 * a critical alert on a SINGLE report, expired product at 2-in-24h, while the
 * original four keep the 3-in-24h calibration cluster.
 *
 * That asymmetry lives entirely on the backend. All we do is send the right code.
 */
enum class ComplaintReason(val wire: String, val labelRes: Int) {
    NOT_TAKEN("not_taken", R.string.complaint_reason_not_taken),
    WRONG_QUANTITY("wrong_quantity", R.string.complaint_reason_wrong_quantity),
    RETURNED_BUT_CHARGED("returned_but_charged", R.string.complaint_reason_returned),
    EXPIRED_PRODUCT("expired_product", R.string.complaint_reason_expired),
    COOLING_FAULT("cooling_fault", R.string.complaint_reason_cooling),
    OTHER("other", R.string.complaint_reason_other),
}
