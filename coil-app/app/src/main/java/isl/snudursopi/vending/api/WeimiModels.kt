package isl.snudursopi.vending.api

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

// ============================================================================
// device-profile endpoint
// ============================================================================
//
// Response shape:
// { "msg":"success", "code":200,
//   "data": {
//     "list": [
//       { "deviceId":"...", "deviceCode":"62160042", "deviceName":"Gamli Gerpla",
//         "isRunning":1, "isOnline":1, "isGoodsMerge":1, "totalCurrStock":178,
//         "cabinets":[ {"cabinetCode":0,"doorStatus":0} ]
//       }
//     ]
//   }
// }

@JsonIgnoreProperties(ignoreUnknown = true)
data class DeviceProfile(
    val deviceId: String? = null,
    val deviceCode: String,
    val deviceName: String? = null,
    val isRunning: Int = 0,
    val isOnline: Int = 0,
    val totalCurrStock: Int = 0,
) {
    val running: Boolean get() = isRunning == 1
    val online: Boolean get() = isOnline == 1
    /** Friendly name to display — falls back to device code if no name set. */
    val displayName: String get() = deviceName ?: deviceCode
}

// ============================================================================
// device-info endpoint
// ============================================================================
//
// Response shape:
// { "msg":"success", "code":200,
//   "data": [
//     { "cabinetTotal":1, "layerTotal":6, "aisleTotal":42,
//       "cabinets":[
//         { "code":0, "layerCount":6,
//           "layers":[
//             { "layer":"A", "aisleCount":9,
//               "aisles":[
//                 { "id":"...", "cabinet":0, "layer":"A", "code":"0-A00",
//                   "price":49900, "currStock":5, "maxStock":5,
//                   "goodsId":"...", "goodsName":"Powerade blár 500 ml",
//                   "imgUrl":"https://...", "thumbnailUrl":"https://...",
//                   "isEnable":true, "isBroken":false,
//                   "goodsTypeList":[{"id":"...","code":"Orkudrykkir","name":"Orkudrykkir"}, ...]
//                 }, ...
//               ]
//             }, ...
//           ]
//         }
//       ]
//     }
//   ]
// }

@JsonIgnoreProperties(ignoreUnknown = true)
data class DeviceInfo(
    val cabinetTotal: Int = 0,
    val layerTotal: Int = 0,
    val aisleTotal: Int = 0,
    val cabinets: List<Cabinet> = emptyList(),
) {
    /** Flatten all aisles across cabinets/layers for easy mapping. */
    val allAisles: List<Aisle>
        get() = cabinets.flatMap { c -> c.layers.flatMap { it.aisles } }
}

@JsonIgnoreProperties(ignoreUnknown = true)
data class Cabinet(
    val code: Int = 0,
    val layerCount: Int = 0,
    val layers: List<Layer> = emptyList(),
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class Layer(
    val layer: String = "",
    val aisleCount: Int = 0,
    val aisles: List<Aisle> = emptyList(),
)

@JsonIgnoreProperties(ignoreUnknown = true)
data class Aisle(
    val id: String = "",
    val cabinet: Int = 0,
    val layer: String = "",
    val code: String = "",              // e.g. "0-A00"
    val price: Int = 0,                  // Stored in *cents* (×100). Divide for kr.
    val currStock: Int = 0,
    val maxStock: Int = 0,
    val goodsId: String? = null,
    val goodsName: String? = null,
    val goodsCode: String? = null,
    val goodsCustomCode: String? = null,
    val imgUrl: String? = null,
    val thumbnailUrl: String? = null,
    val isEnable: Boolean = false,
    val isBroken: Boolean = false,
    val goodsTypeList: List<GoodsType> = emptyList(),
) {
    /** Backwards-compat name used elsewhere. */
    val aisleCode: String get() = code
    val stock: Int get() = currStock
    val imageUrl: String? get() = imgUrl ?: thumbnailUrl
    /** Convert öre/cents to whole kr. */
    val priceKr: Int get() = price / 100
}

@JsonIgnoreProperties(ignoreUnknown = true)
data class GoodsType(
    val id: String = "",
    val code: String = "",
    val name: String = "",
)

// ============================================================================
// notify-shipment endpoint (unchanged)
// ============================================================================

data class NotifyShipmentRequest(
    val userId: String,
    val tradeNo: String,
    val deviceCode: String,
    val aisleCodeList: List<String>,
    val payChannelCodeInt: Int,
    val authType: Int = 7,
    val payEndTime: Long,
)

// ============================================================================
// query-order-list (unchanged)
// ============================================================================

@JsonIgnoreProperties(ignoreUnknown = true)
data class OrderSummary(
    val tradeNo: String,
    val deviceCode: String,
    val totalAmount: Int,
    val status: Int,
    val createTime: Long,
)
