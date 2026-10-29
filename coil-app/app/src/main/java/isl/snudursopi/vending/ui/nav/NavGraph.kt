package isl.snudursopi.vending.ui.nav

import android.app.Activity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import isl.snudursopi.vending.SystemBarController
import isl.snudursopi.vending.KioskManager
import isl.snudursopi.vending.ui.screens.admin.DiagnosticsScreen
import isl.snudursopi.vending.ui.screens.admin.PinEntryScreen
import isl.snudursopi.vending.ui.screens.attract.AttractScreen
import isl.snudursopi.vending.ui.screens.browse.BrowseScreen
import isl.snudursopi.vending.ui.screens.complaint.ComplaintConfirmationScreen
import isl.snudursopi.vending.ui.screens.complaint.ComplaintFormScreen
import isl.snudursopi.vending.ui.screens.contact.ContactOverlay
import isl.snudursopi.vending.ui.screens.detail.DetailScreen
import isl.snudursopi.vending.ui.screens.error.ErrorScreen
import isl.snudursopi.vending.ui.screens.hardware.HardwareTestScreen
import isl.snudursopi.vending.ui.screens.loading.LoadingScreen
import isl.snudursopi.vending.ui.screens.payment.PaymentScreen
import isl.snudursopi.vending.ui.screens.setup.SetupScreen
import isl.snudursopi.vending.ui.screens.success.SuccessScreen
import isl.snudursopi.vending.ui.state.Phase
import isl.snudursopi.vending.ui.state.VendingViewModel
import isl.snudursopi.vending.ui.screens.closed.ClosedScreen


/** Product info page: back to the grid after this long without a touch. */
private const val DETAIL_IDLE_MS = 30_000L

@Composable
fun NavGraph(viewModel: VendingViewModel) {
    val state by viewModel.state.collectAsState()

    // Top-level phase routing — these phases override the normal NavHost flow.
    when (state.phase) {
        Phase.Bootstrap -> LoadingScreen(deviceCode = null)
        Phase.Setup -> SetupScreen(
            connectionState = state.connectionState,
            currentTime = state.currentTime,
            onSetupCompleted = viewModel::onSetupCompleted,
            onClockLongPress = {
                // No-op for now. Setup screen is the very first thing on a
                // fresh tablet — there's no useful diagnostics state to show
                // yet. Wire to PIN flow if we ever want admin entry here.
            },
            onTestCode = viewModel::testDeviceCode,
            onTestKey = viewModel::testMachineKey,
            onPair = viewModel::pairWithCode,
        )
        Phase.Loading -> LoadingScreen(deviceCode = state.deviceCode)
        Phase.Error -> {
            val err = state.fatalError ?: RuntimeException("Unknown error")
            // Local UI state — separate from viewModel because it's purely about
            // "is the technician's PIN unlocking the detail view right now?"
            // Not worth persisting; reset on phase changes.
            var pinPromptVisible by remember { mutableStateOf(false) }
            var operatorUnlocked by remember { mutableStateOf(false) }

            ErrorScreen(
                error = err,
                deviceCode = state.deviceCode,
                machineName = state.machineName,
                currentTime = state.currentTime,
                connectionState = state.connectionState,
                retryAttempts = state.retryAttempts,
                nextRetryAtMillis = state.nextRetryAtMillis,
                showOperatorDetail = operatorUnlocked,
                onClockLongPress = {
                    // Only prompt for PIN if the operator view isn't already open.
                    if (!operatorUnlocked) {
                        pinPromptVisible = true
                    }
                },
                onRetryNow = viewModel::retryNow,
                onResetDeviceCode = viewModel::clearDeviceCodeAndRestart,
                onExitOperator = { operatorUnlocked = false },
            )

            // Full-screen PIN sheet over the error screen.
            if (pinPromptVisible) {
                PinEntryScreen(
                    onSuccess = {
                        pinPromptVisible = false
                        operatorUnlocked = true
                    },
                    onCancel = { pinPromptVisible = false },
                    pinHash = state.adminPin,
                    language = state.language,
                    onPinEvent = viewModel::reportAdminPinEvent,
                )
            }
        }
        Phase.Ready -> ReadyNavHost(viewModel = viewModel)
    }
}

@Composable
private fun ReadyNavHost(viewModel: VendingViewModel) {
    val navController = rememberNavController()
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current
    val activity = context as? Activity

    // Shared admin-entry callback — long-pressing the clock on any customer
    // screen lands at the PIN entry route.
    val onClockLongPress: () -> Unit = {
        navController.navigate(Routes.PinEntry) { launchSingleTop = true }
    }

    // *** NEVER POP THE LAST ENTRY. A plain popBackStack() on a stack of one empties the
    // NavHost, and an empty NavHost composes NOTHING: the activity stays resumed, every poll
    // and command keeps answering, and the glass shows the bare window colour with nothing to
    // touch. Both Grótta machines were found like that on 2026-10-28 (six accessibility nodes,
    // no text), and it is the likely shape of the "black, deaf screen" of 10-26 too. The way
    // it happens: a second tap on back/cancel while the screen being left is still animating
    // out pops Browse as well. So every back goes through here, and a stack with nowhere to
    // go navigates home instead.
    fun popOrHome() {
        if (navController.previousBackStackEntry != null) {
            navController.popBackStack()
        } else if (navController.currentDestination?.route != Routes.Browse) {
            navController.navigate(Routes.Browse) { popUpTo(0) }
        }
    }

    // Inactivity → attract loop. We reset [lastTouchMs] on every pointer event
    // (observed in the Initial pass so children still receive the touch), and
    // after the backend-configured idle timeout with no activity on a customer
    // browse/detail screen — and only if the backend gave us deal cards — we
    // clear any abandoned cart and drop into the attract loop.
    val currentRoute = navController.currentBackStackEntryAsState().value?.destination?.route
    // Belt to the braces above: should the stack ever end up empty, go home instead of showing
    // nothing. (null is also what the first composition sees before the graph is set, hence
    // the short wait.) And log every route change, so the relayed log shows the path next time.
    LaunchedEffect(currentRoute) {
        if (currentRoute == null) {
            kotlinx.coroutines.delay(1_500)
            if (navController.currentBackStackEntry == null) {
                android.util.Log.e("Nav", "back stack empty — the screen would be blank; going home")
                navController.navigate(Routes.Browse)
            }
        } else {
            android.util.Log.i("Nav", "→ $currentRoute")
        }
    }
    var lastTouchMs by remember { mutableStateOf(System.currentTimeMillis()) }
    val attractEligible = currentRoute == Routes.Browse || currentRoute == Routes.Detail
    LaunchedEffect(lastTouchMs, attractEligible, state.idleCards.size, state.idleAttractTimeoutSeconds) {
        if (!attractEligible || state.idleCards.isEmpty()) return@LaunchedEffect
        kotlinx.coroutines.delay(state.idleAttractTimeoutSeconds.coerceAtLeast(5) * 1000L)
        viewModel.resetForAttract()
        navController.navigate(Routes.Attract) { launchSingleTop = true }
    }

    // Product info left open: a customer reads a product's page and walks away, and with no deal
    // cards configured nothing above ever fires, so the machine shows that page until the next
    // person taps "Til baka" (seen at Grótta, 2026-10-29). Back to the grid after 30 s without a
    // touch, deal cards or not. The basket is kept, exactly as "Til baka" keeps it.
    val onDetail = currentRoute == Routes.Detail
    LaunchedEffect(lastTouchMs, onDetail) {
        if (!onDetail) return@LaunchedEffect
        kotlinx.coroutines.delay(DETAIL_IDLE_MS)
        android.util.Log.i("Nav", "product info idle for ${DETAIL_IDLE_MS / 1000} s — back to the grid")
        popOrHome()
    }

    // Closed for sale: ClosedScreen covers every customer screen (drawn after the NavHost, so it
    // is on top and takes the touches). Not while a payment is in flight — the customer who
    // already tapped pay gets their item, and the machine closes behind them — and not over the
    // admin routes, so the clock long-press → PIN → Diagnostics path still works while closed.
    val adminRoute = currentRoute == Routes.PinEntry || currentRoute == Routes.Diagnostics || currentRoute == Routes.HardwareTest
    val showClosed = state.outOfService && !adminRoute &&
        state.paymentPhase == isl.snudursopi.vending.ui.state.PaymentPhase.Idle

    Box(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) {
                        awaitPointerEvent(PointerEventPass.Initial)
                        lastTouchMs = System.currentTimeMillis()
                    }
                }
            },
    ) {
        NavHost(
            navController = navController,
            startDestination = Routes.Browse,
        ) {
            composable(Routes.Browse) {
                BrowseScreen(
                    state = state,
                    onProductImageClick = { product ->
                        // Empty cart → instant buy (go to Payment). Cart already
                        // open → buyNow appends and returns false → stay on grid.
                        if (viewModel.buyNow(product)) {
                            navController.navigate(Routes.Payment) { launchSingleTop = true }
                        }
                    },
                    onProductCartClick = { product ->
                        // Add to the cart and STAY on the grid; the checkout pill
                        // shows the running count/total. Tap the pill to pay.
                        viewModel.addToOrder(product)
                    },
                    onProductInfoClick = { product ->
                        navController.navigate(Routes.detail(product.id))
                    },
                    onContactClick = { viewModel.showContactOverlay() },
                    onLanguageClick = { viewModel.cycleLanguage() },
                    onCheckoutClick = {
                        // Arm the reader for the built cart, then show Payment.
                        viewModel.openCheckout()
                        navController.navigate(Routes.Payment) { launchSingleTop = true }
                    },
                    onClockLongPress = onClockLongPress,
                )
            }

            composable(Routes.Attract) {
                // Leave the loop the moment cards drain to empty (e.g. a deal
                // expired on the periodic refresh while the loop was showing).
                LaunchedEffect(state.idleCards.isEmpty()) {
                    if (state.idleCards.isEmpty()) {
                        navController.navigate(Routes.Browse) {
                            popUpTo(Routes.Browse) { inclusive = true }
                        }
                    }
                }
                AttractScreen(
                    cards = state.idleCards,
                    rotationSeconds = state.idleRotationSeconds,
                    language = state.language,
                    onExit = {
                        navController.navigate(Routes.Browse) {
                            popUpTo(Routes.Browse) { inclusive = true }
                        }
                    },
                )
            }

            composable(
                route = Routes.Detail,
                arguments = listOf(navArgument("productId") { type = NavType.StringType }),
            ) { backStack ->
                val id = backStack.arguments?.getString("productId") ?: return@composable
                val product = state.catalog.firstOrNull { it.id == id }
                if (product != null) {
                    DetailScreen(
                        product = product,
                        details = state.productDetails[product.id],
                        language = state.language,
                        brand = state.brandLine,
                        currentTime = state.currentTime,
                        connectionState = state.connectionState,
                        onBack = { popOrHome() },
                        onClockLongPress = onClockLongPress,
                    )
                }
            }

            composable(Routes.Payment) {
                // Phase-driven navigation: when payment completes, go to Success;
                // when it's cancelled/idle, return to Browse.
                androidx.compose.runtime.LaunchedEffect(state.paymentPhase) {
                    // Only act while Payment is still the screen on top. After we
                    // navigate to Success on Done, the Success screen resets the
                    // phase to Idle — without this guard that Idle would re-fire
                    // here and bounce the customer straight off the thank-you
                    // screen back to the grid.
                    if (navController.currentBackStackEntry?.destination?.route != Routes.Payment) {
                        return@LaunchedEffect
                    }
                    when (state.paymentPhase) {
                        isl.snudursopi.vending.ui.state.PaymentPhase.Done -> {
                            navController.navigate(Routes.Success) {
                                popUpTo(Routes.Browse) { inclusive = false }
                            }
                        }
                        isl.snudursopi.vending.ui.state.PaymentPhase.Idle -> {
                            navController.navigate(Routes.Browse) {
                                popUpTo(Routes.Browse) { inclusive = true }
                            }
                        }
                        else -> {}
                    }
                }
                PaymentScreen(
                    basket = state.basket,
                    phase = state.paymentPhase,
                    brand = state.brandLine,
                    currentTime = state.currentTime,
                    connectionState = state.connectionState,
                    language = state.language,
                    quote = state.quote,
                    catalog = state.catalog,
                    onCancel = { viewModel.cancelOrder() },
                    onAddMore = {
                        // Leaving the pay screen to add more: drop the terminal
                        // session but KEEP the basket and stop the idle clock, so
                        // the grid is unarmed (no stale amount, no timeout) while
                        // browsing. The reader re-arms when they tap the pill.
                        viewModel.leaveCheckout()
                        navController.navigate(Routes.Browse) {
                            popUpTo(Routes.Browse) { inclusive = true }
                        }
                    },
                    onIncItem = { productId -> viewModel.incOrderItem(productId) },
                    onDecItem = { productId -> viewModel.decOrderItem(productId) },
                    onAddCandidate = { goodsId -> viewModel.addOrderItem(goodsId) },
                    onClockLongPress = onClockLongPress,
                )
            }

            composable(Routes.Success) {
                val transaction = state.lastCompletedTransaction
                // We've arrived at Success; reset the payment phase so a future
                // visit to Payment starts clean (and the Payment LaunchedEffect
                // doesn't re-fire on a stale Done).
                androidx.compose.runtime.LaunchedEffect(Unit) {
                    viewModel.resetPaymentPhase()
                }
                SuccessScreen(
                    transaction = transaction,
                    brand = state.brandLine,
                    currentTime = state.currentTime,
                    connectionState = state.connectionState,
                    language = state.language,
                    onAutoReturn = {
                        navController.navigate(Routes.Browse) {
                            popUpTo(Routes.Browse) { inclusive = true }
                        }
                    },
                    onComplain = {
                        navController.navigate(Routes.ComplaintForm)
                    },
                    onClockLongPress = onClockLongPress,
                )
            }

            composable(Routes.ComplaintForm) {
                ComplaintFormScreen(
                    transaction = state.lastCompletedTransaction,
                    submissionState = state.complaintSubmission,
                    brand = state.brandLine,
                    currentTime = state.currentTime,
                    connectionState = state.connectionState,
                    language = state.language,
                    onSubmit = { items, note, email ->
                        viewModel.submitComplaint(items = items, note = note, customerEmail = email)
                    },
                    onCancel = {
                        viewModel.resetComplaintSubmissionState()
                        navController.navigate(Routes.Browse) {
                            popUpTo(Routes.Browse) { inclusive = true }
                        }
                    },
                    onAcceptedNavigate = {
                        navController.navigate(Routes.ComplaintConfirmation) {
                            popUpTo(Routes.Browse) { inclusive = false }
                        }
                    },
                    onClockLongPress = onClockLongPress,
                )
            }

            composable(Routes.ComplaintConfirmation) {
                ComplaintConfirmationScreen(
                    submissionState = state.complaintSubmission,
                    brand = state.brandLine,
                    currentTime = state.currentTime,
                    connectionState = state.connectionState,
                    language = state.language,
                    onAutoReturn = {
                        viewModel.resetComplaintSubmissionState()
                        navController.navigate(Routes.Browse) {
                            popUpTo(Routes.Browse) { inclusive = true }
                        }
                    },
                    onClockLongPress = onClockLongPress,
                )
            }

            // ---------- Admin: PIN entry ----------
            composable(Routes.PinEntry) {
                PinEntryScreen(
                    onSuccess = {
                        navController.navigate(Routes.Diagnostics) {
                            // Drop PinEntry from the back stack — successful auth shouldn't
                            // leave a re-enterable PIN screen between the technician and the
                            // customer experience.
                            popUpTo(Routes.PinEntry) { inclusive = true }
                        }
                    },
                    onCancel = { popOrHome() },
                    pinHash = state.adminPin,
                    language = state.language,
                    onPinEvent = viewModel::reportAdminPinEvent,
                )
            }

            // ---------- Admin: Diagnostics ----------
            composable(Routes.Diagnostics) {
                DiagnosticsScreen(
                    state = state,
                    onRefreshCatalog = { viewModel.refreshCatalog() },
                    onDumpOrders = { viewModel.dumpRecentOrders() },
                    onResetDeviceCode = {
                        // Wipe deviceCode; bootstrap returns to Setup phase. Re-hide
                        // system bars in case the technician toggled them visible.
                        activity?.window?.let(SystemBarController::hideSystemBars)
                        viewModel.clearDeviceCodeAndRestart()
                    },
                    onFactoryReset = {
                        activity?.window?.let(SystemBarController::hideSystemBars)
                        viewModel.factoryReset()
                    },
                    onShowSystemBars = {
                        // Temporarily reveal Android system bars for Wi-Fi quicksettings.
                        // In Lock Task Mode the bars stay suppressed, so drop lock task
                        // first (PIN-gated — we're already past the admin PIN here).
                        activity?.let { KioskManager.disableLockTask(it) }
                        activity?.window?.let(SystemBarController::showSystemBars)
                    },
                    onForceTestError = {
                        // Synthesizes an error → phase flips to Error at the top level,
                        // which unmounts this NavHost entirely. No nav action needed.
                        viewModel.forceTestError()
                    },
                    onReconnectProxy = { viewModel.reconnectProxy() },
                    onHardwareTest = {
                        navController.navigate(Routes.HardwareTest)
                    },
                    onReadTemperature = { viewModel.probeTemperature() },
                    onSetCoolingTemp = { c -> viewModel.setCoolingTemp(c) },
                    onSetCooling = { on -> viewModel.setCooling(on) },
                    onDefrost = { viewModel.triggerDefrost() },
                    onCheckUpdate = { viewModel.checkForUpdate() },
                    onExit = {
                        activity?.window?.let(SystemBarController::hideSystemBars)
                        // Re-assert lockdown on the way back to the customer UI
                        // (no-op if it was never dropped / not device owner).
                        activity?.let { KioskManager.enableLockTask(it) }
                        // Back to the customer screen whatever the stack holds: a pop that finds
                        // no Browse underneath would leave nothing on the glass.
                        navController.navigate(Routes.Browse) { popUpTo(0) }
                    },
                )
            }

            composable(Routes.HardwareTest) {
                HardwareTestScreen(
                    onExit = { popOrHome() },
                    directPushRows = viewModel.directPushRowsCsv(),
                    onSaveDirectPushRows = viewModel::setDirectPushRows,
                    dropSensorOverride = viewModel.dropSensorOverrideValue(),
                    onSaveDropSensorOverride = viewModel::setDropSensorOverride,
                )
            }
        }

        if (showClosed) {
            ClosedScreen(
                reason = state.outOfServiceReason,
                brand = state.brandLine,
                currentTime = state.currentTime,
                connectionState = state.connectionState,
                onClockLongPress = onClockLongPress,
            )
        }

        if (state.showContact) {
            ContactOverlay(
                operatorName = state.settings.operatorName,
                email = state.settings.supportEmail,
                machineId = state.deviceCode ?: "",
                language = state.language,
                onClose = { viewModel.hideContactOverlay() },
            )
        }
    }
}
