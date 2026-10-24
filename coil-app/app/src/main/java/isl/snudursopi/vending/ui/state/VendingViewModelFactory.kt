package isl.snudursopi.vending.ui.state

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import isl.snudursopi.vending.data.ConnectivityObserver
import isl.snudursopi.vending.data.DataStoreDeviceIdentity
import isl.snudursopi.vending.data.backend.AdminBackendConfig
import isl.snudursopi.vending.data.backend.AdminBackendHttp
import isl.snudursopi.vending.data.backend.ComplaintClient
import isl.snudursopi.vending.data.backend.ComplaintQueueStore
import isl.snudursopi.vending.data.backend.ComplaintRepository
import isl.snudursopi.vending.data.backend.SalesClient
import isl.snudursopi.vending.data.backend.SalesQueueStore
import isl.snudursopi.vending.data.backend.SalesRepository

class VendingViewModelFactory(
    private val appContext: Context,
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return VendingViewModel(
            appContext = appContext,
            deviceIdentity = DataStoreDeviceIdentity(appContext),
            connectivityObserver = ConnectivityObserver(appContext),
            complaintRepoFactory = { machineKey, deviceCode ->
                // Built lazily once we have both a deviceCode and machineKey.
                // Provisioning isn't wired yet — for today we pass deviceCode
                // as the placeholder machineKey (backend will reject, kiosk
                // gracefully queues).
                val http = AdminBackendHttp(
                    baseUrl = AdminBackendConfig.BASE_URL,
                    machineKey = machineKey,
                )
                val client = ComplaintClient(http = http, deviceCode = deviceCode)
                val queueStore = ComplaintQueueStore(appContext)
                ComplaintRepository(client = client, queueStore = queueStore)
            },
            salesRepoFactory = { machineKey, deviceCode ->
                val http = AdminBackendHttp(
                    baseUrl = AdminBackendConfig.BASE_URL,
                    machineKey = machineKey,
                )
                val client = SalesClient(http = http, deviceCode = deviceCode)
                val queueStore = SalesQueueStore(appContext)
                SalesRepository(client = client, queueStore = queueStore)
            },
        ) as T
    }
}
