package isl.snudursopi.fridge.data.backend

import android.content.Context
import android.util.Log
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import isl.snudursopi.fridge.data.FridgeIdentityStore
import isl.snudursopi.fridge.domain.Planogram
import isl.snudursopi.fridge.domain.Settlement
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The fridge's whole backend surface in one place: planogram in, settlements
 * out.
 *
 * Deliberately fail-soft. A vending machine in a shop corridor must keep
 * working when the uplink doesn't:
 *  - not provisioned yet -> no polling, [planogram] stays null, caller falls back
 *  - offline at boot      -> last cached config is reloaded and used
 *  - offline at settle    -> settlement is queued and replayed for up to 7 days
 *
 * Nothing here should ever throw into the purchase flow.
 */
class FridgeBackend(
    appContext: Context,
    private val identity: FridgeIdentityStore = FridgeIdentityStore(appContext),
    private val cache: ConfigCacheStore = ConfigCacheStore(appContext),
) {
    private val queueStore = SettlementQueueStore(appContext)
    private val complaintQueue = ComplaintQueueStore(appContext)
    private val mapper = jacksonObjectMapper()

    private val _planogram = MutableStateFlow<Planogram?>(null)

    /** Latest known planogram: backend, or the cached one when offline. */
    val planogram: StateFlow<Planogram?> = _planogram.asStateFlow()

    private val _online = MutableStateFlow(false)

    /** Whether the last backend contact succeeded — for diagnostics/UI. */
    val online: StateFlow<Boolean> = _online.asStateFlow()

    /**
     * When the last config poll SUCCEEDED, or null if none ever has.
     *
     * *** THE SINGLE MOST USEFUL NUMBER WHEN A MACHINE GOES QUIET.
     *
     * On 2026-08-28 a machine came back from a power cut with its clock years
     * wrong. Every HTTPS request failed certificate validation, so it reached
     * the backend not at all — while running perfectly, showing its cached
     * planogram and the correct operator on the info sheet. Nothing on screen
     * distinguished it from a healthy machine, and diagnosing it took most of
     * an afternoon and nearly a drive across the country.
     *
     * A timestamp that has stopped advancing says immediately that the machine
     * is talking to nobody, whatever the screen looks like.
     */
    private val _lastPollOkMs = MutableStateFlow<Long?>(null)
    val lastPollOkMs: StateFlow<Long?> = _lastPollOkMs.asStateFlow()

    /** The deviceCode this machine is authenticated as, for the admin sheet. */
    private val _provisionedAs = MutableStateFlow<String?>(null)
    val provisionedAs: StateFlow<String?> = _provisionedAs.asStateFlow()

    private var settlements: SettlementRepository? = null
    private var logRelay: LogRelay? = null
    private var telemetryClient: TelemetryClient? = null

    /** The deviceCode this session is authenticated as; scopes the config cache. */
    private var cachedOwner: String? = null

    /**
     * Exposed as a flow because the ViewModel is built before provisioning
     * completes — the client simply does not exist until a deviceCode and key
     * are known, and the complaint entry point stays inert until it does.
     */
    private val _complaints = MutableStateFlow<ComplaintClient?>(null)
    val complaints: StateFlow<ComplaintClient?> = _complaints.asStateFlow()
    private var configClient: FridgeConfigClient? = null
    private var commandClient: CommandClient? = null

    /**
     * Load the cached planogram, then poll config forever. Safe to call once
     * from onCreate; never throws.
     */
    fun start(scope: CoroutineScope) {
        scope.launch {
            loadCachedPlanogram()

            if (!buildClients()) {
                Log.w(TAG, "not provisioned (no deviceCode/machineKey) — backend idle, using cache/demo")
                return@launch
            }

            logRelay?.start(scope)

            // Anything stranded from a previous run goes first.
            runCatching { settlements?.flushQueue() }
            runCatching { _complaints.value?.flush() }

            while (isActive) {
                pollOnce()
                // *** BOTH QUEUES FLUSH ON EVERY POLL. THIS IS NOT OPTIONAL.
                //
                // The settlement flush used to run only at app start and after
                // a successful post. Neither fires in the case that actually
                // matters: a machine drops connectivity, makes sales, comes
                // back online, and then sits idle. The poll loop knew the link
                // was back and did nothing about it, so those settlements
                // waited for a restart — and if none came within the 7-day TTL
                // they were dropped, with the cards already charged and no
                // record of what was sold.
                //
                // Found on hardware 2026-08-06: queue written at 23:21, config
                // polls succeeding from 23:26, queue untouched. Predates the
                // complaint work; the complaint flush was correctly in the loop
                // one line below a settlement flush that was not.
                //
                // Both are cheap no-ops when the queues are empty, and the poll
                // has just proven the backend reachable — there is no better
                // moment to retry.
                runCatching { settlements?.flushQueue() }
                runCatching { _complaints.value?.flush() }
                delay(FridgeBackendConfig.CONFIG_POLL_INTERVAL_MS)
            }
        }
    }

    /**
     * Report a completed session. Never throws and never blocks the customer:
     * an undeliverable settlement is persisted and retried.
     */
    suspend fun reportSettlement(
        orderId: String,
        startedAtIso: String,
        closedAtIso: String,
        planogramUsed: Planogram,
        cabinetsOpened: List<String>,
        outcome: String,
        nayaxRef: String?,
        result: Settlement.Result,
    ) {
        val repo = settlements
        val body = runCatching {
            SettlementReport.body(
                orderId = orderId,
                startedAtIso = startedAtIso,
                closedAtIso = closedAtIso,
                planogram = planogramUsed,
                cabinetsOpened = cabinetsOpened,
                outcome = outcome,
                nayaxRef = nayaxRef,
                result = result,
            ).toString()
        }.getOrElse {
            Log.e(TAG, "could not build settlement body for $orderId: ${it.message}")
            return
        }

        if (repo == null) {
            // Unprovisioned: still persist it. When the machine is finally
            // given a deviceCode the money isn't lost.
            Log.w(TAG, "settlement $orderId recorded before provisioning — queued")
            runCatching {
                val current = queueStore.load()
                queueStore.save(
                    current + QueuedSettlement(System.currentTimeMillis(), orderId, body)
                )
            }
            return
        }

        val ok = repo.report(orderId, body)
        _online.value = ok
        if (ok) runCatching { repo.flushQueue() }
    }

    /**
     * Start the command poller, once the caller can supply the gates it needs.
     *
     * Separate from [start] because the runner has to be able to ask "is a
     * customer mid-purchase?" and "quiet the weight bus" — both of which belong
     * to the view model, which doesn't exist yet when the backend is created.
     * Does nothing on an unprovisioned machine, which has no queue to poll.
     */
    fun startCommands(
        scope: CoroutineScope,
        hardware: isl.snudursopi.fridge.hardware.FridgeHardwareController,
        isSessionActive: () -> Boolean,
        withBusQuiet: suspend (suspend () -> Unit) -> Unit,
        beginRestock: (Int) -> Unit,
        onCheckUpdate: (suspend () -> String)? = null,
        onSyncPriceTags: (suspend (force: Boolean) -> String)? = null,
        onReadTemp: (suspend () -> String?)? = null,
        onProbeAddresses: (suspend () -> String)? = null,
        onRestartApp: ((delayMs: Long) -> Unit)? = null,
        onClearDeviceOwner: (suspend () -> String)? = null,
        onSetPaymentPort: (suspend (String) -> String)? = null,
        onLaunchSupport: (suspend () -> String)? = null,
        telemetry: ((TelemetryClient) -> TelemetryLoop)? = null,
    ) {
        scope.launch {
            // The client is built asynchronously inside start(), so don't assume
            // it already exists — wait for it rather than depending on call order.
            var waited = 0L
            while (commandClient == null && waited < CLIENT_WAIT_MS) {
                delay(500)
                waited += 500
            }
            val client = commandClient
            if (client == null) {
                Log.w(TAG, "not provisioned — command poller idle")
                return@launch
            }
            // Telemetry starts here rather than in start(), because this is
            // where we know the http client exists AND where the caller has
            // handed us the hardware to read from.
            telemetryClient?.let { tc -> telemetry?.invoke(tc)?.start(scope) }

            CommandRunner(
                client = client,
                hardware = hardware,
                planogram = { _planogram.value },
                isSessionActive = isSessionActive,
                withBusQuiet = withBusQuiet,
                beginRestock = beginRestock,
                onCheckUpdate = onCheckUpdate,
                onSyncPriceTags = onSyncPriceTags,
                onReadTemp = onReadTemp,
                onProbeAddresses = onProbeAddresses,
                onRestartApp = onRestartApp,
                onClearDeviceOwner = onClearDeviceOwner,
                onSetPaymentPort = onSetPaymentPort,
                onLaunchSupport = onLaunchSupport,
            ).start(scope)
            Log.i(TAG, "command poller started")
        }
    }

    // ---- internals ----

    private suspend fun buildClients(): Boolean {
        val deviceCode = identity.deviceCode()?.takeIf { it.isNotBlank() } ?: return false
        val machineKey = identity.machineKey()?.takeIf { it.isNotBlank() } ?: return false
        val http = FridgeBackendHttp(
            baseUrl = FridgeBackendConfig.BASE_URL,
            machineKey = machineKey,
        )
        configClient = FridgeConfigClient(http, deviceCode)
        commandClient = CommandClient(http, deviceCode)
        _complaints.value = ComplaintClient(http, deviceCode, complaintQueue)
        logRelay = LogRelay(http, deviceCode)
        telemetryClient = TelemetryClient(http, deviceCode)
        cachedOwner = deviceCode
        _provisionedAs.value = deviceCode

        settlements = SettlementRepository(
            client = SettlementClient(http, deviceCode),
            queueStore = queueStore,
        )
        return true
    }

    private suspend fun loadCachedPlanogram() {
        // Scoped to THIS machine's deviceCode — see ConfigCacheStore.ownerKey.
        val dc = runCatching { identity.deviceCode() }.getOrNull()
        val cached = runCatching { cache.body(dc) }.getOrNull() ?: return
        val parsed = runCatching { FridgeConfigParser.parse(mapper.readTree(cached)) }.getOrNull()
        if (parsed != null) {
            _planogram.value = parsed
            Log.i(TAG, "loaded cached planogram (${parsed.baskets.size} baskets)")
        }
    }

    private suspend fun pollOnce() {
        val client = configClient ?: return
        try {
            when (val r = client.fetch(cache.etagFor(cachedOwner))) {
                is FridgeConfigClient.Result.NotModified -> {
                    _online.value = true
                    _lastPollOkMs.value = System.currentTimeMillis()
                    // Log the quiet case too. Without this, "polling happily,
                    // nothing changed" and "the poll loop is dead" look
                    // identical from outside — which cost us a debugging round.
                    // Echoing the version we sent makes a stuck configVersion
                    // obvious at a glance.
                    Log.i(TAG, "config poll: no change (configVersion=${cache.etagFor(cachedOwner)})")
                }
                is FridgeConfigClient.Result.Updated -> {
                    _online.value = true
                    _lastPollOkMs.value = System.currentTimeMillis()
                    _planogram.value = r.planogram
                    // Persist verbatim so an offline reboot still has a planogram.
                    runCatching { cache.save(r.etag, r.rawJson, cachedOwner) }
                    Log.i(TAG, "planogram updated (${r.planogram.baskets.size} baskets)")
                }
                is FridgeConfigClient.Result.NoFridgeBlock -> {
                    // Reachable but nothing for us. Keep whatever we have —
                    // never wipe a working planogram over an empty response.
                    _online.value = true
                    _lastPollOkMs.value = System.currentTimeMillis()
                    Log.w(TAG, "config had no fridge block — keeping existing planogram")
                }
            }
        } catch (e: BackendException) {
            _online.value = false
            Log.w(TAG, "config poll failed (${e.kind}): ${e.message}")
        } catch (e: Exception) {
            _online.value = false
            Log.w(TAG, "config poll failed: ${e.message}")
        }
    }

    private companion object {
        const val TAG = "FridgeBackend"

        /** How long startCommands waits for provisioning before giving up. */
        const val CLIENT_WAIT_MS = 30_000L
    }
}
