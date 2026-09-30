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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import isl.snudursopi.fridge.hardware.nayax.NayaxLink
import isl.snudursopi.fridge.ui.theme.AppColors

/**
 * On-machine bring-up for the Nayax reader (/dev/ttyS4 @ 115200), separate from
 * the weight bus on ttyS3.
 *
 * The reader shows "Cashless out of order — Machine fault (V00)" whenever no
 * host is driving the serial link. Tapping CONNECT starts the Marshall VMC
 * framework, which does the handshake; V00 should clear and the reader go idle
 * and ready. That alone proves the port, wiring and protocol before any money
 * moves.
 *
 * WARNING: "charge" runs a REAL transaction against a REAL card. Keep the
 * amount tiny and refund from the Nayax portal.
 */
@Composable
fun PaymentTestScreen(onExit: () -> Unit) {
    val lines = remember { mutableStateListOf<String>() }
    var state by remember { mutableStateOf("not connected") }
    var amount by remember { mutableStateOf("1") }

    // The SHARED controller — creating a second one here would put two link
    // threads on ttyS4 and every SDK event would fire twice.
    val controller = remember { NayaxLink.controller }

    // Mirror the controller's output into the on-screen pane while this screen
    // is up. Do NOT disconnect on exit — the link is shared with the purchase
    // flow and tearing it down would take payment offline for the whole app.
    DisposableEffect(Unit) {
        val previous = controller.onLogLine
        controller.onLogLine = { line ->
            lines.add(0, line)
            if (lines.size > 200) lines.removeAt(lines.lastIndex)
        }
        onDispose { controller.onLogLine = previous }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(AppColors.Cream)
            .padding(24.dp)
    ) {
        Text("payment test — /dev/ttyS4 @ 115200", fontSize = 22.sp, color = AppColors.Ink)
        Spacer(Modifier.height(4.dp))
        Text(
            "state: $state",
            fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = AppColors.Muted,
        )
        Text(
            "charge = REAL money. keep it small, refund in the Nayax portal.",
            fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = AppColors.Bronze,
        )
        Spacer(Modifier.height(16.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = {
                state = "connecting…"
                controller.onReaderStateChanged = { ready ->
                    state = if (ready) "READY (V00 should be gone)" else "not ready"
                }
                controller.connect { state = "READY (V00 should be gone)" }
            }) { Text("connect") }

            Button(onClick = {
                runCatching { controller.disconnect() }
                state = "disconnected"
            }) { Text("disconnect") }

            Button(onClick = { controller.cancel(); state = "cancelled" }) { Text("cancel") }

            Button(onClick = onExit) { Text("exit") }
        }

        Spacer(Modifier.height(10.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(
                value = amount,
                onValueChange = { amount = it.filter { c -> c.isDigit() } },
                label = { Text("kr") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(120.dp),
            )
            Button(onClick = {
                val kr = amount.toIntOrNull()
                if (kr == null || kr <= 0) {
                    lines.add(0, "enter an amount first")
                } else {
                    state = "charging $kr kr — tap card"
                    controller.charge(kr) { result ->
                        state = "result: $result"
                    }
                }
            }) { Text("charge") }
        }

        Spacer(Modifier.height(20.dp))
        Text("log", fontSize = 14.sp, color = AppColors.Bronze)
        Spacer(Modifier.height(8.dp))

        LazyColumn(Modifier.fillMaxWidth()) {
            items(lines) { line ->
                Text(
                    line,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = AppColors.Ink,
                    modifier = Modifier.padding(vertical = 2.dp),
                )
            }
        }
    }
}
