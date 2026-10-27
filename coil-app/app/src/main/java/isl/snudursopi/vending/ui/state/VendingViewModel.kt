package isl.snudursopi.vending.ui.state

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import isl.snudursopi.shared.AdbWifi
import isl.snudursopi.shared.AdminPinHash
import isl.snudursopi.shared.ClockGuard
import isl.snudursopi.vending.RestartManager
import isl.snudursopi.vending.api.WeimiApiClient
import isl.snudursopi.vending.api.WeimiCredentials
import isl.snudursopi.vending.data.ConnectivityObserver
import isl.snudursopi.vending.data.DataStoreDeviceIdentity
import isl.snudursopi.vending.data.backend.ComplaintItem
import isl.snudursopi.vending.data.backend.ComplaintPayload
import isl.snudursopi.vending.data.backend.ComplaintRepository
import isl.snudursopi.vending.data.backend.SaleLine
import isl.snudursopi.vending.data.backend.SalePayload
import isl.snudursopi.vending.data.backend.TelemetryClient
import isl.snudursopi.vending.data.backend.TelemetryPayload
import isl.snudursopi.vending.update.AppUpdater
import isl.snudursopi.vending.update.UpdateResult
import isl.snudursopi.vending.data.backend.SalesRepository
import isl.snudursopi.vending.domain.Offer
import isl.snudursopi.vending.data.backend.AdminBackendConfig
import isl.snudursopi.vending.data.backend.AdminBackendHttp
import isl.snudursopi.vending.data.ads.AdCache
import isl.snudursopi.vending.data.backend.LogRelay
import isl.snudursopi.shared.backend.PaymentLinkStatus
import isl.snudursopi.shared.backend.PaymentStatusReporter
import isl.snudursopi.vending.data.backend.RemoteAd
import isl.snudursopi.vending.data.backend.BackendImage
import isl.snudursopi.shared.RecoveryGuard
import isl.snudursopi.vending.data.backend.BackendException
import isl.snudursopi.vending.data.backend.ConfigClient
import isl.snudursopi.vending.data.backend.QuoteClient
import isl.snudursopi.vending.data.backend.ConfigProfile
import isl.snudursopi.vending.data.backend.ProductDetailsClient
import isl.snudursopi.vending.data.toProducts
import isl.snudursopi.vending.domain.AdOverlay
import isl.snudursopi.vending.domain.AdSlot
import isl.snudursopi.vending.domain.Basket
import isl.snudursopi.vending.domain.ConnectionState
import isl.snudursopi.vending.domain.DeviceIdentity
import isl.snudursopi.vending.proxy.ProxyClient
import isl.snudursopi.vending.proxy.ProxyDispatcher
import isl.snudursopi.vending.proxy.ProxyState
import isl.snudursopi.vending.domain.FeaturedProduct
import isl.snudursopi.vending.domain.HeroLine
import isl.snudursopi.vending.domain.IdleCard
import isl.snudursopi.vending.domain.IdleConfig
import isl.snudursopi.vending.domain.CartQuote
import isl.snudursopi.vending.domain.Language
import isl.snudursopi.vending.domain.LanguageCycle
import isl.snudursopi.vending.domain.MachineSettings
import isl.snudursopi.vending.domain.Product
import isl.snudursopi.vending.domain.ProductDetails
import isl.snudursopi.vending.domain.forCustomerDisplay
import isl.snudursopi.vending.data.backend.PairingClient
import isl.snudursopi.vending.ui.screens.setup.PairResult
import isl.snudursopi.vending.ui.screens.setup.CodeCheckResult
import isl.snudursopi.vending.ui.screens.setup.KeyCheckResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import isl.snudursopi.vending.data.backend.MachineCommandsClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.LocalTime

/**
 * Single ViewModel for the whole app. The bootstrap flow:
 *   1. Read device code from DataStore
 *   2. If missing → emit Phase.Setup
 *   3. If present → emit Phase.Loading, fetch catalog from API
 *   4. On success → Phase.Ready
 *   5. On failure → Phase.Error with the exception
 */
class VendingViewModel(
    private val appContext: android.content.Context,
    private val deviceIdentity: DeviceIdentity,
    private val connectivityObserver: ConnectivityObserver,
    private val complaintRepoFactory: (machineKey: String, deviceCode: String) -> ComplaintRepository,
    private val salesRepoFactory: (machineKey: String, deviceCode: String) -> SalesRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(VendingState())
    val state: StateFlow<VendingState> = _state.asStateFlow()

    /** Currently-pending auto-retry coroutine, if any. Cancelled when we
     *  succeed, reset, or schedule a new retry. */
    private var retryJob: Job? = null

    /** Card-payment controller (Marshall SDK on ttyS3). Created on first
     *  Ready transition, kept alive for the session. */
    private var marshall: isl.snudursopi.vending.hardware.nayax.MarshallPaymentController? = null
    /** Motor controller (ttyS1) for dispensing. Created with [marshall]. */
    private var motor: isl.snudursopi.vending.hardware.WeimiHardwareController? = null
    /** Debounced re-arm job: order edits reschedule this; it cancels the
     *  current Nayax session and re-sends the new total after a short pause. */
    private var rearmJob: Job? = null
    /** Idle-timeout job: returns to browse if the customer walks away. */
    private var idleJob: Job? = null
    /** Guards one-time controller setup on the first Ready transition. */
    private var hardwareStarted = false

    /**
     * Temporary Weimi-proxy bridge to the admin backend. Created when we
     * enter Ready phase with a valid deviceCode; stopped when leaving Ready.
     * Null until the first Ready transition. See [isl.snudursopi.vending.proxy.BackendConfig].
     */
    private var proxyClient: ProxyClient? = null

    /**
     * Repository handling complaint submission + retry queue. Created lazily
     * on the first Ready transition (we need a deviceCode to construct it).
     * Survives Ready → other-phase transitions so the queue persists.
     */
    private var complaintRepo: ComplaintRepository? = null
    private var salesRepo: SalesRepository? = null

    /**
     * Cached configVersion (ETag) from the last successful config fetch,
     * sent as If-None-Match on the next poll so the backend can answer 304.
     * Null until the first config load.
     */
    private var configEtag: String? = null
    /** When we last forced a non-304 config fetch (for date-based idle deals). */
    private var lastIdleFullRefreshMs: Long = 0L

    /**
     * Last successfully-fetched config (featured + gridOrder). A 304 Not
     * Modified means "unchanged since [configEtag]", so we must REUSE this
     * rather than wiping featured/gridOrder. Without this, any reload that
     * gets a 304 (e.g. returning home after a cancelled checkout) would clear
     * the hero and revert the grid to default order.
     */
    private var lastConfig: ConfigResult = ConfigResult.EMPTY

    /**
     * Local working count: vends observed since the last fresh config baseline,
     * per goodsId. The kiosk is the only component that sees a vend, and vends
     * don't bump configVersion, so between full resyncs the backend's currStock
     * is stale. Decrementing locally stops the kiosk offering a bay it just
     * emptied. Re-baselined (cleared) on every fresh (200) config load — at that
     * point the backend's currStock is the reconciled truth.
     */
    private val localVends = mutableMapOf<String, Int>()

    /**
     * Backend-owned current count per goodsId, from the config `stock` block
     * (backend v5.30). For `stockSource == "kiosk"` machines this is the live
     * source of truth (event-derived: last restock − vends reported), overlaid
     * onto the Weimi-built catalog. Persists across 304s; replaced on each
     * fresh config load.
     */
    private var backendStock: Map<String, Int> = emptyMap()

    /**
     * Per-goodsId backend-hosted normalized images from config (backend v5.46).
     * Empty until the backend's migration job has run. A goodsId absent from this
     * map keeps its local Weimi image, so the rollout is incremental and safe.
     */
    private var backendImages: Map<String, BackendImage> = emptyMap()

    /** Stock model for this machine: "kiosk" (backend-owned, this app reports
     *  vends + holds a local count) or "weimi" (legacy Weimi sync, unchanged). */
    private var stockSource: String = "weimi"

    /** Handles config-delivered operator restart commands (restartApp). */
    private val restartManager = RestartManager(appContext)

    /** Self-update over the network (silent install when Device Owner). */
    private val appUpdater = AppUpdater(appContext)
    private var updateJob: Job? = null

    /** ETag/version for the product-details endpoint (separate from config). */
    private var detailsEtag: String? = null

    /** Last good product-details map; reused on 304 or transient failure,
     *  same 304-safe pattern as [lastConfig]. */
    private var lastDetails: Map<String, ProductDetails> = emptyMap()

    /** Recurring 2-min config poll (also the presence heartbeat). */
    private var configPollJob: Job? = null
    private var telemetryJob: Job? = null
    private var logRelayJob: Job? = null
    private var paymentWatchStarted = false
    private val adCache = AdCache(appContext)
    private var lastAdsKey: String? = null

    /** Backend machine-command queue: ids we've already executed (idempotency). */
    private val executedCommandIds = java.util.Collections.synchronizedSet(HashSet<String>())
    /** Desired drop-sensor state from config ("on"→true / "off"→false); null until known. */
    @Volatile private var desiredDropSensorOn: Boolean? = null
    /** Aisles the operator has closed (friendly codes, uppercased); hidden + unsellable. */
    @Volatile private var disabledAisles: Set<String> = emptySet()

    /**
     * The machine key typed at setup, cached from DataStore so the synchronous
     * [resolveMachineKey] can see it. Loaded before any backend call is made.
     */
    @Volatile private var storedMachineKey: String? = null

    /** Which source the last [resolveMachineKey] used — reported by `config_health`. */
    @Volatile private var keySource: String = "unknown"

    /**
     * Rows whose lanes are direct-push. A push that delivers reports 0x05
     * ("turned <1 turn") because there is no rotation to complete, so for these
     * rows ONLY, 0x05 counts as a vend and the charge is captured. Everywhere
     * else 0x05 stays a failure — on a spiral it means a genuine stall, and
     * treating it as success would charge for undelivered product.
     */
    @Volatile private var directPushRows: Set<Int> = emptySet()

    /**
     * Local override for the drop sensor: true/false, or null to follow config.
     * Config re-applies its value on every poll, so a hand-set sensor was being
     * switched back off within two minutes. On a direct-push lane the sensor is
     * what STOPS the stroke — without it the board pushes a fixed distance.
     */
    @Volatile private var dropSensorOverride: Boolean? = null

    /** Closed-lane codes the last config could not decode. See `config_health`. */
    @Volatile private var undecodableAisles: List<String> = emptyList()

    /** When the last config was applied, for `config_health`. */
    @Volatile private var lastConfigAppliedAt: String? = null

    // ---- dispense diagnostics (v0.74.0) ----
    /**
     * One recorded dispense. The point of this record is [resultCode]: the
     * board's RAW shipmentResult byte, which [DispenseResult] otherwise
     * collapses into VENDED/MOTOR_FAILED and throws away. On a mixed machine
     * (spiral + direct-push) the raw code is the only thing that tells us how a
     * direct-push lane actually reports a vend, an IR miss, and an empty lane.
     */
    private data class DispenseRecord(
        val at: String,
        val slot: Int,
        val aisle: String?,
        val outcome: String,
        val resultCode: Int?,
        val detail: String,
        val test: Boolean,
    )

    /** Newest last. Bounded — diagnostics must never grow without limit. */
    private val dispenseLog = java.util.concurrent.ConcurrentLinkedDeque<DispenseRecord>()

    private fun recordDispense(
        slot: Int,
        res: isl.snudursopi.vending.hardware.DispenseResult,
        test: Boolean,
    ) {
        dispenseLog.addLast(
            DispenseRecord(
                at = isoUtcNow(),
                slot = slot,
                aisle = isl.snudursopi.vending.api.SlotCodeTranslator.rawToFriendly(slot),
                outcome = res.outcome.name,
                resultCode = res.resultCode,
                detail = res.detail,
                test = test,
            ),
        )
        while (dispenseLog.size > DISPENSE_LOG_MAX) dispenseLog.pollFirst()
    }

    init {
        bootstrap()
        startClockTick()
        startConnectivityObserver()
    }

    /** Subscribe to ConnectivityObserver and mirror state changes into VendingState. */
    private fun startConnectivityObserver() {
        viewModelScope.launch {
            connectivityObserver.observe().collect { connectionState ->
                _state.update { it.copy(connectionState = connectionState) }
            }
        }
    }

    /** Initial app load — decide whether to show setup, loading, or error. */
    private fun bootstrap() {
        viewModelScope.launch {
            storedMachineKey = deviceIdentity.machineKey()
            directPushRows = parseRows(deviceIdentity.directPushRows())
            dropSensorOverride = when (deviceIdentity.dropSensorOverride()?.lowercase()) {
                "on" -> true
                "off" -> false
                else -> null
            }
            if (dropSensorOverride != null) {
                desiredDropSensorOn = dropSensorOverride
                Log.i(TAG, "drop sensor override: ${if (dropSensorOverride == true) "ON" else "OFF"}")
            }
            if (directPushRows.isNotEmpty()) {
                Log.i(TAG, "direct-push rows: $directPushRows (0x05 counts as vended there)")
            }
            val savedCode = deviceIdentity.deviceCode()

            // Self-migration for machines provisioned by the old per-machine-build
            // route. If this machine has no stored key but the build carries one
            // that belongs to THIS deviceCode, persist it now.
            //
            // This is what makes the fleet migration possible at all. The
            // `set_machine_key` command only exists from 0.75.0, so a machine on
            // an older build cannot be migrated remotely before it is updated —
            // and it cannot safely take a generic update before it is migrated.
            // Seeding from the build it is already running breaks that circle:
            // the last per-machine build a machine ever receives migrates it on
            // first launch, with no command, no tap, and nothing to get wrong.
            if (storedMachineKey == null && savedCode != null) {
                val bakedKey = isl.snudursopi.vending.BuildConfig.TEST_MACHINE_KEY
                val bakedFor = isl.snudursopi.vending.BuildConfig.TEST_MACHINE_DEVICE_CODE
                if (bakedKey.isNotBlank() && bakedFor == savedCode) {
                    deviceIdentity.setMachineKey(bakedKey)
                    storedMachineKey = bakedKey
                    Log.i(TAG, "migrated build-time machineKey into storage for deviceCode=$savedCode")
                }
            }
            if (savedCode.isNullOrBlank()) {
                _state.update { it.copy(phase = Phase.Setup) }
            } else {
                loadCatalog(savedCode)
            }
        }
    }

    /**
     * Called by SetupScreen once the operator has confirmed the device code
     * AND entered the machine key. Both are persisted before anything touches
     * the backend, so the first config poll already carries the right
     * credential — a 401 on that first call would hard-fail the proxy.
     */
    fun onSetupCompleted(code: String, machineKey: String) {
        viewModelScope.launch {
            val key = machineKey.trim()
            deviceIdentity.setDeviceCode(code)
            deviceIdentity.setMachineKey(key)
            storedMachineKey = key
            Log.i(TAG, "setup complete: deviceCode=$code, machineKey stored (${key.take(8)}…)")
            loadCatalog(code)
        }
    }

    /**
     * Used by the Setup screen to verify a deviceCode before committing.
     * Calls the data service (deviceProfile endpoint) without saving anything;
     * just resolves the code to a friendly name so the operator can confirm
     * they typed the right number.
     *
     * Returns:
     *  - [CodeCheckResult.Found] with the deviceName if Weimi knows this code
     *  - [CodeCheckResult.NotFound] if the API returns an empty list
     *  - [CodeCheckResult.NoNetwork] if we're offline
     *  - [CodeCheckResult.ServerError] for HTTP / parsing / unexpected failures
     */
    /**
     * Verify a typed machine key against the backend BEFORE storing it.
     *
     * Shape validation is not enough. The backend binds a key to its own
     * deviceCode, so a key that is well-formed but belongs to another machine
     * — or has a single transposed character — is accepted at setup, stored,
     * and then rejected on the first real call. At that point [ProxyClient]
     * treats the 401 as a hard failure and stops reconnecting for good, and on
     * a machine without adb or OTA that is a site visit. The operator will
     * usually have left by then.
     *
     * A definite rejection means do not store. An unreachable backend does NOT:
     * we cannot distinguish "wrong key" from "no internet yet", and refusing to
     * provision a machine whose wifi is not up would be worse than storing a
     * key we could not check.
     */
    suspend fun testMachineKey(code: String, key: String): KeyCheckResult {
        if (_state.value.connectionState is ConnectionState.None) {
            return KeyCheckResult.Unverified
        }
        return try {
            val http = AdminBackendHttp(AdminBackendConfig.BASE_URL, key.trim())
            ConfigClient(http).fetch(deviceCode = code, etag = null)
            KeyCheckResult.Ok
        } catch (e: BackendException) {
            // Classify on the TYPED kind, never on the message text.
            //
            // This used to string-match "401"/"403"/"invalid_key" against
            // e.message — and AdminBackendHttp translates a 401 into the human
            // sentence "machine key rejected by backend", which contains none
            // of those. So a genuine rejection fell through to Unverified and
            // the wrong key was stored anyway. The whole verify-before-store
            // step silently did nothing. Found at Faxatorg on 26 Aug 2026,
            // after it had already cost one wrong-key provisioning.
            when (e.kind) {
                BackendException.Kind.Unauthorized -> {
                    Log.w(TAG, "typed machineKey REJECTED for deviceCode=$code")
                    KeyCheckResult.Invalid
                }
                BackendException.Kind.NetworkError -> {
                    Log.w(TAG, "could not reach backend to verify machineKey — allowing")
                    KeyCheckResult.Unverified
                }
                else -> {
                    // ClientError/ServerError/Unknown: the backend answered but
                    // not with an auth verdict. Don't block provisioning on it.
                    Log.w(TAG, "machineKey unverified (${e.kind}: ${e.message}) — allowing")
                    KeyCheckResult.Unverified
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not verify machineKey (${e.message}) — allowing")
            KeyCheckResult.Unverified
        }
    }

    /**
     * Exchange a 6-digit pairing code for this machine's identity, and STORE it.
     *
     * *** THIS COMMITS. It is not a check you can back out of.
     *
     * The server rotates the machine key as part of pairing — the moment it
     * answers, the key it held a second ago is dead. If we showed a
     * "is this the right machine?" card first and the operator walked away, the
     * backend would hold a key the machine had never seen: precisely the state
     * 62160479 was in for three days, sending its device code to a server that
     * had something else on file.
     *
     * So the identity is persisted here, immediately, and the name is returned
     * only so the screen can SAY which machine it just became. Paired the wrong
     * one? Pair again with the right code — the endpoint rotates every time and
     * does not care that a key already exists. That is the one thing
     * /machines/provision could not do, and why it 409'd its way into this mess.
     *
     * No Weimi call anywhere in this path. The vélarnúmer lookup it replaces is
     * what answers "Vél fannst ekki" on any machine assigned to a sub-operator.
     */
    suspend fun pairWithCode(code: String): PairResult {
        if (_state.value.connectionState is ConnectionState.None) {
            return PairResult.NoNetwork
        }
        return try {
            // Empty key on purpose: /api/v1/provisioning/pair carries no
            // machine-key middleware, which is what makes it reachable by a
            // kiosk that has no key yet.
            val http = AdminBackendHttp(AdminBackendConfig.BASE_URL, "")
            val id = PairingClient(http).pair(code.trim())
            deviceIdentity.setDeviceCode(id.deviceCode)
            deviceIdentity.setMachineKey(id.machineKey)
            storedMachineKey = id.machineKey
            Log.i(TAG, "paired: deviceCode=${id.deviceCode} (${id.deviceName}), key stored (${id.machineKey.take(8)}…)")
            PairResult.Ok(deviceCode = id.deviceCode, deviceName = id.deviceName, machineKey = id.machineKey)
        } catch (e: BackendException) {
            // A wrong clock fails TLS before the request leaves, so it arrives here
            // looking like a network or server fault. Name the real cause.
            if (ClockGuard.isWrong() && e.kind != BackendException.Kind.ClientError) {
                Log.w(TAG, "pairing failed with the clock at ${ClockGuard.shownAs()} (${e.kind})")
                return PairResult.ClockWrong
            }
            // Typed kind only, never the message text — see PairingClient.pair.
            when (e.kind) {
                BackendException.Kind.NetworkError -> PairResult.NoNetwork
                BackendException.Kind.ClientError -> PairResult.Rejected
                else -> {
                    Log.w(TAG, "pairing failed (${e.kind}: ${e.message})")
                    PairResult.ServerError
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "pairing failed (${e.message})")
            if (ClockGuard.isWrong()) PairResult.ClockWrong else PairResult.ServerError
        }
    }

    suspend fun testDeviceCode(code: String): CodeCheckResult {
        if (_state.value.connectionState is ConnectionState.None) {
            return CodeCheckResult.NoNetwork
        }
        return try {
            val client = if (WeimiCredentials.USE_TEST_ENDPOINT) {
                WeimiApiClient.test(WeimiCredentials.APP_ID, WeimiCredentials.SECRET_KEY)
            } else {
                WeimiApiClient.production(WeimiCredentials.APP_ID, WeimiCredentials.SECRET_KEY)
            }
            val profiles = client.deviceProfile(listOf(code))
            val profile = profiles.firstOrNull()
            if (profile == null) {
                CodeCheckResult.NotFound
            } else {
                CodeCheckResult.Found(deviceName = profile.deviceName ?: "")
            }
        } catch (e: Exception) {
            Log.w(TAG, "testDeviceCode failed for $code: ${e.message}")
            CodeCheckResult.ServerError
        }
    }

    /** Reload — used by the error screen's retry button. */
    fun retryLoad() {
        viewModelScope.launch {
            val saved = deviceIdentity.deviceCode()
            if (saved.isNullOrBlank()) {
                _state.update { it.copy(phase = Phase.Setup, fatalError = null) }
            } else {
                loadCatalog(saved)
            }
        }
    }

    /**
     * Force a catalog refresh from the diagnostics screen. Unlike retryLoad
     * this is called from the Ready phase, not from Error — it keeps the
     * existing catalog visible while fetching, then swaps it in atomically.
     */
    fun refreshCatalog() {
        val code = _state.value.deviceCode ?: return
        viewModelScope.launch { loadCatalog(code) }
    }

    /**
     * Debug-only — force the app into Error phase with a synthetic exception
     * so we can verify the error screen UI without actually breaking anything.
     * Called by the diagnostics screen's debug section (gated to BuildConfig.DEBUG
     * on the UI side).
     *
     * The synthetic error routes through [transitionToError] so the full
     * retry-loop behavior is exercised — but because the next retry will
     * succeed if the device code is valid, the error screen auto-recovers
     * after the first backoff window. To see the error screen persistently,
     * leave the connection off as well.
     */
    fun forceTestError() {
        transitionToError(
            RuntimeException("Test error — triggered manually from diagnostics")
        )
    }

    /** Wipe the saved device code and return to Setup. Used by error screen. */
    fun clearDeviceCodeAndRestart() {
        viewModelScope.launch {
            stopProxy()
            deviceIdentity.clearDeviceCode()
            _state.update {
                it.copy(phase = Phase.Setup, fatalError = null, deviceCode = null)
            }
        }
    }

    /**
     * Full factory reset — clears device code and resets all in-memory state
     * back to defaults. Equivalent to a fresh install. Used by the diagnostics
     * screen's "óafturkræfar aðgerðir" section.
     *
     * Note: connectionState is preserved since it reflects the live hardware
     * state, not user data. Everything else resets.
     */
    fun factoryReset() {
        viewModelScope.launch {
            stopProxy()
            deviceIdentity.clearDeviceCode()
            _state.update {
                VendingState(
                    phase = Phase.Setup,
                    connectionState = it.connectionState,
                )
            }
        }
    }

    private suspend fun loadCatalog(deviceCode: String) {
        _state.update { it.copy(phase = Phase.Loading, deviceCode = deviceCode, fatalError = null) }
        Log.i(TAG, "Loading catalog for deviceCode=$deviceCode")

        // Some machines in the fleet have a non-standard layout (different cabinet
        // configuration, atypical aisle layout). These need their own handling and
        // are excluded for now.
        if (deviceCode in UNSUPPORTED_DEVICES) {
            val error = IllegalStateException(
                "Vélnúmer $deviceCode er ekki stutt í þessari útgáfu. " +
                "Þessi vél hefur óvenjulega uppsetningu sem hefur ekki verið útfærð enn."
            )
            Log.w(TAG, "Refusing unsupported device $deviceCode")
            _state.update { it.copy(phase = Phase.Error, fatalError = error) }
            return
        }

        try {
            val client = if (WeimiCredentials.USE_TEST_ENDPOINT) {
                WeimiApiClient.test(WeimiCredentials.APP_ID, WeimiCredentials.SECRET_KEY)
            } else {
                WeimiApiClient.production(WeimiCredentials.APP_ID, WeimiCredentials.SECRET_KEY)
            }

            // Fetch device profile (gives us the operator name) and device info (aisles).
            // The profile call may fail if it's not exposed for this device — we tolerate
            // that, since the catalog is what really matters.
            val profile = runCatching { client.deviceProfile(listOf(deviceCode)) }
                .onFailure { Log.w(TAG, "deviceProfile failed (continuing): ${it.message}") }
                .getOrNull()
                ?.firstOrNull()

            val deviceInfo = client.deviceInfo(deviceCode)
            val aisles = deviceInfo.allAisles
            Log.i(TAG, "deviceInfo returned ${aisles.size} aisles across ${deviceInfo.cabinetTotal} cabinets")

            val products = aisles.toProducts()
            Log.i(TAG, "Consolidated to ${products.size} unique products")

            if (products.isEmpty()) {
                error(
                    "No products available for device $deviceCode. " +
                    "Aisle count from API: ${aisles.size}. " +
                    "Possible causes: machine layout not configured in the vendor portal, " +
                    "machine is currently online (cloud may not expose aisles for live machines), " +
                    "or all slots are empty."
                )
            }

            val config = fetchFeaturedFromConfig(deviceCode)
            val featured = config.featured
            val heroes = resolveHeroes(featured, products)

            // Operator identity comes from the admin backend config profile
            // (the SUB-OPERATOR running this machine, e.g. "AG Rekstur").
            // Falls back to blank/default when the profile isn't available,
            // which the UI handles (brandLine hides the suffix when blank).
            val profileOperator: String = config.profile?.operatorName.orEmpty()
            val operatorName: String = if (profileOperator.isNotBlank()) profileOperator else ""
            val profileEmail: String = config.profile?.supportEmail.orEmpty()
            val supportEmail: String =
                if (profileEmail.isNotBlank()) profileEmail else _state.value.settings.supportEmail
            val machineName = profile?.deviceName ?: ""

            // Ads come from the backend (the machine's list, else its operator's) and play
            // only from a local copy — see AdCache. Whatever is on disk shows at once;
            // syncAds downloads the rest and swaps it in when it lands.
            val ads = adCache.playable(config.ads)

            _state.update {
                it.copy(
                    phase = Phase.Ready,
                    catalog = products.withBackendStock().withBackendImages(),
                    visibleProducts = products.withBackendStock().withBackendImages().withLocalVends().forCustomerDisplay(config.gridOrder, disabledAisles),
                    heroes = heroes,
                    productDetails = config.productDetails,
                    machineName = machineName,
                    lastFetchMillis = System.currentTimeMillis(),
                    idleCards = config.idle.cards,
                    idleRotationSeconds = config.idle.rotationSeconds,
                    idleAttractTimeoutSeconds = config.idle.attractTimeoutSeconds,
                    offers = config.offers.associateBy { it.goodsId },
                    // Reset retry state — a successful load clears the slate.
                    retryAttempts = 0,
                    nextRetryAtMillis = 0L,
                    fatalError = null,
                    adminPin = config.adminPin,
                    outOfService = config.outOfService,
                    outOfServiceReason = config.outOfServiceReason,
                    settings = it.settings.copy(
                        operatorName = operatorName,
                        supportEmail = supportEmail,
                        featured = featured,
                        ads = ads,
                        showAdRegion = config.showAdRegion,
                    ),
                )
            }
            cancelPendingRetry()
            syncAds(config)
            // Bring up the card reader + motor controllers once; the reader
            // stays connected for the session so payment is instant.
            startHardwareOnce()
            // Spin up the backend proxy bridge if it isn't already running.
            // Idempotent: ProxyClient.start() is a no-op when already active.
            ensureProxyStarted(deviceCode = deviceCode, weimiClient = client)
            // Start the recurring config poll (also the presence heartbeat).
            startConfigPoll(deviceCode)
            startTelemetryLoop(deviceCode)
            startUpdateLoop(deviceCode)
            startLogRelay(deviceCode)
        } catch (e: Exception) {
            Log.e(TAG, "Catalog load failed", e)
            transitionToError(e)
        }
    }

    /**
     * Single entry point for entering the Error phase. Stamps the error,
     * increments the retry counter, and schedules the next auto-retry per
     * the [RETRY_BACKOFF_SECONDS] table.
     *
     * Backoff is per consecutive failure since the most recent successful
     * load. A successful retry resets the counter.
     */
    private fun transitionToError(error: Throwable) {
        val attempts = _state.value.retryAttempts + 1
        val backoffSec = RETRY_BACKOFF_SECONDS[
            (attempts - 1).coerceAtMost(RETRY_BACKOFF_SECONDS.lastIndex)
        ]
        val nextRetryAt = System.currentTimeMillis() + backoffSec * 1000L
        _state.update {
            it.copy(
                phase = Phase.Error,
                fatalError = error,
                retryAttempts = attempts,
                nextRetryAtMillis = nextRetryAt,
            )
        }
        cancelPendingRetry()
        retryJob = viewModelScope.launch {
            delay(backoffSec * 1000L)
            // Only retry if we're still in Error phase (user may have reset
            // device code in the meantime, which moves us to Setup).
            val current = _state.value
            if (current.phase == Phase.Error && current.deviceCode != null) {
                Log.i(TAG, "Auto-retry attempt $attempts for ${current.deviceCode}")
                loadCatalog(current.deviceCode)
            }
        }
    }

    /** Manual retry, used by the operator-view "reyna núna" button. */
    fun retryNow() {
        val code = _state.value.deviceCode ?: return
        cancelPendingRetry()
        viewModelScope.launch { loadCatalog(code) }
    }

    /** Cancel any pending auto-retry coroutine. */
    private fun cancelPendingRetry() {
        retryJob?.cancel()
        retryJob = null
    }

    fun addToBasket(product: Product) {
        _state.update { it.copy(basket = it.basket.add(product)) }
    }

    fun addToBasketWithToast(product: Product) {
        if (_state.value.basket.itemCount >= Basket.MAX_ITEMS) return
        _state.update {
            it.copy(
                basket = it.basket.add(product),
                toastMessage = "${product.name} bætt í körfu",
            )
        }
        viewModelScope.launch {
            delay(2000L)
            _state.update { it.copy(toastMessage = null) }
        }
    }

    fun removeFromBasket(productId: String) {
        _state.update { it.copy(basket = it.basket.remove(productId)) }
    }

    fun clearBasket() {
        _state.update { it.copy(basket = Basket()) }
    }

    /**
     * Records a successful (or partial) payment as a completed transaction so
     * the Success screen + complaint flow can reference it. [capturedIsk] is
     * the amount ACTUALLY charged (may be < basket total on a partial vend).
     */
    private fun recordTransaction(capturedIsk: Int) {
        val current = _state.value
        if (current.basket.isEmpty) return
        val tradeNo = WeimiApiClient.newTradeNo()
        val record = CompletedTransaction(
            tradeNo = tradeNo,
            items = current.basket.lines.map { line ->
                CompletedTransactionItem(
                    goodsId = line.product.id,
                    name = line.product.name,
                    priceIsk = line.product.priceIsk,
                    quantity = line.quantity,
                    slot = line.product.slot,
                )
            },
            totalIsk = capturedIsk,
            timestampMs = System.currentTimeMillis(),
        )
        _state.update {
            it.copy(
                basket = Basket(),
                lastCompletedTransaction = record,
                paymentPhase = PaymentPhase.Done,
                quote = null,
            )
        }
        Log.i(TAG, "Payment complete, tradeNo=$tradeNo, captured=$capturedIsk")
        // Local working count (kiosk machines only): the bay(s) just vended.
        // Decrement so we stop offering an emptied bay before the next fresh
        // config resync. weimi machines keep their existing behaviour. (Assumes
        // full dispense; partial-dispense accuracy is a later refinement.)
        if (stockSource == "kiosk") {
            current.basket.lines.forEach { line ->
                localVends[line.product.id] = (localVends[line.product.id] ?: 0) + line.quantity
            }
            rebuildVisibleProducts()
        }
        reportSale(saleId = tradeNo, capturedIsk = capturedIsk, snapshot = current)
    }

    /** Report a completed sale to the backend (stock decrement + revenue).
     *  Idempotent on [saleId]; queued and retried if the post fails. Per-line
     *  amount is the realised (deal) price from the quote when present, else
     *  base. [snapshot] is the pre-clear state (still holds the basket+quote). */
    private fun reportSale(saleId: String, capturedIsk: Int, snapshot: VendingState) {
        val repo = salesRepo ?: return
        val quote = snapshot.quote
        val lines = snapshot.basket.lines.map { line ->
            val realised = quote?.lines?.firstOrNull { it.goodsId == line.product.id }?.lineTotalIsk
                ?: (line.product.priceIsk * line.quantity)
            SaleLine(goodsId = line.product.id, qty = line.quantity, amountIsk = realised)
        }
        if (lines.isEmpty()) return
        val payload = SalePayload(
            saleId = saleId,
            at = isoUtcNow(),
            totalIsk = capturedIsk,
            lines = lines,
        )
        viewModelScope.launch { repo.reportOrQueue(payload) }
    }

    /** ISO-8601 UTC timestamp (e.g. 2026-06-20T11:30:00Z). SimpleDateFormat
     *  rather than java.time, which needs API 26 / desugaring (minSdk is 24). */
    private fun isoUtcNow(): String {
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
        fmt.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return fmt.format(java.util.Date())
    }

    /**
     * Diagnostic (offline-sales prep): query recent Weimi orders for THIS
     * device and log the RAW JSON, so we can read the real field names/values
     * Weimi records — especially payChannelCodeInt and userId, which we need to
     * report sales correctly. Read via: `adb logcat -s VendingViewModel:I`.
     */
    fun dumpRecentOrders() {
        val code = _state.value.deviceCode
        if (code == null) {
            Log.w(TAG, "dumpRecentOrders: no deviceCode")
            return
        }
        viewModelScope.launch {
            try {
                val client = if (WeimiCredentials.USE_TEST_ENDPOINT) {
                    WeimiApiClient.test(WeimiCredentials.APP_ID, WeimiCredentials.SECRET_KEY)
                } else {
                    WeimiApiClient.production(WeimiCredentials.APP_ID, WeimiCredentials.SECRET_KEY)
                }
                val raw = client.queryOrdersRaw(page = 1, size = 10, deviceCode = code)
                val pretty = raw.toPrettyString()
                Log.i(TAG, "=== RECENT ORDERS (raw) for $code ===")
                pretty.chunked(3500).forEachIndexed { i, chunk ->
                    Log.i(TAG, "orders[$i]: $chunk")
                }
                Log.i(TAG, "=== END RECENT ORDERS ===")
            } catch (t: Throwable) {
                Log.e(TAG, "dumpRecentOrders failed: ${t.message}", t)
            }
        }
    }

    // ============ Stage 3b — real card payment + dispense ============

    /** One-time setup of the hardware controllers on the first Ready
     *  transition. Reader stays connected for the whole session (always-on),
     *  so payment is instant when the customer reaches the pay screen. */
    private fun startHardwareOnce() {
        if (hardwareStarted) return
        hardwareStarted = true
        try {
            val m = isl.snudursopi.vending.hardware.WeimiHardwareController(
                appContext.applicationContext, "/dev/ttyS1", 9600,
            )
            motor = m
            m.start { ok ->
                Log.i(TAG, "motor ttyS1 open=$ok")
                if (ok) applyDropSensorIfPossible()
            }

            val pc = isl.snudursopi.vending.hardware.nayax.MarshallPaymentController(
                portPath = "/dev/ttyS3",
                baud = 115200,
                log = { line -> Log.i(TAG, "marshall: $line") },
            )
            // Per-item dispense: motor turns the coil → true counts toward capture.
            pc.onDispenseItem = { item ->
                // Reflect the dispensing state in the UI on the first coil turn.
                if (_state.value.paymentPhase == PaymentPhase.AwaitingCard) {
                    _state.update { it.copy(paymentPhase = PaymentPhase.Dispensing) }
                }
                val res = m.dispenseBlocking(address = 0, slot = item.slot, timeoutMs = 8000)
                recordDispense(item.slot, res, test = false)
                val directPushVend = countsAsDirectPushVend(item.slot, res.resultCode)
                if (directPushVend) {
                    Log.i(
                        TAG,
                        "slot=${item.slot} is on a direct-push row and returned 0x05 — " +
                            "treating as VENDED and capturing the charge",
                    )
                }
                Log.i(
                    TAG,
                    "dispense coil=${item.slot} → ${res.outcome} " +
                        "code=${res.resultCode?.let { "0x%02x".format(it) } ?: "none"} (${res.detail})",
                )
                res.outcome == isl.snudursopi.vending.hardware.DispenseResult.Outcome.VENDED ||
                    directPushVend
            }
            marshall = pc
            // A card was presented: mark this arm as "real tap" (so a decline
            // here is a genuine bank reject we can retry, not a phantom), and
            // stop the idle timer so a slow-but-present tap is never cut off
            // mid-auth.
            pc.onCardDetected = {
                cardDetectedThisArm = true
                idleJob?.cancel()
            }
            // React to reader up/down: drives the auto-clearing ReaderDown screen.
            pc.onReaderStateChanged = { ready ->
                _state.update { st ->
                    val newPhase = when {
                        !ready && st.paymentPhase != PaymentPhase.Idle &&
                            st.paymentPhase != PaymentPhase.Done -> PaymentPhase.ReaderDown
                        ready && st.paymentPhase == PaymentPhase.ReaderDown -> PaymentPhase.Arming
                        else -> st.paymentPhase
                    }
                    st.copy(readerReady = ready, paymentPhase = newPhase)
                }
                if (ready && _state.value.paymentPhase == PaymentPhase.Arming &&
                    !_state.value.basket.isEmpty) {
                    armReader(immediate = true)
                }
            }
            pc.connect()
            startPaymentWatch(pc)
        } catch (t: Throwable) {
            Log.e(TAG, "startHardwareOnce failed: ${t.message}", t)
        }
    }

    /** Expand the basket into one payment Item per physical unit, mapping each
     *  product's friendly slot ("A35") to its motor coil. Lines whose slot
     *  can't be mapped are skipped (logged). */
    private fun orderItems(): List<isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Item> {
        var codeCounter = 0
        return _state.value.basket.lines.flatMap { line ->
            val raw = isl.snudursopi.vending.api.SlotCodeTranslator.friendlyToRaw(line.product.slot)
            if (raw == null) {
                Log.w(TAG, "no raw slot for ${line.product.slot} (${line.product.name})")
                emptyList()
            } else {
                List(line.quantity) {
                    isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Item(
                        code = codeCounter++,
                        slot = raw,
                        priceIsk = line.product.priceIsk,
                    )
                }
            }
        }
    }

    /** Price the current basket against the backend deal engine. Returns null on
     *  any failure (caller falls back to base prices — never blocks the sale). */
    private suspend fun quoteCart(): CartQuote? {
        val deviceCode = _state.value.deviceCode ?: return null
        val basket = _state.value.basket
        if (basket.lines.isEmpty()) return null
        return try {
            val http = AdminBackendHttp(AdminBackendConfig.BASE_URL, resolveMachineKey(deviceCode))
            val items = basket.lines.map { it.product.id to it.quantity }
            val q = QuoteClient(http).quote(deviceCode, items)
            Log.i(TAG, "quote: subtotal=${q.subtotalIsk} discount=${q.discountIsk} total=${q.totalIsk} " +
                "deals=${q.appliedDeals.map { it.dealName }}")
            q
        } catch (e: Exception) {
            Log.w(TAG, "quote failed (${e.message}) — charging base prices")
            null
        }
    }

    /** Build the Nayax item list using DEAL-priced per-unit prices from [quote]
     *  so the terminal is charged the discounted total and per-item capture
     *  (incl. partial dispense) stays correct. Falls back to base prices for any
     *  line the quote didn't cover, or entirely when [quote] is null. */
    private fun discountedOrderItems(
        quote: CartQuote?,
    ): List<isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Item> {
        if (quote == null) return orderItems()
        var codeCounter = 0
        return _state.value.basket.lines.flatMap { line ->
            val raw = isl.snudursopi.vending.api.SlotCodeTranslator.friendlyToRaw(line.product.slot)
            if (raw == null) {
                Log.w(TAG, "no raw slot for ${line.product.slot} (${line.product.name})")
                emptyList()
            } else {
                val ql = quote.lines.firstOrNull { it.goodsId == line.product.id }
                val unitPrices = if (ql != null && line.quantity > 0) {
                    splitInt(ql.lineTotalIsk, line.quantity)
                } else {
                    List(line.quantity) { line.product.priceIsk }
                }
                unitPrices.map { price ->
                    isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Item(
                        code = codeCounter++,
                        slot = raw,
                        priceIsk = price,
                    )
                }
            }
        }
    }

    /** Split [total] into [parts] integer pieces summing exactly to [total]
     *  (earlier pieces absorb the remainder). */
    private fun splitInt(total: Int, parts: Int): List<Int> {
        if (parts <= 0) return emptyList()
        val base = total / parts
        val rem = total % parts
        return List(parts) { i -> if (i < rem) base + 1 else base }
    }

    /** Tapping a product image. With an empty cart this is an instant single-
     *  item buy (seed a fresh order + arm now). If a basket is ALREADY in
     *  progress (customer came from "Add more"), append to it instead of wiping
     *  it — the forgiving behaviour, so an image tap can never silently throw
     *  away a multi-item basket. NavGraph then shows Payment. */
    /** Tapping a product image. Empty cart → instant single-item buy (seed a
     *  fresh order + arm now), returns true so NavGraph shows Payment. If a cart
     *  is ALREADY in progress, append to it and STAY on the grid (returns false)
     *  — so an image tap never wipes a multi-item basket, and building a cart
     *  keeps you on the grid like the cart icon does. */
    fun buyNow(product: Product): Boolean {
        if (product.slot.uppercase() in disabledAisles) {
            Log.i(TAG, "buyNow ignored — aisle ${product.slot} is closed")
            return false
        }
        if (!_state.value.basket.isEmpty) {
            addToOrder(product)
            return false
        }
        _state.update { it.copy(basket = Basket().add(product)) }
        armReader(immediate = true)
        return true
    }

    /** Add a product to the cart and STAY on the grid (cart-icon tap, or an
     *  image tap while a cart is already open). No arming here — the reader is
     *  armed only at checkout, so building a cart never blips the terminal or
     *  starts the idle clock. If somehow a live session is up (e.g. editing
     *  after coming back from checkout without leaving it), onOrderEdited kills
     *  the stale amount and re-prices. */
    fun addToOrder(product: Product) {
        if (product.slot.uppercase() in disabledAisles) {
            Log.i(TAG, "addToOrder ignored — aisle ${product.slot} is closed")
            return
        }
        if (_state.value.basket.itemCount >= Basket.MAX_ITEMS) return
        _state.update { it.copy(basket = it.basket.add(product)) }
        onOrderEdited()
    }

    /** Add a combo-nudge candidate to the order from the catalog (it isn't in the
     *  basket yet), then re-price like any other order edit. Guarded at MAX_ITEMS. */
    fun addOrderItem(goodsId: String) {
        if (_state.value.basket.itemCount >= Basket.MAX_ITEMS) return
        val product = _state.value.catalog.firstOrNull { it.id == goodsId } ?: return
        _state.update { it.copy(basket = it.basket.add(product)) }
        onOrderEdited()
    }

    /** Increment a product's quantity in the order. */
    fun incOrderItem(productId: String) {
        val product = _state.value.basket.lines.firstOrNull { it.product.id == productId }?.product ?: return
        if (_state.value.basket.itemCount >= Basket.MAX_ITEMS) return
        _state.update { it.copy(basket = it.basket.add(product)) }
        onOrderEdited()
    }

    /** Decrement a product's quantity (removing the line if it hits zero). If
     *  the order becomes empty, cancel back to browse. */
    fun decOrderItem(productId: String) {
        val current = _state.value.basket
        val line = current.lines.firstOrNull { it.product.id == productId } ?: return
        val newBasket = if (line.quantity <= 1) {
            current.remove(productId)
        } else {
            Basket(current.lines.map {
                if (it.product.id == productId) it.copy(quantity = it.quantity - 1) else it
            })
        }
        if (newBasket.isEmpty) {
            cancelOrder()
            return
        }
        _state.update { it.copy(basket = newBasket) }
        onOrderEdited()
    }

    /** Open the checkout/Payment screen for a cart built on the grid: arm the
     *  reader with the current total. Sets Arming synchronously first so the
     *  Payment screen never briefly sees Idle and bounces back to Browse. */
    fun openCheckout() {
        if (_state.value.basket.isEmpty) return
        _state.update { it.copy(paymentPhase = PaymentPhase.Arming) }
        armReader(immediate = true)
    }

    /** Customer left the pay screen to browse / add more. Drop the terminal
     *  session (the shown amount isn't being paid now) but KEEP the basket, and
     *  stop the idle clock so the cart can't time out while they browse. The
     *  reader re-arms when they return to checkout. */
    fun leaveCheckout() {
        armSeq++              // supersede any in-flight arm
        arming = false
        rearmJob?.cancel()
        idleJob?.cancel()
        try { marshall?.cancel() } catch (_: Throwable) {}
        _state.update { it.copy(paymentPhase = PaymentPhase.Idle) }   // basket kept
    }

    /** Called after any basket edit. If the reader is ALREADY showing an amount
     *  (a live vend), cancel it IMMEDIATELY — on the button press — so the now-
     *  stale amount can't be tapped/paid, then re-price once edits settle (the
     *  re-charge stays debounced so rapid adds coalesce into one new total). If
     *  nothing is armed (building a cart on the grid), do nothing: arming is a
     *  checkout-only thing. */
    private fun onOrderEdited() {
        val pc = marshall ?: return
        val live = pc.state == isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.State.VENDING
        if (!live) return
        armSeq++                                   // ignore the cancelled arm's result
        try { pc.cancel() } catch (_: Throwable) {} // stale amount dies on the press
        scheduleRearm()                            // debounced re-charge of new total
    }

    /** Debounced re-charge: order edits reschedule this. After ~1.5s of no
     *  further changes, send the new total. The live session (if any) was
     *  already cancelled on the press by onOrderEdited, so armReader just waits
     *  for the terminal to be ready again and charges. */
    private fun scheduleRearm() {
        rearmJob?.cancel()
        // Show the brief "updating amount" state immediately for feedback.
        _state.update { it.copy(paymentPhase = PaymentPhase.Arming) }
        rearmJob = viewModelScope.launch {
            kotlinx.coroutines.delay(1500)
            armReader(immediate = false)
        }
    }

    /** True while an arm/re-arm is in progress, to prevent overlapping
     *  cancel→charge cycles that caused a re-send loop. */
    @Volatile private var arming = false
    /** Set true when a card is actually presented during the current armed
     *  session, reset on each fresh charge. Lets us tell a real, tapped-then-
     *  declined card apart from a phantom decline so we only re-arm (and only
     *  ever once, on an actual tap) when there's a real card to retry — never
     *  in a no-tap loop, which is what churned the serial bus. */
    @Volatile private var cardDetectedThisArm = false
    /** Monotonic id of the current arm request; a newer request supersedes an
     *  older in-flight one so stale callbacks are ignored. */
    private var armSeq = 0

    /** Arm (or re-arm) the Nayax with the current order total. Cancels any
     *  existing session, waits for the controller to return to READY, then
     *  sends a fresh chargeBasket. [immediate]=true skips the debounce. */
    private fun armReader(immediate: Boolean) {
        val pc = marshall
        if (pc == null || !_state.value.readerReady) {
            _state.update { it.copy(paymentPhase = PaymentPhase.ReaderDown) }
            return
        }
        val items = orderItems()
        if (items.isEmpty()) {
            cancelOrder()
            return
        }
        val mySeq = ++armSeq
        viewModelScope.launch {
            _state.update { it.copy(paymentPhase = PaymentPhase.Arming) }
            // A live vend here should already have been cancelled on the edit
            // press by onOrderEdited; cancel defensively in case armReader was
            // reached another way. A fresh tap (controller READY) skips this.
            val live = pc.state == isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.State.VENDING
            if (live) {
                try { pc.cancel() } catch (_: Throwable) {}
                if (mySeq != armSeq) return@launch
            }
            // ALWAYS wait for the terminal to be vend-ready before charging. A
            // cancel (here OR on the edit press) clears vendReady; the vend
            // layer's fresh onReady re-sets it once the terminal has dropped the
            // old session and can price a new one. Checking only the controller
            // link state (which flips back instantly) let the old code re-charge
            // into a terminal that wasn't ready → no amount shown. Returns
            // immediately for a fresh tap (terminal already idle/ready).
            awaitVendReady(pc, timeoutMs = 4000)
            if (mySeq != armSeq) return@launch
            // Controller link READY too (belt-and-suspenders).
            val ready = awaitReady(pc, timeoutMs = 4000)
            // If a newer arm request superseded us, or the order changed, bail.
            if (mySeq != armSeq) return@launch
            if (!ready) {
                Log.w(TAG, "armReader: controller not READY")
                _state.update { it.copy(paymentPhase = PaymentPhase.ReaderDown) }
                return@launch
            }
            if (orderItems().isEmpty()) { return@launch }
            // Price the cart against the deal engine (authoritative at charge
            // time — this is the amount the customer taps to pay). On any failure
            // quoteCart() returns null and we charge base prices; never block.
            val quote = quoteCart()
            if (mySeq != armSeq) return@launch
            _state.update { it.copy(quote = quote) }
            val chargeItems = discountedOrderItems(quote)
            if (chargeItems.isEmpty()) { return@launch }
            cardDetectedThisArm = false
            arming = true
            try {
                pc.chargeBasket(chargeItems) { result ->
                    // Ignore results from a superseded arm.
                    if (mySeq == armSeq) onPaymentResult(result)
                }
                _state.update { it.copy(paymentPhase = PaymentPhase.AwaitingCard) }
                startIdleTimeout()
            } finally {
                arming = false
            }
        }
    }

    /** Suspend until the vend layer is ready for a new vend after a cancel (or
     *  timeout). cancel() clears vendReady; the SDK re-sets it when the terminal
     *  has dropped the old session and is ready to price the next one. */
    private suspend fun awaitVendReady(
        pc: isl.snudursopi.vending.hardware.nayax.MarshallPaymentController,
        timeoutMs: Long,
    ): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (pc.vendReady) return true
            kotlinx.coroutines.delay(100)
        }
        return pc.vendReady
    }

    /** Suspend until the Marshall controller reports READY (or timeout). */
    private suspend fun awaitReady(
        pc: isl.snudursopi.vending.hardware.nayax.MarshallPaymentController,
        timeoutMs: Long,
    ): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (pc.state == isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.State.READY) return true
            kotlinx.coroutines.delay(100)
        }
        return pc.state == isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.State.READY
    }

    /** Result of a charge attempt from the Marshall controller. */
    private fun onPaymentResult(
        result: isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Result,
    ) {
        idleJob?.cancel()
        when (result) {
            is isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Result.Approved -> {
                Log.i(TAG, "approved, captured=${result.amount}")
                recordTransaction(result.amount)
            }
            is isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Result.Declined,
            is isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Result.Failed -> {
                Log.i(TAG, "declined/failed: $result (cardDetected=$cardDetectedThisArm)")
                _state.update { it.copy(paymentPhase = PaymentPhase.Declined) }
                if (cardDetectedThisArm) {
                    // A real card was tapped and the bank rejected it. Re-arm
                    // ONCE so the customer can try another card. This re-arm is
                    // driven by an actual tap, not a machine loop — and the next
                    // charge resets cardDetectedThisArm, so a follow-on phantom
                    // decline will NOT re-arm again.
                    viewModelScope.launch {
                        kotlinx.coroutines.delay(1200)
                        if (!_state.value.basket.isEmpty &&
                            _state.value.paymentPhase == PaymentPhase.Declined &&
                            !arming) {
                            armReader(immediate = true)
                        }
                    }
                } else {
                    // No card was ever presented — this is a phantom decline,
                    // not a real one. Do NOT re-arm: the old auto-re-arm here is
                    // exactly what looped cancel→charge and churned the serial
                    // bus (Send retry storm). Show the message briefly, then end
                    // the order cleanly back to browse.
                    viewModelScope.launch {
                        kotlinx.coroutines.delay(1500)
                        if (_state.value.paymentPhase == PaymentPhase.Declined && !arming) {
                            cancelOrder()
                        }
                    }
                }
            }
            is isl.snudursopi.vending.hardware.nayax.MarshallPaymentController.Result.Cancelled -> {
                Log.i(TAG, "cancelled (no auto re-arm)")
                // Our own cancel (from armReader or cancelOrder). Do NOT re-arm
                // here — armReader drives its own re-charge; cancelOrder ends it.
            }
        }
    }

    /** Idle timeout: if the customer opens pay and walks away (no tap, no
     *  edit), cancel the session and return to browse. 30s — 10s was too short
     *  for someone fishing a card out, and it raced the auth round-trip. A card
     *  being presented (onCardDetected) cancels this so a slow tap is never cut
     *  off mid-payment. */
    private fun startIdleTimeout() {
        idleJob?.cancel()
        idleJob = viewModelScope.launch {
            kotlinx.coroutines.delay(30_000)
            if (_state.value.paymentPhase == PaymentPhase.AwaitingCard) {
                Log.i(TAG, "idle timeout — cancelling order")
                cancelOrder()
            }
        }
    }

    /** Cancel the current order: cancel the Nayax session, clear the basket,
     *  return to Idle (NavGraph navigates back to Browse). */
    fun cancelOrder() {
        armSeq++  // supersede any in-flight arm so its callback is ignored
        arming = false
        rearmJob?.cancel()
        idleJob?.cancel()
        try { marshall?.cancel() } catch (_: Throwable) {}
        _state.update { it.copy(basket = Basket(), paymentPhase = PaymentPhase.Idle, quote = null) }
    }

    /** The screen went idle (inactivity timer) and is dropping to the attract
     *  loop. Clear any abandoned cart and tear down any reader session so the
     *  next customer starts clean. Same teardown as [cancelOrder]. */
    fun resetForAttract() {
        cancelOrder()
    }

    /** Called after the Success screen is shown / left, to reset for the next
     *  customer. */
    fun resetPaymentPhase() {
        _state.update { it.copy(paymentPhase = PaymentPhase.Idle) }
    }


    /**
     * Customer is filing a complaint about [items] from the most-recently
     * completed transaction. Submits to backend or queues for retry. The
     * UI shows the confirmation screen regardless — the customer's
     * complaint will reach the operator one way or another.
     *
     * Result reported via [ComplaintSubmissionState] on VendingState.
     */
    fun submitComplaint(
        items: List<CompletedTransactionItem>,
        note: String?,
        customerEmail: String,
    ) {
        val repo = complaintRepo
        val record = _state.value.lastCompletedTransaction
        if (repo == null || record == null) {
            Log.w(TAG, "submitComplaint with no repo or transaction record")
            _state.update { it.copy(complaintSubmission = ComplaintSubmissionState.Failed("no transaction context")) }
            return
        }
        if (items.isEmpty()) {
            _state.update { it.copy(complaintSubmission = ComplaintSubmissionState.Failed("no items selected")) }
            return
        }
        _state.update { it.copy(complaintSubmission = ComplaintSubmissionState.Submitting) }
        viewModelScope.launch {
            val payload = ComplaintPayload(
                tradeNo = record.tradeNo,
                items = items.map { ComplaintItem(it.goodsId, it.name, it.priceIsk) },
                note = note?.takeIf { it.isNotBlank() },
                customerEmail = customerEmail.trim(),
                timestampMs = System.currentTimeMillis(),
                kioskAppVersion = isl.snudursopi.vending.BuildConfig.VERSION_NAME,
                kioskOsLocale = java.util.Locale.getDefault().toString(),
            )
            val result = repo.submitOrQueue(payload)
            val newState = when (result) {
                is ComplaintRepository.SubmitResult.Accepted ->
                    ComplaintSubmissionState.Accepted(complaintId = result.complaintId, queued = false)
                ComplaintRepository.SubmitResult.Queued ->
                    ComplaintSubmissionState.Accepted(complaintId = null, queued = true)
                is ComplaintRepository.SubmitResult.Rejected ->
                    ComplaintSubmissionState.Failed(reason = result.message)
                ComplaintRepository.SubmitResult.Unauthorized ->
                    ComplaintSubmissionState.Failed(reason = "auth")
            }
            _state.update { it.copy(complaintSubmission = newState) }
        }
    }

    /** Reset complaint submission state — call when navigating away from
     *  the complaint flow so a stale Accepted state doesn't show on next entry. */
    fun resetComplaintSubmissionState() {
        _state.update { it.copy(complaintSubmission = ComplaintSubmissionState.Idle) }
    }

    /** Opportunistic flush — called after any backend interaction that
     *  proves the network's reachable. */
    fun flushComplaintQueueOpportunistically() {
        val repo = complaintRepo ?: return
        viewModelScope.launch { repo.flushQueue() }
    }

    fun cycleLanguage() {
        _state.update {
            it.copy(
                language = LanguageCycle.next(
                    current = it.language,
                    available = it.settings.availableLanguages,
                ),
            )
        }
    }

    fun showContactOverlay() {
        _state.update { it.copy(showContact = true) }
    }

    fun hideContactOverlay() {
        _state.update { it.copy(showContact = false) }
    }

    private fun startClockTick() {
        viewModelScope.launch {
            while (true) {
                val now = LocalTime.now()
                val timeStr = "%02d:%02d".format(now.hour, now.minute)
                val isEvening = now.hour < 6 || now.hour >= 18
                _state.update { it.copy(currentTime = timeStr, isEvening = isEvening) }
                delay(30_000L)
            }
        }
    }

    // ---------- proxy lifecycle ----------
    //
    // Temporary while Weimi WAF blocks the backend's Railway IP. See
    // isl.snudursopi.vending.proxy.BackendConfig for deletion notes.

    /**
     * Ensure the proxy is running for this deviceCode. Called on each
     * successful catalog load — re-entrant and idempotent.
     *
     * The proxy needs the kiosk's `machineKey`, resolved by
     * [resolveMachineKey]: the key typed at setup, else the build-time key.
     *
     * A 401 here is NOT benign, whatever this comment used to claim.
     * [ProxyClient] treats 401/403 as a hard failure and stops reconnecting
     * permanently — the machine goes silent to the backend and stays silent
     * until the app is restarted with a correct key. On a machine without adb
     * or OTA that means a site visit. The old wording ("fails gracefully and
     * the kiosk keeps working") described the local UI, not the connection,
     * and it cost real debugging time in August 2026.
     */
    private fun ensureProxyStarted(deviceCode: String, weimiClient: WeimiApiClient) {
        if (proxyClient != null) return
        val machineKey = resolveMachineKey(deviceCode)
        val dispatcher = ProxyDispatcher(weimiClient.http)
        val client = ProxyClient(
            deviceCode = deviceCode,
            machineKey = machineKey,
            dispatcher = dispatcher,
        )
        proxyClient = client
        // Mirror proxy state into VendingState so diagnostics can show it.
        viewModelScope.launch {
            client.state.collect { proxyState ->
                _state.update { it.copy(proxyState = proxyState) }
            }
        }
        client.start()

        // Build complaint repository with the same machineKey resolution.
        // The repo also gets a chance to flush any queued complaints from a
        // previous app run.
        if (complaintRepo == null) {
            val repo = complaintRepoFactory(machineKey, deviceCode)
            complaintRepo = repo
            viewModelScope.launch {
                repo.init()
                // Mirror queue size into VendingState for diagnostics
                repo.queueSize.collect { size ->
                    _state.update { it.copy(complaintQueueSize = size) }
                }
            }
            // Opportunistic flush — if queue has items from a prior session,
            // try to drain them now that we know the network's reachable.
            viewModelScope.launch { repo.flushQueue() }
        }

        // Same lifecycle for the sales repository (the kiosk's required input
        // under the stock-ownership contract). Created once we have a key +
        // device code; replays any sales queued in a prior run.
        if (salesRepo == null) {
            val repo = salesRepoFactory(machineKey, deviceCode)
            salesRepo = repo
            viewModelScope.launch {
                repo.init()
                repo.queueSize.collect { size ->
                    _state.update { it.copy(salesQueueSize = size) }
                }
            }
            viewModelScope.launch { repo.flushQueue() }
        }
    }

    /**
     * Resolve featured goodsIds against the live catalog, in the order the
     * backend already applied (ConfigClient sorts by `order` ascending).
     * Skips any entry whose product is missing from the catalog or not
     * customer-visible (out of stock / hidden). Per the hero brief: an
     * empty result means show NO hero — there is no fake default fallback.
     */
    private fun resolveHeroes(
        featured: List<FeaturedProduct>,
        products: List<Product>,
    ): List<HeroLine> = featured.mapNotNull { fp ->
        products.firstOrNull { it.id == fp.goodsId && it.isVisibleToCustomer }
            ?.let { HeroLine(product = it, tag = fp.tag) }
    }

    /**
     * Recurring config poll. This is BOTH the source of live hero/config
     * updates AND the presence heartbeat — the backend records "last seen"
     * on any authenticated call (including a 304), so a poll returning 304
     * still counts as the machine being alive.
     *
     * Per the provisioning/presence contract:
     *  - Polls every [CONFIG_POLL_INTERVAL_MS]. Backend's alive-threshold
     *    is >= 2x this, so a single missed tick must NOT change state and
     *    must NOT trigger a backoff that would break the 2x margin.
     *  - Changed config (200): re-resolve heroes against the CURRENT
     *    catalog and update state. ETag is cached in fetchFeaturedFromConfig.
     *  - Unchanged (304) or a single failed tick: keep cached heroes, wait
     *    for the next tick. No state thrash, no backoff.
     *
     * Idempotent: cancels any existing poll before starting, so a re-load
     * never stacks pollers.
     */
    /** Recompute the customer grid from the current catalog, grid order, and
     *  closed aisles. Used after a set_aisle_enabled command for instant effect. */
    /**
     * Overlay the backend's current count onto a Weimi-built catalog, for
     * `kiosk` machines only. `weimi` machines keep their Weimi stock unchanged.
     * Backend count replaces the Weimi figure (including 0 = emptied); a product
     * absent from the backend map keeps its existing count as a safe fallback.
     */
    private fun List<Product>.withBackendStock(): List<Product> {
        if (stockSource != "kiosk" || backendStock.isEmpty()) return this
        return map { p -> p.copy(stock = backendStock[p.id] ?: p.stock) }
    }

    /**
     * Prefer the backend's hosted, normalized image over the machine's local Weimi
     * one. A product absent from the backend map (not migrated yet) keeps its Weimi
     * image, so tiles never go missing mid-rollout. Applies to all machines — unlike
     * stock, image hosting isn't tied to stockSource.
     */
    private fun List<Product>.withBackendImages(): List<Product> {
        if (backendImages.isEmpty()) return this
        return map { p ->
            val img = backendImages[p.id] ?: return@map p
            p.copy(imagePath = img.url, imageHasBackground = img.hasBackground)
        }
    }

    /**
     * Apply the [localVends] working count: reduce each product's stock by the
     * vends seen since the last fresh baseline, so the grid renders sold-out
     * from the live local count rather than the (possibly stale) config count.
     */
    private fun List<Product>.withLocalVends(): List<Product> {
        if (localVends.isEmpty()) return this
        return map { p ->
            val v = localVends[p.id] ?: 0
            if (v > 0) p.copy(stock = (p.stock - v).coerceAtLeast(0)) else p
        }
    }

    private fun rebuildVisibleProducts() {
        val catalog = _state.value.catalog
        val visible = catalog.withLocalVends().forCustomerDisplay(lastConfig.gridOrder, disabledAisles)
        Log.i(TAG, "rebuild: disabledAisles=$disabledAisles visible=${visible.size}/${catalog.size} " +
            "slots=${catalog.take(6).joinToString { it.slot }}")
        _state.update { it.copy(visibleProducts = visible) }
    }

    /** Apply the desired drop-sensor mode to the board if motor + config ready. */
    private fun applyDropSensorIfPossible() {
        val on = desiredDropSensorOn ?: return
        val m = motor ?: return
        try {
            m.setInfraredState(on)
            Log.i(TAG, "drop sensor applied: ${if (on) "on" else "off"}")
        } catch (t: Throwable) {
            Log.w(TAG, "applyDropSensor failed: ${t.message}")
        }
    }

    /**
     * Diagnostics temperature probe. Reads the cooling board through the *live*
     * controller (so it works on a deployed machine, where the bench test
     * screen can't share the serial port) and surfaces the decoded result.
     * The decode offsets are unverified on real chilled hardware — this is how
     * we confirm them against the cabinet's actual temperature.
     */
    fun probeTemperature() {
        viewModelScope.launch {
            _state.update { it.copy(lastTempProbe = "les…") }
            val text = withContext(Dispatchers.IO) {
                val m = motor ?: return@withContext "vélbúnaður ekki ræstur"
                m.readTemperatureBlocking()?.detail ?: "ekkert svar frá kæliborði"
            }
            _state.update { it.copy(lastTempProbe = text) }
        }
    }

    /** Diagnostics: write the cooling setpoint (°C). Verification path before
     *  this becomes a remote dashboard command. */
    fun setCoolingTemp(tempC: Double) {
        viewModelScope.launch {
            val msg = withContext(Dispatchers.IO) {
                val m = motor ?: return@withContext "vélbúnaður ekki ræstur"
                m.setTemperature(0, tempC)
                "sett hitastig %.1f°C".format(tempC)
            }
            _state.update { it.copy(lastCoolingAction = msg) }
        }
    }

    /** Diagnostics: turn the compressor on/off. */
    fun setCooling(on: Boolean) {
        viewModelScope.launch {
            val msg = withContext(Dispatchers.IO) {
                val m = motor ?: return@withContext "vélbúnaður ekki ræstur"
                m.setCompressor(0, on)
                "kæling " + if (on) "á" else "af"
            }
            _state.update { it.copy(lastCoolingAction = msg) }
        }
    }

    /** Diagnostics: trigger a defrost cycle. */
    fun triggerDefrost() {
        viewModelScope.launch {
            val msg = withContext(Dispatchers.IO) {
                val m = motor ?: return@withContext "vélbúnaður ekki ræstur"
                m.triggerDefrost(0)
                "afísun ræst"
            }
            _state.update { it.copy(lastCoolingAction = msg) }
        }
    }

    /** Manual self-update check (Diagnostics). Bypasses the WiFi/idle/backoff
     *  guards — a deliberate press always tries. Reports Device Owner + outcome. */
    fun checkForUpdate() {
        viewModelScope.launch {
            _state.update { it.copy(lastUpdateCheck = "leita að uppfærslu…") }
            val owner = appUpdater.isDeviceOwner()
            val dc = _state.value.deviceCode
            if (dc == null) {
                _state.update { it.copy(lastUpdateCheck = "vél ekki skráð", isDeviceOwner = owner) }
                return@launch
            }
            val url = AppUpdater.manifestUrl(AdminBackendConfig.BASE_URL, dc)
            val key = resolveMachineKey(dc)
            val result = withContext(Dispatchers.IO) {
                appUpdater.checkAndUpdate(url, key, dc, manual = true)
            }
            val text = when (result) {
                is UpdateResult.UpToDate -> "engin ný útgáfa (device owner: ${if (owner) "já" else "nei"})"
                is UpdateResult.Halted -> "útgáfa í bið (rollout slökkt)"
                is UpdateResult.NotTargeted -> "þessi vél er ekki á uppfærslulista"
                is UpdateResult.Installing -> "sæki + set upp ${result.versionName}…"
                is UpdateResult.NotDeviceOwner -> "EKKI device owner — getur ekki uppfært sjálfkrafa"
                is UpdateResult.Error -> "villa: ${result.detail}"
            }
            _state.update { it.copy(lastUpdateCheck = text, isDeviceOwner = owner) }
        }
    }

    /**
     * Background self-update. Every [UPDATE_CHECK_INTERVAL_MS] it checks the
     * manifest and installs a blessed newer build silently — but only on WiFi
     * (un-metered) and only when idle (never mid-payment), so it never burns
     * cellular data or interrupts a sale. The manifest's rolloutEnabled /
     * deviceAllowlist gates (handled in AppUpdater) decide whether this machine
     * actually takes it.
     */
    private fun startUpdateLoop(deviceCode: String) {
        updateJob?.cancel()
        // Reflect Device Owner status in Diagnostics immediately, not just after a tap.
        _state.update { it.copy(isDeviceOwner = appUpdater.isDeviceOwner()) }
        // If this build is here because it rolled back a crash-looping update, tell the
        // backend once (best-effort; retries next start if it fails).
        val rejected = RecoveryGuard.pendingRevertReport(appContext)
        if (rejected != 0) {
            viewModelScope.launch {
                try {
                    val http = AdminBackendHttp(AdminBackendConfig.BASE_URL, resolveMachineKey(deviceCode))
                    http.postJson(
                        "/api/v1/machines/$deviceCode/revert-report",
                        mapOf(
                            "rejectedVersionCode" to rejected,
                            "revertedVersionCode" to RecoveryGuard.revertedToCode(appContext),
                        ),
                    )
                    RecoveryGuard.markRevertReported(appContext, rejected)
                    Log.i(TAG, "reported revert of $rejected to backend")
                } catch (e: Exception) {
                    Log.w(TAG, "revert-report failed (will retry next start): ${e.message}")
                }
            }
        }
        updateJob = viewModelScope.launch {
            val url = AppUpdater.manifestUrl(AdminBackendConfig.BASE_URL, deviceCode)
            val key = resolveMachineKey(deviceCode)
            // First check soon after start, then hourly. An hour's silence after every
            // restart made a rollout a guessing game; five minutes is enough for the
            // catalog and the proxy to settle.
            var wait = FIRST_UPDATE_CHECK_MS
            while (isActive) {
                delay(wait)
                wait = UPDATE_CHECK_INTERVAL_MS
                if (_state.value.paymentPhase != PaymentPhase.Idle) {
                    Log.i(TAG, "update check skipped: payment in progress")
                    continue
                }
                // No metered gate. Grótta's Wi-Fi comes from a SIM router that Android
                // flags metered (its capabilities carry no NOT_METERED), so from
                // 0.72 to 0.80.2 the check was skipped every hour on both machines,
                // silently, and OTA never happened there. The SIM is the operator's,
                // and an update is ~25 MB a few times a month. Logged either way, so
                // a machine that never checks can no longer be mistaken for one that
                // has nothing to fetch.
                if (!appUpdater.isUnmetered()) Log.i(TAG, "update check on a metered network — proceeding")
                val r = withContext(Dispatchers.IO) {
                    appUpdater.checkAndUpdate(url, key, deviceCode, manual = false)
                }
                Log.i(TAG, "update check: ${describe(r)}")
            }
        }
    }

    /**
     * Pull pending backend commands and execute them on the hardware, posting
     * a result for each. Idempotent: an id we've already run is skipped (the
     * backend also treats the first result as final). Runs on the config poll
     * schedule; hardware calls are moved to IO since they block.
     */
    private suspend fun runPendingCommands(deviceCode: String) {
        val machineKey = resolveMachineKey(deviceCode)
        val http = AdminBackendHttp(AdminBackendConfig.BASE_URL, machineKey)
        val client = MachineCommandsClient(http)
        val pending = try {
            client.fetchPending(deviceCode)
        } catch (e: Exception) {
            Log.w(TAG, "command poll failed: ${e.message}")
            return
        }
        if (pending.isEmpty()) return
        for (cmd in pending) {
            if (cmd.id in executedCommandIds) continue  // already ran
            // Restart commands (Channel B) don't touch the motor — handle them
            // before the motor-not-ready deferral below.
            if (cmd.type == "restart_app" || cmd.type == "restart_machine") {
                handleRestartCommand(client, deviceCode, cmd)
                continue
            }
            // The remaining command types need the motor; if it isn't up yet,
            // leave the command pending for a later tick rather than posting a
            // premature "failed" (the backend treats the first result as final).
            // dispense_log is exempt: it only reads an in-memory buffer, and it
            // is most useful precisely when the hardware is misbehaving.
            if (motor == null && cmd.type != "dispense_log" && cmd.type != "config_health" &&
                cmd.type != "set_machine_key") {
                Log.i(TAG, "command ${cmd.id} deferred — motor not up yet")
                continue
            }
            executedCommandIds.add(cmd.id)
            Log.i(TAG, "running command ${cmd.id} type=${cmd.type}")
            val result = withContext(Dispatchers.IO) { executeCommand(cmd) }
            try {
                client.postResult(deviceCode, cmd.id, result)
                Log.i(TAG, "command ${cmd.id} result posted: ${result["status"]}")
            } catch (e: Exception) {
                // Let it retry on a later tick: drop from executed so we run again.
                executedCommandIds.remove(cmd.id)
                Log.w(TAG, "posting result for ${cmd.id} failed: ${e.message}")
            }
        }
    }

    /**
     * Handle a Channel-B restart command. restart_app does a real process
     * restart (acked first, with a persisted id-guard so a re-delivery after
     * the process dies can't loop). restart_machine can't reboot the tablet on
     * this hardware (no root, no SDK reboot, not device owner), so it acks a
     * descriptive failure the operator can see in the dashboard.
     */
    private suspend fun handleRestartCommand(
        client: MachineCommandsClient,
        deviceCode: String,
        cmd: MachineCommandsClient.Command,
    ) {
        val now = java.time.Instant.now().toString()
        when (cmd.type) {
            "restart_app" -> {
                // Persist the id BEFORE acting; a re-delivery after the process
                // dies will see it and re-ack instead of restarting again.
                val firstTime = restartManager.shouldRestartForCommand(cmd.id)
                val acked = try {
                    client.postResult(
                        deviceCode, cmd.id,
                        mapOf(
                            "status" to "ok",
                            "detail" to if (firstTime) "restarting app" else "already restarted",
                            "completedAt" to now,
                        ),
                    )
                    true
                } catch (e: Exception) {
                    Log.w(TAG, "restart_app ack failed (${cmd.id}): ${e.message}")
                    false
                }
                if (firstTime) {
                    Log.i(TAG, "restart_app ${cmd.id} — restarting process")
                    restartManager.performProcessRestart()  // does not return
                } else if (acked) {
                    executedCommandIds.add(cmd.id)  // re-ack landed; stop reprocessing
                }
                // !firstTime && !acked → leave unmarked so the re-ack retries.
            }
            "restart_machine" -> {
                val acked = try {
                    client.postResult(
                        deviceCode, cmd.id,
                        mapOf(
                            "status" to "failed",
                            "detail" to "reboot_not_permitted",
                            "completedAt" to now,
                        ),
                    )
                    true
                } catch (e: Exception) {
                    Log.w(TAG, "restart_machine ack failed (${cmd.id}): ${e.message}")
                    false
                }
                if (acked) executedCommandIds.add(cmd.id)
            }
        }
    }

    /** Execute one command on the hardware, returning the result body. */
    private suspend fun executeCommand(cmd: MachineCommandsClient.Command): Map<String, Any?> {
        val now = java.time.Instant.now().toString()
        val m = motor
        return when (cmd.type) {
            "query_channel_status" -> {
                if (m == null) return mapOf(
                    "status" to "failed", "detail" to "motor not started", "completedAt" to now,
                )
                val frames = m.queryAllChannelStatusBlocking()
                mapOf(
                    "status" to "ok",
                    "detail" to "queryAllChannelStatus returned ${frames.size} frame(s)",
                    // Raw board frames, verbatim — backend defines the shape from these.
                    "channelStatus" to frames,
                    "completedAt" to now,
                )
            }
            "set_drop_sensor" -> {
                if (m == null) return mapOf(
                    "status" to "failed", "detail" to "motor not started", "completedAt" to now,
                )
                val enabled = cmd.params?.get("enabled")?.asBoolean() ?: false
                m.setInfraredState(enabled)
                desiredDropSensorOn = enabled
                mapOf(
                    "status" to "ok",
                    "detail" to "drop sensor set ${if (enabled) "on" else "off"}",
                    "completedAt" to now,
                )
            }
            "set_aisle_enabled" -> {
                val aisle = cmd.params?.get("aisle")?.asText()
                    ?.let { isl.snudursopi.vending.api.SlotCodeTranslator.normalize(it) }
                    ?: return mapOf(
                        "status" to "failed", "detail" to "missing aisle", "completedAt" to now,
                    )
                val enabled = cmd.params.get("enabled")?.asBoolean() ?: true
                // Update the in-memory closed set for INSTANT effect; config
                // remains the durable source of truth on the next poll.
                disabledAisles = if (enabled) disabledAisles - aisle else disabledAisles + aisle
                Log.i(TAG, "set_aisle_enabled raw='${cmd.params.get("aisle")?.asText()}' " +
                    "normalized='$aisle' enabled=$enabled -> disabledAisles=$disabledAisles")
                rebuildVisibleProducts()
                mapOf(
                    "status" to "ok",
                    "detail" to "aisle $aisle ${if (enabled) "opened" else "closed"}",
                    "completedAt" to now,
                )
            }

            "clear_aisle_fault" -> {
                // A remote fault-clear must NEVER turn a motor / eject product. The
                // board holds no per-lane "clear fault" command (isBroken is Weimi-cloud
                // state), so the only safe thing the kiosk can do is READ channel status
                // — no motor movement. The actual "mark this bay working again" belongs
                // on the backend (clear its own broken badge once the operator has fixed
                // the jam). We report the raw board status so the backend/operator can
                // see the lane state without ejecting anything.
                val aisle = cmd.params?.get("aisle")?.asText()
                    ?.let { isl.snudursopi.vending.api.SlotCodeTranslator.normalize(it) }
                    ?: return mapOf(
                        "status" to "failed", "detail" to "missing aisle", "completedAt" to now,
                    )
                val m = motor ?: return mapOf(
                    "status" to "failed", "detail" to "hardware not ready", "completedAt" to now,
                )
                // Query-only: reads lane status, does not move any motor.
                val statuses = try {
                    m.queryAllChannelStatusBlocking()
                } catch (e: Exception) {
                    Log.w(TAG, "clear_aisle_fault query failed: ${e.message}")
                    emptyList()
                }
                Log.i(TAG, "clear_aisle_fault(query, no dispense) aisle=$aisle channelStatus=$statuses")
                mapOf(
                    "status" to "ok",
                    "detail" to "aisle $aisle status queried (no dispense): " +
                        statuses.joinToString(",").take(160).ifBlank { "no status returned" },
                    "completedAt" to now,

                )
            }
            "test_vend" -> {
                // The ONLY remote command that turns a motor and ejects product.
                // Every guard below exists because of that. Read them as a set:
                //   1. the aisle must be CLOSED (in disabledAisles) — so a remote
                //      command can never eject from a lane that is on sale. This
                //      also matches how it's used: we characterise a lane while
                //      it's closed, then open it once we trust it.
                //   2. no customer session in flight — never vend into someone
                //      else's transaction.
                // The result deliberately returns the RAW result code, because
                // "VENDED"/"MOTOR_FAILED" is exactly the information we're trying
                // to look behind.
                if (m == null) return mapOf(
                    "status" to "failed", "detail" to "motor not started", "completedAt" to now,
                )
                val rawAisle = cmd.params?.get("aisle")?.asText()
                    ?: return mapOf(
                        "status" to "failed", "detail" to "missing aisle", "completedAt" to now,
                    )
                val aisle = isl.snudursopi.vending.api.SlotCodeTranslator.normalize(rawAisle)
                    ?: return mapOf(
                        "status" to "failed",
                        "detail" to "could not decode aisle \"$rawAisle\" — send a friendly code " +
                            "(A51) or a Weimi code (0-E00)",
                        "completedAt" to now,
                    )
                if (aisle !in disabledAisles) return mapOf(
                    "status" to "failed",
                    "detail" to "aisle $aisle is OPEN — close it first (test_vend only " +
                        "runs on a closed aisle, so it can never eject from a lane on sale)",
                    "completedAt" to now,
                )
                val st = _state.value
                if (st.paymentPhase != PaymentPhase.Idle || st.basket.lines.isNotEmpty()) return mapOf(
                    "status" to "failed",
                    "detail" to "machine busy (phase=${st.paymentPhase}, " +
                        "${st.basket.lines.size} line(s) in basket) — retry when idle",
                    "completedAt" to now,
                )
                val raw = isl.snudursopi.vending.api.SlotCodeTranslator.friendlyToRaw(aisle)
                    ?: return mapOf(
                        "status" to "failed",
                        "detail" to "aisle $aisle has no raw slot mapping",
                        "completedAt" to now,
                    )
                // Optional channelType sweep. Absent = SDK default (what spirals
                // have always used). Present = try that mechanism value on this
                // lane — the way we find out what a direct-push lane wants.
                val channelType = cmd.params?.get("channelType")?.takeIf { !it.isNull }?.asInt()
                val res = m.dispenseBlocking(
                    address = 0,
                    slot = raw,
                    timeoutMs = 8000,
                    channelType = channelType,
                )
                recordDispense(raw, res, test = true)
                val hex = res.resultCode?.let { "0x%02x".format(it) }
                Log.i(TAG, "test_vend aisle=$aisle raw=$raw → ${res.outcome} code=$hex (${res.detail})")
                mapOf(
                    "status" to "ok",
                    "detail" to "aisle $aisle (raw $raw, channelType=" +
                        (channelType?.toString() ?: "default") + ") → ${res.outcome}" +
                        (hex?.let { " code $it" } ?: " no code") + " — ${res.detail}",
                    "channelType" to channelType,
                    "aisle" to aisle,
                    "rawSlot" to raw,
                    "outcome" to res.outcome.name,
                    "resultCode" to res.resultCode,
                    "resultCodeHex" to hex,
                    "boardDetail" to res.detail,
                    "orderId" to res.orderId,
                    "completedAt" to now,
                )
            }

            "dispense_log" -> {
                // Read-only. Returns the last DISPENSE_LOG_MAX dispenses with the
                // board's raw result code intact — real customer vends and
                // test_vends alike, newest last. Needs no motor, so it answers
                // even on a machine whose board is unhappy.
                val entries = dispenseLog.toList().map { r ->
                    mapOf(
                        "at" to r.at,
                        "aisle" to r.aisle,
                        "rawSlot" to r.slot,
                        "outcome" to r.outcome,
                        "resultCode" to r.resultCode,
                        "resultCodeHex" to r.resultCode?.let { "0x%02x".format(it) },
                        "detail" to r.detail,
                        "test" to r.test,
                    )
                }
                mapOf(
                    "status" to "ok",
                    "detail" to "${entries.size} dispense record(s) since app start",
                    "dispenses" to entries,
                    "completedAt" to now,
                )
            }

            "set_machine_key" -> {
                // Migration path for machines provisioned by the old
                // per-machine-build route. While such a machine still has a
                // WORKING baked-in key, the backend can push the same key into
                // DataStore; after that a single generic apk can update it over
                // OTA without losing its credential.
                //
                // Without this, shipping a generic apk to the fleet would 401
                // every machine at once, and each one would need a physical
                // visit to re-run setup.
                //
                // Guards: the caller must name the deviceCode it thinks it is
                // talking to, and it must match this machine. A key belonging
                // to a different machine would take effect on the next backend
                // call and hard-fail the proxy for good — recoverable only on
                // site. Matching the deviceCode makes a mispaired key
                // essentially impossible.
                val forDevice = cmd.params?.get("deviceCode")?.asText()
                val newKey = cmd.params?.get("machineKey")?.asText()?.trim()
                if (forDevice.isNullOrBlank() || newKey.isNullOrBlank()) return mapOf(
                    "status" to "failed",
                    "detail" to "both deviceCode and machineKey are required",
                    "completedAt" to now,
                )
                val myDeviceCode = _state.value.deviceCode
                if (forDevice != myDeviceCode) return mapOf(
                    "status" to "failed",
                    "detail" to "refusing: command targets $forDevice but this machine is $myDeviceCode",
                    "completedAt" to now,
                )
                if (!newKey.startsWith("mk_") || newKey.length < 20) return mapOf(
                    "status" to "failed",
                    "detail" to "refusing: machineKey does not look like a key (mk_…, >= 20 chars)",
                    "completedAt" to now,
                )
                deviceIdentity.setMachineKey(newKey)
                storedMachineKey = newKey
                Log.i(TAG, "machineKey stored via backend command (${newKey.take(8)}…)")
                mapOf(
                    "status" to "ok",
                    "detail" to "machine key stored; it will be used from the next backend call",
                    "keyPrefix" to newKey.take(8),
                    "completedAt" to now,
                )
            }

            "config_health" -> {
                // Read-only, no hardware. Answers one question remotely: does this
                // kiosk agree with the backend about which lanes are closed?
                //
                // It exists because this machine is sideloaded — no adb, no log
                // relay — so the WARN we write when a closed lane fails to decode
                // lands in a logcat nobody can reach. A lane that silently failed
                // to decode is a lane still taking money, so it needs a channel
                // that works from a phone.
                mapOf(
                    "status" to "ok",
                    "detail" to if (undecodableAisles.isEmpty()) {
                        "${disabledAisles.size} closed lane(s), all decoded"
                    } else {
                        "WARNING: could not decode $undecodableAisles — those lanes are " +
                            "NOT closed and are still on sale"
                    },
                    "closedAisles" to disabledAisles.toList().sorted(),
                    "undecodableAisles" to undecodableAisles,
                    "columnBaseZero" to isl.snudursopi.vending.api.SlotCodeTranslator.columnBaseZero,
                    "stockSource" to stockSource,
                    "keySource" to keySource,
                    "directPushRows" to directPushRows.sorted(),
                    "dropSensorOverride" to dropSensorOverrideValue(),
                    "lanesPerRow" to isl.snudursopi.vending.api.SlotCodeTranslator.lanesPerRow
                        .toSortedMap().toString(),
                    "dropSensorDesiredOn" to desiredDropSensorOn,
                    "versionName" to isl.snudursopi.vending.BuildConfig.VERSION_NAME,
                    "versionCode" to isl.snudursopi.vending.BuildConfig.VERSION_CODE,
                    "configAppliedAt" to lastConfigAppliedAt,
                    "completedAt" to now,
                )
            }

            "set_temp" -> {
                if (m == null) return mapOf(
                    "status" to "failed", "detail" to "motor not started", "completedAt" to now,
                )
                val node = cmd.params?.get("targetC")
                if (node == null || !node.isNumber) return mapOf(
                    "status" to "failed", "detail" to "missing/invalid targetC", "completedAt" to now,
                )
                val whole = Math.round(node.asDouble()).toInt()
                // Defensive range guard — a remote command shouldn't be able to
                // cook or freeze stock via a fat-fingered value.
                if (whole < 1 || whole > 15) return mapOf(
                    "status" to "failed",
                    "detail" to "targetC ${whole}°C out of safe range (1–15)",
                    "completedAt" to now,
                )
                m.setTemperature(0, whole.toDouble())
                // Confirm against the board's stored setpoint (read-back).
                val readBack = m.readTemperatureBlocking()?.setpointC
                mapOf(
                    "status" to "ok",
                    "detail" to "setpoint ${whole}°C" +
                        if (readBack != null) " (board reports ${readBack}°C)" else " (no read-back)",
                    "completedAt" to now,
                )
            }
            "set_cooling" -> {
                if (m == null) return mapOf(
                    "status" to "failed", "detail" to "motor not started", "completedAt" to now,
                )
                val on = cmd.params?.get("on")?.asBoolean() ?: return mapOf(
                    "status" to "failed", "detail" to "missing 'on'", "completedAt" to now,
                )
                m.setCompressor(0, on)
                mapOf(
                    "status" to "ok",
                    "detail" to "cooling ${if (on) "on" else "off"}",
                    "completedAt" to now,
                )
            }
            "defrost" -> {
                if (m == null) return mapOf(
                    "status" to "failed", "detail" to "motor not started", "completedAt" to now,
                )
                m.triggerDefrost(0)
                mapOf(
                    "status" to "ok",
                    "detail" to "defrost cycle triggered",
                    "completedAt" to now,
                )
            }
            "check_update" -> {
                // The dashboard's "check for update" button, until now fridge-only. A
                // manual check bypasses the updater's attempted-set, so a build that was
                // tried once can be tried again on request.
                val code = _state.value.deviceCode ?: return mapOf(
                    "status" to "failed", "detail" to "no device code", "completedAt" to now,
                )
                val r = withContext(Dispatchers.IO) {
                    appUpdater.checkAndUpdate(
                        AppUpdater.manifestUrl(AdminBackendConfig.BASE_URL, code),
                        resolveMachineKey(code), code, manual = true,
                    )
                }
                Log.i(TAG, "update check (dashboard): ${describe(r)}")
                mapOf(
                    "status" to if (r is UpdateResult.Error) "failed" else "ok",
                    "detail" to describe(r),
                    "installed" to isl.snudursopi.vending.BuildConfig.VERSION_CODE,
                    "completedAt" to now,
                )
            }
            "adb_wifi" -> {
                // Wireless debugging from the dashboard (AG only; fridge 0.70.0, coil 0.80.8).
                // The answer carries the adb connect line, so nobody has to read the screen.
                val action = cmd.params?.get("action")?.asText()?.takeIf { it.isNotBlank() } ?: "status"
                val (ok, detail) = withContext(Dispatchers.IO) { AdbWifi.run(appContext, action) }
                Log.i(TAG, "adb_wifi $action: ${if (ok) "ok" else "failed"} — $detail")
                mapOf(
                    "status" to if (ok) "ok" else "failed",
                    "detail" to detail,
                    "completedAt" to now,
                )
            }
            else -> mapOf(
                "status" to "unsupported",
                "detail" to "kiosk does not implement command type '${cmd.type}' yet",
                "completedAt" to now,
            )
        }
    }

    /** One line per update outcome, for the log and the dashboard's command result. */
    private fun describe(r: UpdateResult): String = when (r) {
        is UpdateResult.UpToDate -> "up to date (${isl.snudursopi.vending.BuildConfig.VERSION_NAME})"
        is UpdateResult.Halted -> "no release for this machine, or rollout halted"
        is UpdateResult.NotTargeted -> "not in this rollout"
        is UpdateResult.Installing -> "installing ${r.versionName}"
        is UpdateResult.NotDeviceOwner -> "update available but not Device Owner: ${r.detail}"
        is UpdateResult.Error -> "failed: ${r.detail}"
    }

    /**
     * Periodically read the cooling-board temperature and report it to the
     * backend (best-effort, no queue). Cadence is [TELEMETRY_INTERVAL_MS].
     * Skipped silently when there's no reading (no cooling board / no reply) or
     * during a live payment, so a telemetry read never collides with a vend on
     * the shared serial line. Thresholds/alerting live backend-side.
     */
    /**
     * Download any listed ad that isn't on disk, drop files for ads no longer listed,
     * then swap the playable set into state. Skipped when the list is unchanged and
     * everything is cached, so the 2-minute poll costs nothing in the normal case.
     */
    private fun syncAds(config: ConfigResult) {
        val key = config.ads.joinToString("|") { it.url }
        if (key == lastAdsKey && adCache.playable(config.ads).size == config.ads.size) return
        lastAdsKey = key
        viewModelScope.launch {
            val fetched = try {
                adCache.sync(config.ads)
            } catch (e: Exception) {
                Log.w(TAG, "ad sync failed: ${e.message}")
                0
            }
            val playable = adCache.playable(config.ads)
            Log.i(TAG, "ads: $fetched downloaded, ${playable.size}/${config.ads.size} playable from disk")
            _state.update { it.copy(settings = it.settings.copy(ads = playable)) }
        }
    }

    /**
     * Report the card reader's link state and identity to the backend, as the fridge
     * app does: a dead link raises an alert, and the reader's serial shows in the
     * machine header instead of "Nayax —". See PaymentStatusReporter.
     */
    private fun startPaymentWatch(pc: isl.snudursopi.vending.hardware.nayax.MarshallPaymentController) {
        if (paymentWatchStarted) return
        val code = _state.value.deviceCode ?: return
        paymentWatchStarted = true
        viewModelScope.launch {
            val http = AdminBackendHttp(AdminBackendConfig.BASE_URL, resolveMachineKey(code))
            PaymentStatusReporter(http, code).start(this) {
                PaymentLinkStatus(
                    up = pc.isUp(),
                    port = pc.portName,
                    lastReadyAtMs = pc.lastReadyAtMs,
                    decimalPlace = pc.decimalPlace,
                    reader = pc.readerInfo,
                )
            }
        }
    }

    /**
     * An admin PIN result ('ok' or 'lockout') to the backend. Best effort: a lost 'ok' only
     * dates "last used"; a lockout (five wrong PINs) is an alert for AG — someone is guessing,
     * or a technician has the wrong one.
     */
    fun reportAdminPinEvent(type: String) {
        val code = _state.value.deviceCode ?: return
        viewModelScope.launch {
            try {
                AdminBackendHttp(AdminBackendConfig.BASE_URL, resolveMachineKey(code))
                    .postJson("/api/v1/machines/$code/admin-pin-event", mapOf("type" to type))
                Log.i(TAG, "admin PIN event reported ($type)")
            } catch (e: Exception) {
                Log.w(TAG, "admin PIN event not sent: ${e.message}")
            }
        }
    }

    /** The app's own log to the backend every 5 minutes — see LogRelay for why. */
    private fun startLogRelay(deviceCode: String) {
        if (logRelayJob?.isActive == true) return
        logRelayJob = viewModelScope.launch {
            val http = AdminBackendHttp(AdminBackendConfig.BASE_URL, resolveMachineKey(deviceCode))
            LogRelay(http, deviceCode).run()
        }
    }

    private fun startTelemetryLoop(deviceCode: String) {
        telemetryJob?.cancel()
        telemetryJob = viewModelScope.launch {
            val http = AdminBackendHttp(AdminBackendConfig.BASE_URL, resolveMachineKey(deviceCode))
            val client = TelemetryClient(http, deviceCode)
            while (isActive) {
                delay(TELEMETRY_INTERVAL_MS)
                if (_state.value.paymentPhase != PaymentPhase.Idle) continue
                val reading = try {
                    withContext(Dispatchers.IO) { motor?.readTemperatureBlocking() }
                } catch (e: Exception) {
                    Log.w(TAG, "telemetry read failed: ${e.message}")
                    null
                }
                val tempC = reading?.cabinetTempC ?: continue  // no board/reply → skip
                try {
                    client.report(
                        TelemetryPayload(
                            at = java.time.Instant.now().toString(),
                            cabinetTempC = tempC,
                            humidity = reading.humidity,
                            evaporator = reading.evaporatorRaw,
                            statusOk = reading.statusOk,
                            disabledAisles = disabledAisles.toList().sorted(),
                        ),
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "telemetry post skipped: ${e.message}")
                }
            }
        }
    }

    private fun startConfigPoll(deviceCode: String) {
        configPollJob?.cancel()
        configPollJob = viewModelScope.launch {
            // Immediate pass so an enqueued command isn't held for a full
            // interval before the first poll.
            runPendingCommands(deviceCode)
            while (true) {
                delay(CONFIG_POLL_INTERVAL_MS)
                try {
                    val config = fetchFeaturedFromConfig(deviceCode)
                    // Re-resolve against the catalog as it stands now — it
                    // may have changed since the previous poll.
                    val baseCatalog = _state.value.catalog
                    // Refresh the live count from the backend (kiosk machines);
                    // no-op for weimi machines. localVends was cleared above iff
                    // this was a fresh load, so re-baseline lands on this count.
                    // Also re-apply hosted images, so a newly-migrated product picks
                    // up its normalized image on the next poll (no reload needed).
                    val catalog = baseCatalog.withBackendStock().withBackendImages()
                    val heroes = resolveHeroes(config.featured, catalog)
                    _state.update {
                        val pOp: String = config.profile?.operatorName.orEmpty()
                        val opName: String = if (pOp.isNotBlank()) pOp else it.settings.operatorName
                        val pEmail: String = config.profile?.supportEmail.orEmpty()
                        val opEmail: String = if (pEmail.isNotBlank()) pEmail else it.settings.supportEmail
                        it.copy(
                            heroes = heroes,
                            catalog = catalog,
                            visibleProducts = catalog.withLocalVends().forCustomerDisplay(config.gridOrder, disabledAisles),
                            productDetails = config.productDetails,
                            idleCards = config.idle.cards,
                            idleRotationSeconds = config.idle.rotationSeconds,
                            idleAttractTimeoutSeconds = config.idle.attractTimeoutSeconds,
                            offers = config.offers.associateBy { it.goodsId },
                            adminPin = config.adminPin,
                            outOfService = config.outOfService,
                            outOfServiceReason = config.outOfServiceReason,
                            settings = it.settings.copy(
                                featured = config.featured,
                                operatorName = opName,
                                supportEmail = opEmail,
                                ads = adCache.playable(config.ads),
                                showAdRegion = config.showAdRegion,
                            ),
                        )
                    }
                    syncAds(config)
                    // A successful poll means the network is reachable — a good
                    // moment to drain any queued sales from an offline spell.
                    salesRepo?.let { repo -> launch { repo.flushQueue() } }
                } catch (e: Exception) {
                    // Single-tick tolerance: log, keep cache, wait for next
                    // tick. No state change, no backoff (protects the 2x
                    // presence margin).
                    Log.w(TAG, "Config poll tick failed: ${e.message} — keeping cache")
                }
                // Pull + run any pending backend commands on the same schedule.
                runPendingCommands(deviceCode)
            }
        }
    }

    /**
     * Fetch the per-machine featured list from the admin backend config.
     *
     * Degrades gracefully: on ANY failure (network, 401 placeholder key,
     * parse error) we return an empty list, which means "no hero" — never
     * the old hardcoded fake-"nýtt" default. A 304 (unchanged) also yields
     * the parsed-empty path here on first load; once the poll is running it
     * keeps the cached heroes.
     *
     * Caches [configEtag] for the next poll's If-None-Match.
     */
    /** Result of a config fetch: the bits the kiosk applies to state. */
    private data class ConfigResult(
        val featured: List<FeaturedProduct>,
        val gridOrder: List<String>,
        val productDetails: Map<String, ProductDetails> = emptyMap(),
        val profile: ConfigProfile? = null,
        val idle: IdleConfig = IdleConfig.EMPTY,
        val offers: List<Offer> = emptyList(),
        val ads: List<RemoteAd> = emptyList(),
        val showAdRegion: Boolean = true,
        val adminPin: AdminPinHash? = null,
        val outOfService: Boolean = false,
        val outOfServiceReason: String? = null,
    ) {
        companion object {
            val EMPTY = ConfigResult(emptyList(), emptyList(), emptyMap(), null)
        }
    }

    private suspend fun fetchFeaturedFromConfig(deviceCode: String): ConfigResult {
        val machineKey = resolveMachineKey(deviceCode)
        val http = AdminBackendHttp(AdminBackendConfig.BASE_URL, machineKey)
        val client = ConfigClient(http)
        // Date-based expiry deals (a batch crossing a days-left tier) change the
        // idle cards WITHOUT bumping configVersion, so a 304-only kiosk would
        // never see them. Periodically force a full (non-304) fetch so the
        // backend re-evaluates idle against the current date.
        val now = System.currentTimeMillis()
        val forceFresh = now - lastIdleFullRefreshMs >= IDLE_FULL_REFRESH_MS
        val etagToSend = if (forceFresh) null else configEtag
        val baseConfig = try {
            when (val result = client.fetch(deviceCode, etagToSend)) {
                is ConfigClient.Result.Loaded -> {
                    configEtag = result.configVersion ?: configEtag
                    lastIdleFullRefreshMs = now
                    // Re-baseline the local working count: a fresh 200 carries the
                    // backend's reconciled currStock (it has applied our reported
                    // vends), so any local decrements are now folded in.
                    localVends.clear()
                    // Adopt the backend's stock model + live counts (used to
                    // overlay the catalog for kiosk machines; no-op for weimi).
                    stockSource = result.stockSource
                    backendStock = result.stock
                    Log.i(TAG, "config seed stockSource=$stockSource stock=$backendStock")
                    // Backend-hosted normalized images (empty until migration runs).
                    backendImages = result.images
                    Log.i(TAG, "Config loaded: ${result.featured.size} featured, " +
                        "${result.gridOrder.size} gridOrder, ${result.idle.cards.size} idleCards, " +
                        "version=${result.configVersion}${if (forceFresh) " (forced refresh)" else ""}")
                    // Restart commands are handled on the pull-queue (Channel B),
                    // not these config timestamps — ignored here to avoid a double
                    // restart. See runPendingCommands / RestartManager.
                    // Drop-sensor mode: "on"→true, anything else (incl. null)→off.
                    desiredDropSensorOn = dropSensorOverride
                        ?: (result.dropSensor?.equals("on", ignoreCase = true) ?: false)
                    applyDropSensorIfPossible()
                    // Operator-closed aisles (config is the durable source of truth).
                    // REPLACE (not merge) so a re-enabled aisle actually comes back.
                    // normalize() keeps this identical to the command handler's keys.
                    disabledAisles = result.disabledAisles
                        .mapNotNull { isl.snudursopi.vending.api.SlotCodeTranslator.normalize(it) }.toSet()
                    // Kept so `config_health` can report it. A non-empty list means
                    // lanes the operator closed are STILL ON SALE here, and on a
                    // sideloaded machine that command is the only way to find out.
                    undecodableAisles = result.undecodableAisles
                    lastConfigAppliedAt = isoUtcNow()
                    Log.i(TAG, "config seed disabledAisles=$disabledAisles")
                    if (undecodableAisles.isNotEmpty()) {
                        Log.w(TAG, "config seed UNDECODABLE aisles=$undecodableAisles — those lanes are NOT closed")
                    }
                    val cfg = ConfigResult(
                        featured = result.featured,
                        gridOrder = result.gridOrder,
                        profile = result.profile,
                        idle = result.idle,
                        offers = result.offers,
                        ads = result.ads,
                        showAdRegion = result.showAdRegion,
                        adminPin = result.adminPin,
                        outOfService = result.outOfService,
                        outOfServiceReason = result.outOfServiceReason,
                    )
                    lastConfig = cfg  // remember for the next 304
                    cfg
                }
                is ConfigClient.Result.Unchanged -> {
                    // 304 — config unchanged since configEtag. Reuse the last
                    // known config; do NOT wipe featured/gridOrder.
                    Log.i(TAG, "Config 304 unchanged — reusing last config " +
                        "(${lastConfig.featured.size} featured, ${lastConfig.gridOrder.size} gridOrder)")
                    lastConfig
                }
            }
        } catch (e: BackendException) {
            // Expected today for non-Leiknir machines (placeholder key → 401).
            // Keep whatever we last had rather than wiping on a transient fail.
            Log.w(TAG, "Config fetch failed (${e.kind}): ${e.message} — keeping last config")
            lastConfig
        }

        // Product details — separate endpoint, same machine key, own etag.
        // Failures here must NOT block config/heroes/grid; details just stay
        // at the last-known map (empty until the backend serves them).
        val details = fetchProductDetails(deviceCode, http)
        return baseConfig.copy(productDetails = details)
    }

    /**
     * Fetch per-product details. Mirrors the config 304-safe pattern: a 304
     * or a transient failure reuses [lastDetails] rather than wiping. The
     * endpoint may not exist yet — a 404/401 just leaves details empty and
     * the detail screen falls back to photo-only, which is the intended
     * behavior until the backend ships it.
     */
    private suspend fun fetchProductDetails(
        deviceCode: String,
        http: AdminBackendHttp,
    ): Map<String, ProductDetails> {
        val client = ProductDetailsClient(http)
        return try {
            when (val result = client.fetch(deviceCode, detailsEtag)) {
                is ProductDetailsClient.Result.Loaded -> {
                    detailsEtag = result.version ?: detailsEtag
                    Log.i(TAG, "Product details loaded: ${result.detailsByCode.size} products, " +
                        "version=${result.version}")
                    lastDetails = result.detailsByCode
                    result.detailsByCode
                }
                is ProductDetailsClient.Result.Unchanged -> {
                    Log.i(TAG, "Product details 304 — reusing ${lastDetails.size} cached")
                    lastDetails
                }
            }
        } catch (e: BackendException) {
            Log.w(TAG, "Product details fetch failed (${e.kind}): ${e.message} — keeping last")
            lastDetails
        }
    }

    /**
     * Resolve the machineKey to send with backend requests.
     *
     * Until provisioning is wired (contract v0.1 §2.2), we need *some*
     * value to send. The resolution order is:
     *
     *   1. If [BuildConfig.TEST_MACHINE_KEY] is set AND we're running on
     *      the deviceCode it was minted for, use it. This is the
     *      side-load-only test path agreed with the backend chat.
     *   2. Otherwise, fall back to using deviceCode as a placeholder.
     *      Backend returns 401; kiosk degrades gracefully (proxy logs
     *      and stops; complaints queue with the auth error visible in
     *      diagnostics).
     *
     * Delete this whole function (and the BuildConfig fields it reads)
     * once `POST /api/v1/machines/provision` is implemented on both sides.
     */
    private fun parseRows(raw: String?): Set<Int> =
        raw.orEmpty().split(",").mapNotNull { it.trim().toIntOrNull() }
            .filter { it in 1..6 }.toSet()

    /** Called from the hardware test screen. "on" / "off" / "" to clear. */
    fun setDropSensorOverride(value: String) {
        viewModelScope.launch {
            deviceIdentity.setDropSensorOverride(value)
            dropSensorOverride = when (value.trim().lowercase()) {
                "on" -> true
                "off" -> false
                else -> null
            }
            dropSensorOverride?.let { desiredDropSensorOn = it }
            applyDropSensorIfPossible()
            Log.i(TAG, "drop sensor override set to '$value' → desired=$desiredDropSensorOn")
        }
    }

    fun dropSensorOverrideValue(): String = when (dropSensorOverride) {
        true -> "on"
        false -> "off"
        null -> ""
    }

    /** Called from the hardware test screen. */
    fun setDirectPushRows(rows: String) {
        viewModelScope.launch {
            deviceIdentity.setDirectPushRows(rows)
            directPushRows = parseRows(rows)
            Log.i(TAG, "direct-push rows set to $directPushRows")
        }
    }

    fun directPushRowsCsv(): String = directPushRows.sorted().joinToString(",")

    /**
     * Is this raw slot on a direct-push row, and did the board give the
     * "delivered but never turned" code? Measured at Faxatorg: a push that
     * physically delivered reported 0x05, while a spiral that delivered
     * reported 0x00 — so this exception must stay confined to these rows.
     */
    private fun countsAsDirectPushVend(rawSlot: Int, code: Int?): Boolean {
        if (code != 0x05) return false
        val row = rawSlot / 10 + 1
        return row in directPushRows
    }

    private fun resolveMachineKey(deviceCode: String): String {
        // Order matters. The key typed at setup wins, always: it is the one
        // that belongs to THIS machine and it lets a single apk serve the
        // whole fleet.
        //
        // The BuildConfig key is kept only as a fallback so that machines
        // provisioned by the old per-machine-build route keep working when
        // they take this update. Do not add a third source; the reason this
        // function used to hand back the deviceCode as a "placeholder" is
        // that there was nowhere else to look, and a wrong key fails in a
        // particularly nasty way — the backend 401s and ProxyClient marks the
        // connection hard-failed and stops reconnecting for good.
        storedMachineKey?.let {
            keySource = "stored"
            return it
        }
        val testKey = isl.snudursopi.vending.BuildConfig.TEST_MACHINE_KEY
        val testDeviceCode = isl.snudursopi.vending.BuildConfig.TEST_MACHINE_DEVICE_CODE
        return if (testKey.isNotBlank() && testDeviceCode == deviceCode) {
            Log.i(TAG, "Using build-time machineKey for deviceCode=$deviceCode")
            keySource = "build"
            testKey
        } else {
            if (testKey.isNotBlank()) {
                Log.w(TAG, "Build-time key is for a different deviceCode " +
                    "(this=$deviceCode, configured-for=$testDeviceCode) — no usable key. " +
                    "Re-run setup on this machine to enter its key.")
            }
            keySource = "none"
            deviceCode  // will 401; there is no key for this machine
        }
    }

    /** Stop the proxy and clear the reference. Called on phase exits. */
    private fun stopProxy() {
        proxyClient?.shutdown()
        proxyClient = null
        _state.update { it.copy(proxyState = ProxyState(status = ProxyState.Status.Idle)) }
    }

    /** Manual reconnect — exposed for diagnostics screen. */
    fun reconnectProxy() {
        proxyClient?.forceReconnect()
    }

    override fun onCleared() {
        super.onCleared()
        proxyClient?.shutdown()
        rearmJob?.cancel()
        idleJob?.cancel()
        try { marshall?.disconnect() } catch (_: Throwable) {}
        try { motor?.stop() } catch (_: Throwable) {}
    }

    companion object {
        private const val TAG = "VendingViewModel"

        /**
         * How many dispense records to keep in memory for `dispense_log`.
         * Sized for a diagnostics window, not an audit trail — the durable
         * record of a sale is the sales report, not this.
         */
        private const val DISPENSE_LOG_MAX = 50

        /**
         * Config poll interval — also the presence heartbeat cadence. The
         * backend's alive-threshold is >= 2x this (it tolerates one missed
         * tick), so do not change this without coordinating with the
         * backend's KIOSK_PRESENCE_THRESHOLD_MS.
         */
        private const val CONFIG_POLL_INTERVAL_MS = 2L * 60L * 1000L  // 2 minutes
        private const val TELEMETRY_INTERVAL_MS = 5L * 60L * 1000L  // 5 minutes
        private const val UPDATE_CHECK_INTERVAL_MS = 60L * 60L * 1000L  // 60 minutes
        private const val FIRST_UPDATE_CHECK_MS = 5L * 60L * 1000L  // 5 minutes after start
        /** How often to force a non-304 config fetch so date-based expiry idle
         *  deals appear/disappear without an operator edit. */
        private const val IDLE_FULL_REFRESH_MS = 20L * 60L * 1000L  // 20 minutes

        /**
         * Exponential backoff for auto-retry on transient errors. After N
         * consecutive failures, wait this many seconds before the next try.
         * Last value is the cap — further failures stay at 60s.
         *
         * Sequence: 5s, 15s, 30s, 60s, 60s, 60s, ...
         */
        internal val RETRY_BACKOFF_SECONDS = intArrayOf(5, 15, 30, 60)

        /**
         * Machines with non-standard layouts that aren't yet supported.
         * Adding a code here will cause Setup → Error with a clear message,
         * letting the operator try a different machine.
         */
        private val UNSUPPORTED_DEVICES = setOf(
            "62160042",  // non-standard layout
            "62160043",  // non-standard layout
        )

    }
}

/**
 * App lifecycle phases — drives which screen the user sees on startup.
 */
enum class Phase {
    /** Reading device code from DataStore, not yet decided what to show. */
    Bootstrap,
    /** No device code saved — show SetupScreen. */
    Setup,
    /** Device code present, calling Weimi API. */
    Loading,
    /** Catalog loaded successfully, normal app. */
    Ready,
    /** API call failed. fatalError holds the exception. */
    Error,
}

/**
 * The state of the customer's in-progress payment, driving the merged
 * order/pay screen. There is no "pay" button — arming the reader IS the pay
 * action, so the card tap (handled by the SDK) is what advances Dispensing→Done.
 */
enum class PaymentPhase {
    /** No payment in progress. */
    Idle,
    /** Marshall reader session not ready — show the auto-clearing error screen. */
    ReaderDown,
    /** Sending/re-sending the amount to the Nayax (brief; spinner). */
    Arming,
    /** Reader is live, showing the amount, waiting for a card tap. */
    AwaitingCard,
    /** Card approved; dispensing the ordered items. */
    Dispensing,
    /** No tap / declined — keep the order, show "cancelled, try again", auto re-arm. */
    Declined,
    /** Payment captured; navigate to Success. */
    Done,
}

data class VendingState(
    val phase: Phase = Phase.Bootstrap,
    val deviceCode: String? = null,
    /** Friendly per-machine name from Weimi ("Gamli Gerpla", "Leiknir"). Internal use only. */
    val machineName: String = "",
    val fatalError: Throwable? = null,

    val catalog: List<Product> = emptyList(),
    val visibleProducts: List<Product> = emptyList(),
    /** Resolved hero tiles (product + tag), in operator-defined order. Empty if nothing featured. */
    val heroes: List<HeroLine> = emptyList(),
    /** Per-product editorial details (nutrition/ingredients/allergens), keyed by
     *  product code. Empty until the backend serves them; products absent from
     *  the map fall back to the photo-only detail screen. */
    val productDetails: Map<String, ProductDetails> = emptyMap(),
    val basket: Basket = Basket(),
    val settings: MachineSettings = MachineSettings(showAdRegion = true),
    /** This machine's admin PIN hash from config; null means the shared code (AdminPin). */
    val adminPin: AdminPinHash? = null,
    /** Closed for sale (config.outOfService): the screen shows ClosedScreen and nothing sells. */
    val outOfService: Boolean = false,
    val outOfServiceReason: String? = null,
    val language: Language = Language.Icelandic,
    val currentTime: String = "—:—",
    val isEvening: Boolean = false,
    val showContact: Boolean = false,
    val selectedProductId: String? = null,
    val toastMessage: String? = null,
    /** Live network state — drives the status bar connection indicator. */
    val connectionState: ConnectionState = ConnectionState.None,
    /** Epoch millis of the last successful catalog fetch. 0 = never. */
    val lastFetchMillis: Long = 0L,
    /** How many auto-retry attempts have failed since the most recent error.
     *  Used by the error screen to drive backoff messaging and dev visibility. */
    val retryAttempts: Int = 0,
    /** Epoch millis at which the next auto-retry will fire. 0 = no retry pending. */
    val nextRetryAtMillis: Long = 0L,
    /** Status of the temporary Weimi-proxy bridge to the admin backend.
     *  Shown only in diagnostics. Customer-facing UI ignores this. */
    val proxyState: ProxyState = ProxyState(),
    /** The most recently completed transaction. Used by the success screen
     *  and the complaint form. Survives navigation away from Success so the
     *  complaint flow can reference it; replaced atomically on the next
     *  [VendingViewModel.completePayment] call. */
    val lastCompletedTransaction: CompletedTransaction? = null,
    /** State of the in-flight or last-completed complaint submission. */
    val complaintSubmission: ComplaintSubmissionState = ComplaintSubmissionState.Idle,
    /** Size of the pending complaint retry queue. Diagnostics only. */
    val complaintQueueSize: Int = 0,
    /** Pending (unreported) sales in the offline queue, for diagnostics. */
    val salesQueueSize: Int = 0,
    /** Latest cooling-board temperature probe result (Diagnostics), or null. */
    val lastTempProbe: String? = null,
    /** Latest cooling control action sent (Diagnostics), or null. */
    val lastCoolingAction: String? = null,
    /** Latest self-update check result (Diagnostics), or null. */
    val lastUpdateCheck: String? = null,
    /** Whether the app is currently Device Owner (needed for silent self-update). */
    val isDeviceOwner: Boolean = false,
    /** Per-product offer flags for grid badging, keyed by goodsId. */
    val offers: Map<String, Offer> = emptyMap(),
    /** Customer payment flow phase (drives the merged order/pay screen). */
    val paymentPhase: PaymentPhase = PaymentPhase.Idle,
    /** True when the Marshall card reader session is up (onReady fired). */
    val readerReady: Boolean = false,
    /** Attract-screen deal cards, ready to render in order (empty → plain idle). */
    val idleCards: List<IdleCard> = emptyList(),
    /** Seconds each attract card is shown before advancing (operator-tunable). */
    val idleRotationSeconds: Int = 6,
    /** Seconds of inactivity on a customer screen before dropping into the
     *  attract loop (operator-tunable from backend config). */
    val idleAttractTimeoutSeconds: Int = 30,
    /** Latest deal-priced quote for the current basket (null = base prices /
     *  quote unavailable). Drives the discounted total + savings at checkout. */
    val quote: CartQuote? = null,
) {
    fun selectedProduct(): Product? =
        selectedProductId?.let { id -> catalog.firstOrNull { it.id == id } }

    /**
     * Brand line for the status bar. Format: "snarl & sopi — AG Vending".
     * If the operator name is empty (e.g. during first-run setup before the
     * API populates it), shows just "snarl & sopi".
     */
    val brandLine: String
        get() = if (settings.operatorName.isBlank()) {
            "snarl & sopi"
        } else {
            "snarl & sopi — ${settings.operatorName}"
        }
}

/**
 * A snapshot of what was just paid for. Lives in VendingState as
 * [VendingState.lastCompletedTransaction] from the moment payment
 * completes until the next payment replaces it.
 *
 * Captured up-front (not derived from the basket) so it's available
 * after the basket clears. Includes tradeNo so a downstream complaint
 * can reference the exact transaction.
 */
data class CompletedTransaction(
    val tradeNo: String,
    val items: List<CompletedTransactionItem>,
    val totalIsk: Int,
    val timestampMs: Long,
)

data class CompletedTransactionItem(
    val goodsId: String,
    val name: String,
    val priceIsk: Int,
    val quantity: Int,
    val slot: String,
)

/**
 * Lifecycle of a complaint submission. The form screen observes this
 * to know when to show the confirmation, error, etc.
 */
sealed class ComplaintSubmissionState {
    data object Idle : ComplaintSubmissionState()
    data object Submitting : ComplaintSubmissionState()
    /** [complaintId] is null when the complaint was queued (no backend round-trip yet). */
    data class Accepted(val complaintId: String?, val queued: Boolean) : ComplaintSubmissionState()
    data class Failed(val reason: String) : ComplaintSubmissionState()
}
