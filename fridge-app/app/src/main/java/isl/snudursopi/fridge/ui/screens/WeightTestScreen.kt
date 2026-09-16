package isl.snudursopi.fridge.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.fridge.hardware.FridgeHardwareController
import isl.snudursopi.fridge.ui.theme.AppColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The gravity board answers a full 16-tray multi-read about every 2.4s. Polling
 * faster than that just backs up the SDK's send queue — commands like tare then
 * sit behind a wall of pending reads and their replies get lost. Pace the poll
 * to what the hardware can actually sustain.
 */
private const val POLL_INTERVAL_MS = 2500L

/**
 * On-machine instrument for verifying the weight bus WITHOUT any card
 * transaction. Opens the weight serial link and shows live per-tray grams.
 *
 * KEY: the weight board appears to need SUSTAINED POLLING to stay responsive
 * (the stock app polls continuously; a single lone read often gets no answer).
 * So this screen has a "poll" toggle that fires a read every ~300ms, matching
 * how the stock app — and our own settlement loop — drive the bus. Put a
 * known-weight item in a basket while polling and watch its tray's grams move.
 *
 * Debug-only; reached from a long-press on the idle screen.
 */
@Composable
fun WeightTestScreen(hardware: FridgeHardwareController, onExit: () -> Unit) {
    var started by remember { mutableStateOf(false) }
    var polling by remember { mutableStateOf(false) }
    var weights by remember { mutableStateOf<Map<Int, Int>>(emptyMap()) }
    var lastEvent by remember { mutableStateOf("—") }
    var pollCount by remember { mutableStateOf(0) }
    var trayInput by remember { mutableStateOf("") }
    var weightInput by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    var busBusy by remember { mutableStateOf(false) }
    // LED price-tag experiment: the raw integer handed to the SDK, plus what
    // the SDK will format it as, so the prediction sits next to the result.
    var priceInput by remember { mutableStateOf("29900") }
    // Digits sent verbatim to the tag, bypassing the SDK's price formatter.
    var digitsInput by remember { mutableStateOf("299") }

    // Continuous polling loop: while `polling`, fire a read every 300ms and
    // refresh the displayed weights. This keeps the bus active the way the
    // stock app does.
    LaunchedEffect(polling) {
        if (polling) {
            while (true) {
                if (!busBusy) {
                    hardware.readWeights { w -> weights = w }
                    lastEvent = hardware.status.value.lastEvent
                    pollCount += 1
                }
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(AppColors.Cream)
            .padding(24.dp)
    ) {
        Text("weight test — /dev/ttyS3", fontSize = 22.sp, color = AppColors.Ink)
        Spacer(Modifier.height(4.dp))
        Text("last: $lastEvent", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = AppColors.Muted)
        Text(
            if (polling) "polling… (#$pollCount)" else "idle",
            fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = AppColors.Bronze,
        )
        Spacer(Modifier.height(16.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = {
                hardware.start { ok -> started = ok; lastEvent = if (ok) "serial up" else "serial FAILED" }
            }) { Text(if (started) "restart" else "start") }

            Button(onClick = {
                hardware.readWeights { w -> weights = w }
                lastEvent = hardware.status.value.lastEvent
            }) { Text("read once") }

            Button(onClick = { polling = !polling }) {
                Text(if (polling) "stop poll" else "poll")
            }

            Button(onClick = onExit) { Text("exit") }
        }

        Spacer(Modifier.height(10.dp))

        // Lock controls — same bus (ttyS3 @ 9600). Lets us open the door from
        // our own app so we don't need the stock app (which also fights the bus).
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = {
                hardware.openLock(1)
                lastEvent = hardware.status.value.lastEvent
            }) { Text("open door A") }

            Button(onClick = {
                hardware.openLock(2)
                lastEvent = hardware.status.value.lastEvent
            }) { Text("open door B") }

            Button(onClick = {
                hardware.readDoorState(1)
                lastEvent = hardware.status.value.lastEvent
            }) { Text("door status") }
        }

        Spacer(Modifier.height(10.dp))

        // Calibration controls. Tare zeros a tray (empty it first); calibrate
        // sets its scale using a known reference weight placed on the tray.
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(
                value = trayInput,
                onValueChange = { trayInput = it.filter { c -> c.isDigit() } },
                label = { Text("tray #") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(110.dp),
            )
            OutlinedTextField(
                value = weightInput,
                onValueChange = { weightInput = it.filter { c -> c.isDigit() } },
                label = { Text("known g") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(130.dp),
            )
            Button(onClick = {
                val t = trayInput.toIntOrNull()
                if (t != null) {
                    scope.launch {
                        busBusy = true             // hold the poll off the bus
                        delay(2500)                // let the SDK queue fully drain
                        hardware.tareTray(t)
                        delay(1500)                // give the board time to answer
                        lastEvent = hardware.status.value.lastEvent
                        // Refresh the reading so the new zero shows on screen
                        // even when the poll is switched off.
                        hardware.readWeights { w -> weights = w }
                        delay(400)
                        hardware.readWeights { w -> weights = w }
                        busBusy = false
                    }
                }
            }) { Text("tare (zero)") }

            Button(onClick = {
                val t = trayInput.toIntOrNull()
                val g = weightInput.toIntOrNull()
                if (t != null && g != null) {
                    scope.launch {
                        busBusy = true
                        delay(2500)                // let the SDK queue fully drain
                        hardware.calibrateTray(t, g)
                        delay(1500)
                        lastEvent = hardware.status.value.lastEvent
                        hardware.readWeights { w -> weights = w }
                        delay(400)
                        hardware.readWeights { w -> weights = w }
                        busBusy = false
                    }
                }
            }) { Text("calibrate") }

            // Sensor health. With a tray # entered it queries that one tray;
            // leave the field empty to scan all 16 (paced, so the bus keeps up).
            Button(onClick = {
                val t = trayInput.toIntOrNull()
                scope.launch {
                    busBusy = true
                    delay(2500)                // let the SDK queue fully drain
                    if (t != null) {
                        hardware.readSensorStatus(t)
                        delay(1500)
                    } else {
                        for (i in 0 until 16) {
                            hardware.readSensorStatus(i)
                            delay(1200)        // one at a time, paced
                        }
                    }
                    lastEvent = hardware.status.value.lastEvent
                    busBusy = false
                }
            }) { Text(if (trayInput.isBlank()) "scan sensors" else "sensor status") }
        }

        // ---- LED PRICE TAG experiment (INSTRUCT_SET_ELE_PRICE = 144) ----
        //
        // The SDK's encoding assumes a TWO-DECIMAL currency: it divides the
        // integer by 100, formats "0.00", then lights a decimal point on
        // whichever digit the dot falls after. So there is no obvious integer
        // for a plain ISK price on a 4-digit tag, and the only way to find out
        // what each candidate actually shows is to send it and look.
        //
        // Predictions for a 299 kr product, from reading the SDK:
        //   299     -> "2.99"    (dot after digit 1)
        //   2990    -> "29.90"
        //   29900   -> "299.00"  -> expect "299.0", dot lit after the 3rd digit
        //   299000  -> "2990.00" -> dot falls past digit 4, expect a clean "2990"
        // The interesting case is a FOUR-digit price: 1299 kr as 129900 should
        // render "1299" with no dot at all.
        Text("LED price tag — raw value is NOT krónur (SDK divides by 100)")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(
                value = priceInput,
                onValueChange = { priceInput = it.filter { c -> c.isDigit() } },
                label = { Text("raw value") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(150.dp),
            )
            Button(onClick = {
                val t = trayInput.toIntOrNull()
                val v = priceInput.toIntOrNull()
                if (t != null && v != null) {
                    scope.launch {
                        busBusy = true
                        delay(2500)            // let the SDK queue fully drain
                        hardware.setPriceTag(t, v)
                        delay(1200)
                        lastEvent = hardware.status.value.lastEvent
                        busBusy = false
                    }
                }
            }) { Text("send to tag") }
        }
        // One tap per candidate, so the whole experiment is four presses.
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(299, 2990, 29900, 299000, 129900).forEach { candidate ->
                Button(onClick = { priceInput = candidate.toString() }) {
                    Text(candidate.toString())
                }
            }
        }
        Text(
            "SDK will format as " +
                (priceInput.toIntOrNull()?.let { String.format("%.2f", it / 100.0) } ?: "—")
        )

        // ---- Hand-built frame: digits with NO decimal point ----
        // Iceland doesn't use decimals, and the SDK's encoder can't render a
        // three-digit price without lighting a dot. This builds the payload
        // ourselves and simply never sets that bit, so type 299 and the tag
        // should read " 299" with the leading digit blank.
        Text("raw digits — bypasses the SDK formatter, no decimal point")
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(
                value = digitsInput,
                onValueChange = { digitsInput = it.filter { c -> c.isDigit() }.take(4) },
                label = { Text("digits") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(130.dp),
            )
            Button(onClick = {
                val t = trayInput.toIntOrNull()
                if (t != null && digitsInput.isNotBlank()) {
                    scope.launch {
                        busBusy = true
                        delay(600)             // shorter than the tare guard; the poll is off
                        hardware.setPriceTagDigits(t, digitsInput)
                        delay(600)
                        lastEvent = hardware.status.value.lastEvent
                        busBusy = false
                    }
                }
            }) { Text("send digits") }

            listOf("299", "1299", "99").forEach { candidate ->
                Button(onClick = { digitsInput = candidate }) { Text(candidate) }
            }
        }

        Spacer(Modifier.height(20.dp))
        Text("trays (${weights.size})", fontSize = 14.sp, color = AppColors.Bronze)
        Spacer(Modifier.height(8.dp))

        LazyColumn(Modifier.fillMaxWidth()) {
            items(weights.entries.sortedBy { it.key }.toList()) { (addr, grams) ->
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 6.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("tray $addr", fontFamily = FontFamily.Monospace, fontSize = 15.sp, color = AppColors.Ink)
                    Text("$grams g", fontFamily = FontFamily.Monospace, fontSize = 15.sp, color = AppColors.Ink)
                }
            }
        }
    }
}
