package isl.snudursopi.fridge.ui.state

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import isl.snudursopi.fridge.data.backend.ComplaintClient
import isl.snudursopi.fridge.hardware.FridgeHardwareController

/** Supplies the [FridgeViewModel] with its hardware + payment collaborators. */
class FridgeViewModelFactory(
    private val hardware: FridgeHardwareController,
    private val payment: PaymentGateway,
    /** Resolved lazily: the backend is not provisioned when this is built. */
    private val complaintClient: () -> ComplaintClient? = { null },
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        return FridgeViewModel(hardware, payment, complaintClient = complaintClient) as T
    }
}
