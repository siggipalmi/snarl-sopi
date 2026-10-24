package isl.snudursopi.vending.proxy

import android.util.Log
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * Maintains a persistent WebSocket connection to the admin backend's
 * proxy endpoint. Receives messages, dispatches them via [ProxyDispatcher],
 * sends responses back over the same socket.
 *
 * Lifecycle is owned by [start] / [stop]. Reconnects with exponential
 * backoff per [BackendConfig.RECONNECT_BACKOFF_SECONDS]. The connection
 * is kept open indefinitely while started.
 *
 * Thread safety: OkHttp's WebSocketListener callbacks come in on its own
 * dispatch thread. We immediately hop into our internal coroutine scope
 * for any non-trivial work so we don't block ping/pong handling.
 *
 * This whole class exists as a temporary bridge. See [BackendConfig] for
 * deletion instructions.
 */
class ProxyClient(
    private val deviceCode: String,
    private val machineKey: String,
    private val dispatcher: ProxyDispatcher,
    private val httpClient: OkHttpClient = defaultHttpClient(),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mapper = jacksonObjectMapper()
    private val sendMutex = Mutex()

    private val _state = MutableStateFlow(ProxyState(status = ProxyState.Status.Idle))
    val state: StateFlow<ProxyState> = _state.asStateFlow()

    private var connectionJob: Job? = null
    @Volatile
    private var currentSocket: WebSocket? = null
    private var consecutiveFailures: Int = 0
    /** Set to true on a hard failure (e.g. 401) so we stop reconnecting. */
    @Volatile
    private var halted: Boolean = false

    fun start() {
        if (!BackendConfig.ENABLED) {
            Log.i(TAG, "Proxy disabled in BackendConfig; not starting")
            _state.update { it.copy(status = ProxyState.Status.Disabled) }
            return
        }
        if (connectionJob?.isActive == true) {
            Log.d(TAG, "start() called but already running")
            return
        }
        halted = false
        connectionJob = scope.launch { runConnectionLoop() }
    }

    fun stop() {
        connectionJob?.cancel()
        connectionJob = null
        currentSocket?.close(1000, "stopped")
        currentSocket = null
        _state.update { it.copy(status = ProxyState.Status.Idle, detail = "stopped") }
    }

    /** Manual reconnect — used by diagnostics. */
    fun forceReconnect() {
        Log.i(TAG, "forceReconnect()")
        currentSocket?.close(1000, "force-reconnect")
        // The watcher loop will see the close and reconnect immediately
        // (we reset backoff before letting it run again).
        consecutiveFailures = 0
    }

    /** Permanently dispose this client — call when ViewModel is cleared. */
    fun shutdown() {
        stop()
        scope.cancel()
    }

    // ---------- connection loop ----------

    private suspend fun runConnectionLoop() {
        while (!halted) {
            _state.update {
                it.copy(
                    status = if (consecutiveFailures == 0) ProxyState.Status.Connecting
                    else ProxyState.Status.Reconnecting,
                    reconnectAttempts = consecutiveFailures,
                )
            }
            val connected = openSocket()
            if (connected) {
                // Wait until the socket closes from either side. The listener
                // sets currentSocket to null when that happens.
                while (currentSocket != null && !halted) {
                    delay(500L)
                    checkPingDeadline()
                }
            }
            if (halted) break
            // Backoff before next try
            consecutiveFailures += 1
            val backoffSec = BackendConfig.RECONNECT_BACKOFF_SECONDS[
                (consecutiveFailures - 1).coerceAtMost(
                    BackendConfig.RECONNECT_BACKOFF_SECONDS.lastIndex
                )
            ]
            _state.update {
                it.copy(
                    status = ProxyState.Status.Reconnecting,
                    reconnectAttempts = consecutiveFailures,
                    detail = "next attempt in ${backoffSec}s",
                )
            }
            Log.i(TAG, "Reconnecting in ${backoffSec}s (attempt $consecutiveFailures)")
            delay(backoffSec * 1000L)
        }
    }

    private fun openSocket(): Boolean {
        val url = "${BackendConfig.WS_BASE_URL}${BackendConfig.WS_PROXY_PATH}" +
            "?deviceCode=$deviceCode&machineKey=$machineKey"
        val request = Request.Builder().url(url).build()
        return try {
            val socket = httpClient.newWebSocket(request, SocketListener())
            currentSocket = socket
            true
        } catch (e: Exception) {
            Log.w(TAG, "Failed to initiate WebSocket: ${e.message}")
            _state.update { it.copy(detail = "open failed: ${e.message}") }
            false
        }
    }

    private fun checkPingDeadline() {
        val state = _state.value
        if (state.status != ProxyState.Status.Connected) return
        if (state.lastPingAtMillis == 0L) return
        val sincePing = System.currentTimeMillis() - state.lastPingAtMillis
        if (sincePing > BackendConfig.PING_DEADLINE_MS) {
            Log.w(TAG, "No ping for ${sincePing}ms — closing socket")
            currentSocket?.close(1001, "ping deadline exceeded")
        }
    }

    // ---------- websocket listener ----------

    private inner class SocketListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            Log.i(TAG, "WebSocket open")
            consecutiveFailures = 0
            _state.update {
                it.copy(
                    status = ProxyState.Status.Connected,
                    reconnectAttempts = 0,
                    lastPingAtMillis = System.currentTimeMillis(),
                    detail = null,
                )
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            // Hop off OkHttp's dispatch thread immediately so request handling
            // doesn't block ping/pong processing.
            scope.launch { handleMessage(webSocket, text) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "WebSocket closing: $code $reason")
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "WebSocket closed: $code $reason")
            currentSocket = null
            _state.update {
                it.copy(
                    status = ProxyState.Status.Reconnecting,
                    detail = "closed: $reason",
                )
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val code = response?.code
            Log.w(TAG, "WebSocket failure: code=$code ${t.message}")
            currentSocket = null
            if (code == 401 || code == 403) {
                // Auth-related failure: don't retry. Operator must
                // re-provision (returning to Setup phase is handled at a
                // higher level — for now we just halt the loop and report).
                halted = true
                _state.update {
                    it.copy(
                        status = ProxyState.Status.Failed,
                        detail = "auth rejected ($code) — re-provision required",
                    )
                }
            } else {
                _state.update {
                    it.copy(
                        status = ProxyState.Status.Reconnecting,
                        detail = "failure: ${t.message}",
                    )
                }
            }
        }
    }

    // ---------- message handling ----------

    private suspend fun handleMessage(webSocket: WebSocket, text: String) {
        val node = try {
            mapper.readTree(text)
        } catch (e: Exception) {
            Log.w(TAG, "Could not parse incoming message: ${e.message}")
            return
        }
        val type = node.path("type").asText()

        // Keepalive: backend pings, we pong.
        if (type == "ping") {
            _state.update { it.copy(lastPingAtMillis = System.currentTimeMillis()) }
            sendRaw(webSocket, """{"type":"pong"}""")
            return
        }
        if (type == "pong") {
            // We sent a ping; mark connection healthy.
            _state.update { it.copy(lastPingAtMillis = System.currentTimeMillis()) }
            return
        }

        // Proxy request: must have id + action.
        val id = node.path("id").asText().ifBlank {
            Log.w(TAG, "Incoming message missing id")
            return
        }
        val action = node.path("action").asText().ifBlank {
            sendError(webSocket, id, "missing action")
            return
        }
        val params = node.path("params").let {
            if (it.isMissingNode || it.isNull) mapper.createObjectNode() else it
        }

        _state.update { it.copy(requestsHandled = it.requestsHandled + 1) }
        Log.i(TAG, "Proxy request $id action=$action")

        when (val result = dispatcher.dispatch(action, params)) {
            is ProxyDispatcher.Result.Ok -> sendOk(webSocket, id, result.data)
            is ProxyDispatcher.Result.Err -> {
                _state.update { it.copy(requestsFailed = it.requestsFailed + 1) }
                sendError(webSocket, id, result.message)
            }
        }
    }

    private suspend fun sendOk(webSocket: WebSocket, id: String, data: JsonNode) {
        val response: ObjectNode = mapper.createObjectNode().apply {
            put("id", id)
            put("ok", true)
            set<JsonNode>("data", data)
        }
        sendRaw(webSocket, mapper.writeValueAsString(response))
    }

    private suspend fun sendError(webSocket: WebSocket, id: String, message: String) {
        val response: ObjectNode = mapper.createObjectNode().apply {
            put("id", id)
            put("ok", false)
            put("error", message)
        }
        sendRaw(webSocket, mapper.writeValueAsString(response))
    }

    /** Serialize sends — addendum mentions backpressure isn't a concern but a
     *  mutex makes it impossible to interleave bytes if it ever does happen. */
    private suspend fun sendRaw(webSocket: WebSocket, text: String) {
        sendMutex.withLock {
            val sent = webSocket.send(text)
            if (!sent) {
                Log.w(TAG, "send returned false — socket may be closed")
            }
        }
    }

    companion object {
        private const val TAG = "ProxyClient"

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS) // 0 = no read timeout (WebSockets)
            .writeTimeout(10, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS) // OkHttp sends its own pings
            .retryOnConnectionFailure(true)
            .build()
    }
}
