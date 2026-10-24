package isl.snudursopi.vending.api

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import java.util.UUID

class WeimiApiClient(val http: WeimiHttp) {
    private val mapper = jacksonObjectMapper()

    /**
     * Returns metadata for the requested devices. The response wraps the
     * device list inside `data.list`, not `data`.
     */
    suspend fun deviceProfile(deviceCodes: List<String> = emptyList()): List<DeviceProfile> {
        val params = mapOf("deviceCodes" to deviceCodes.joinToString(","))
        val response = http.get("/ext/device-profile", params)
        val listNode = response.get("data")?.get("list") ?: return emptyList()
        if (!listNode.isArray) return emptyList()
        return listNode.map { mapper.treeToValue(it, DeviceProfile::class.java) }
    }

    /**
     * Returns the cabinet/layer/aisle layout for a single device. Weimi returns
     * a nested structure (`data[0].cabinets[N].layers[N].aisles[N]`); the
     * deserialized [DeviceInfo.allAisles] provides a flat view.
     */
    suspend fun deviceInfo(deviceCode: String): DeviceInfo {
        val params = mapOf("deviceCodes" to deviceCode)
        val response = http.get("/ext/device-info", params)
        val dataArray = response.get("data") ?: error("device-info response missing data")
        if (!dataArray.isArray || dataArray.size() == 0) {
            error("device-info returned no machines for $deviceCode")
        }
        return mapper.treeToValue(dataArray.get(0), DeviceInfo::class.java)
    }

    suspend fun notifyShipment(request: NotifyShipmentRequest): String {
        val params = mapOf(
            "userId" to request.userId,
            "tradeNo" to request.tradeNo,
            "deviceCode" to request.deviceCode,
            "aisleCodeList" to request.aisleCodeList,
            "payChannelCodeInt" to request.payChannelCodeInt,
            "authType" to request.authType,
            "payEndTime" to request.payEndTime,
        )
        http.post("/ext/notify-shipment", params)
        return request.tradeNo
    }

    suspend fun queryOrders(
        page: Int = 1,
        size: Int = 50,
        deviceCode: String? = null,
        startDate: String? = null,
        endDate: String? = null,
    ): List<OrderSummary> {
        val params = mutableMapOf<String, Any?>("current" to page, "size" to size)
        if (deviceCode != null) params["deviceCode"] = deviceCode
        if (startDate != null) params["startDate"] = startDate
        if (endDate != null) params["endDate"] = endDate
        val response = http.post("/ext/query-order-list", params)
        val records = response.get("data")?.get("records") ?: return emptyList()
        return records.map { mapper.treeToValue(it, OrderSummary::class.java) }
    }

    /** Diagnostic: return the RAW query-order-list JSON so we can read every
     *  field Weimi sends (payChannelCodeInt, userId, aisle codes) without a
     *  model dropping unknown fields. Not used in normal flow. */
    suspend fun queryOrdersRaw(
        page: Int = 1,
        size: Int = 10,
        deviceCode: String? = null,
    ): JsonNode {
        val params = mutableMapOf<String, Any?>("current" to page, "size" to size)
        if (deviceCode != null) params["deviceCode"] = deviceCode
        return http.post("/ext/query-order-list", params)
    }

    companion object {
        fun test(appId: String, secretKey: String) =
            WeimiApiClient(WeimiHttp(WeimiHttp.TEST_BASE_URL, appId, secretKey))

        fun production(appId: String, secretKey: String) =
            WeimiApiClient(WeimiHttp(WeimiHttp.PROD_BASE_URL, appId, secretKey))

        fun newTradeNo(): String = "SS" + UUID.randomUUID().toString().replace("-", "")
    }
}
