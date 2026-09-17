package isl.snudursopi.fridge.data.backend

import android.util.Log
import isl.snudursopi.fridge.domain.Cabinet
import isl.snudursopi.fridge.domain.Planogram
import isl.snudursopi.fridge.hardware.FridgeHardwareController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Polls the backend's command queue and carries commands out.
 *
 * Two execution rules, both told to the backend so a pending command isn't read
 * as a broken machine:
 *  - NOTHING runs while a customer is mid-purchase. A command enqueued during a
 *    sale sits until the session ends — worst case a couple of minutes.
 *  - Scale operations silence the weight poll first, via [withBusQuiet]. That is
 *    the constraint that made tare unreliable before: about 15% success with the
 *    poll running, 100% with it stopped.
 *
 * Unknown command types come back as `unsupported` rather than `failed`, because
 * during a staged OTA the fleet runs mixed versions and "this build is too old
 * for that" is a different fact from "it broke".
 */
class CommandRunner(
    private val client: CommandClient,
    private val hardware: FridgeHardwareController,
    /** Latest planogram, for validating basket numbers against what exists. */
    private val planogram: () -> Planogram?,
    /** True while a customer is mid-purchase. */
    private val isSessionActive: () -> Boolean,
    /** Runs a block with the weight poll held off the bus. */
    private val withBusQuiet: suspend (suspend () -> Unit) -> Unit,
    /** Enter restock for one cabinet: unlock it, stop charging, re-baseline on close. */
    private val beginRestock: (cabinet: Int) -> Unit,
    /** Run an update check now and describe the outcome. Null if not wired. */
    private val onCheckUpdate: (suspend () -> String)? = null,
    /** Push the LED price tags now; returns what it did. Null if not wired. */
    private val onSyncPriceTags: (suspend (force: Boolean) -> String)? = null,
    /** Read the cabinet temperature now; null when the board does not answer. */
    private val onReadTemp: (suspend () -> String?)? = null,
    /** Read-only RS-485 address sweep; returns which addresses answered. */
    private val onProbeAddresses: (suspend () -> String)? = null,
    /** Relaunch the app after a delay, then kill this process. */
    private val onRestartApp: ((delayMs: Long) -> Unit)? = null,
    /** Surrender Device Owner so the app can be uninstalled. Guarded. */
    private val onClearDeviceOwner: (suspend () -> String)? = null,
    /** Point the Nayax link at a different serial port. */
    private val onSetPaymentPort: (suspend (String) -> String)? = null,
    /** Open TeamViewer QuickSupport on the machine's screen. */
    private val onLaunchSupport: (suspend () -> String)? = null,
    /** Reboot the whole board. Device Owner only; this process does not survive it. */
    private val onRestartMachine: (suspend () -> String)? = null,
) {
    fun start(scope: CoroutineScope) {
        scope.launch {
            while (isActive) {
                runCatching { pollOnce() }
                    .onFailure { Log.w(TAG, "command poll failed: ${it.message}") }
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    private suspend fun pollOnce() {
        val pending = client.pending()
        if (pending.isEmpty()) return

        // Don't even start while someone is shopping — the bus and the door both
        // belong to them until they're done.
        if (isSessionActive()) {
            Log.i(TAG, "${pending.size} command(s) waiting, but a customer session is live — deferring")
            return
        }

        for (cmd in pending) {
            val outcome = runCatching { execute(cmd) }
                .getOrElse { CommandOutcome.Failed(it.message ?: it.javaClass.simpleName) }
            Log.i(TAG, "command ${cmd.type} (${cmd.id}) -> ${outcome.status}: ${outcome.detail}")
            // Report even if the work failed; an unreported command looks stuck
            // forever on the dashboard.
            runCatching { client.report(cmd.id, outcome) }
                .onFailure { Log.w(TAG, "could not report ${cmd.id}: ${it.message}") }
        }
    }

    private suspend fun execute(cmd: MachineCommand): CommandOutcome = when (cmd.type) {
        "fridge_open_door" -> openDoor(cmd)
        "scale_read" -> scaleRead(cmd)
        "scale_calibrate" -> scaleCalibrate(cmd)
        "scale_tare" -> scaleTare(cmd)
        "tare_all" -> tareAll(cmd)
        "check_update" -> checkUpdate()
        // *** BOTH NAMES. The dashboard sends set_temp; we implemented
        // set_cooling. Every temperature command from the Controls tab was
        // silently answered "unsupported" and nothing happened — visible only
        // in the relayed log, and only because we happened to read it.
        // Accepting both is a one-line fix on our side against a dashboard
        // change on theirs.
        "set_cooling", "set_temp" -> setCooling(cmd)
        "sync_price_tags" -> syncPriceTags(cmd)
        "read_temp" -> readTemp()
        "restart_app" -> restartApp()
        "clear_device_owner" -> clearDeviceOwner(cmd)
        "set_payment_port" -> setPaymentPort(cmd)
        "launch_support" -> launchSupport()
        "read_all_trays" -> readAllTrays()
        "set_led" -> setLed(cmd)
        "defrost" -> defrost(cmd)
        "restart_machine" -> restartMachine()
        // probe_addresses REMOVED in v0.49.1 — it reported "answered=0, NO
        // modules on the bus" in the same minute read_all_trays returned 27
        // working trays. The probe was wrong, not the bus. A diagnostic that
        // lies is worse than no diagnostic: it sent us looking for a wiring
        // fault that did not exist. Use read_all_trays, which reads the real
        // weight replies.
        "probe_addresses" -> CommandOutcome.Unsupported(
            "probe_addresses withdrawn — it gave false negatives; use read_all_trays",
        )
        else -> CommandOutcome.Unsupported("this build does not handle '${cmd.type}'")
    }

    // ---- handlers ----

    /**
     * Restocking. The open-door command IS the trigger; the door CLOSING ends it
     * and re-reads the baseline weights. Only one door at a time.
     */
    private fun openDoor(cmd: MachineCommand): CommandOutcome {
        val cabinet = cmd.str("cabinet")?.uppercase()
            ?: return CommandOutcome.Failed("missing cabinet")
        val door = when (cabinet) {
            "A" -> 1
            "B" -> 2
            else -> return CommandOutcome.Failed("unknown cabinet '$cabinet'")
        }
        val spec = planogram()?.spec
        if (spec != null && door > spec.cabinets.size) {
            return CommandOutcome.Failed("this machine has no cabinet $cabinet")
        }
        beginRestock(door)
        return CommandOutcome.Ok("cabinet $cabinet unlocked for restocking")
    }

    /**
     * Cooling control from the dashboard.
     *
     * The backend has been sending this and getting "unsupported" back — the
     * command existed on their side with no implementation on ours. Worth
     * having in its own right, but it became urgent because the Weimi app is no
     * longer installed on this machine, so there was no way at all to switch
     * cooling on without putting a second serial-grabbing app back on it.
     *
     * Accepts either {enabled: bool} or {on: bool}, and an optional
     * {targetC: int} in WHOLE degrees, clamped to 1..15 by the hardware layer.
     */
    private fun setCooling(cmd: MachineCommand): CommandOutcome {
        val target = cmd.int("targetC") ?: cmd.int("target") ?: cmd.int("tempC")
        // *** A TARGET ON ITS OWN MEANS "COOL TO THIS".
        //
        // The dashboard's set_temp sends a temperature and no on/off flag,
        // which is the sensible shape — asking for 4 C is asking for cooling.
        // Demanding 'enabled' made every dashboard temperature command fail
        // with "missing 'enabled'", which reads like a machine fault rather
        // than a contract mismatch.
        val enabled = when {
            cmd.params?.has("enabled") == true -> cmd.bool("enabled")
            cmd.params?.has("on") == true -> cmd.bool("on")
            target != null -> true
            else -> return CommandOutcome.Failed(
                "give a target temperature, or 'enabled' to turn cooling on or off",
            )
        }
        if (target != null && target !in 1..15) {
            return CommandOutcome.Failed("targetC $target out of range (1-15)")
        }
        hardware.setCooling(enabled, target)
        // Deliberately NOT reported as confirmed: the command is fire-and-forget
        // over the serial bus and the board does not acknowledge. Claiming
        // success here would be asserting something we have not observed.
        return CommandOutcome.Ok(
            "cooling ${if (enabled) "on" else "off"}" +
                (target?.let { ", target ${it}C" } ?: "") +
                " — sent to the board; not acknowledged, verify with a temperature read",
        )
    }

    /**
     * Push the price tags on demand.
     *
     * Exists because a price changed in the dashboard and the shelf kept showing
     * the old one, with no way to see why or fix it from 20 km away. The result
     * carries the actual counts, so "pushed 0" tells you the cache thinks
     * everything is current — which is itself the diagnosis.
     *
     * {force: true} rewrites every tag regardless of the cache. Use it when a
     * shelf disagrees with the dashboard.
     */
    /**
     * On-demand cabinet temperature.
     *
     * Reports the reading rather than merely confirming the request, because a
     * command that says "requested" and shows nothing is the dead control we
     * asked the backend not to ship.
     */
    /**
     * Dump every tray the board reports, as a raw index->grams list.
     *
     * *** THE DOUBLE-CABINET MAPPING HAS NEVER BEEN VERIFIED ON HARDWARE.
     *
     * [Basket.trayIndex] assumes ONE flat bus where cabinet B continues at tray
     * 16. If a double instead exposes two independent 0-15 buses, every cabinet
     * B reading is wrong — and it fails invisibly, because cabinet A is correct
     * throughout and the machine looks healthy.
     *
     * This answers it in one command: put a known weight in cabinet B basket 1
     * and run this. If tray 16 shows it, the flat mapping holds. If tray 0
     * moves instead, there are two buses and Basket.trayIndex is the one line
     * that changes.
     */
    /**
     * Read-only sweep of RS-485 addresses 0..31. Changes nothing.
     *
     * Diagnoses a machine whose second cabinet reports no gravity boards: it
     * says how many modules are actually on the bus, which distinguishes "not
     * connected" from "connected but colliding on factory addresses".
     */
    private suspend fun probeAddresses(): CommandOutcome {
        val probe = onProbeAddresses
            ?: return CommandOutcome.Unsupported("this build cannot probe addresses")
        return CommandOutcome.Ok(probe())
    }

    private suspend fun readAllTrays(): CommandOutcome {
        val plan = planogram() ?: return CommandOutcome.Failed("no planogram loaded yet")
        // Cabinet B is addressed from 20, so a double spans 0..15 and 20..35 —
        // 16 modules per cabinet, but NOT a contiguous range.
        val expected = plan.spec.cabinets.size * Planogram.BASKETS_PER_CABINET
        var weights: Map<Int, Int>? = null
        withBusQuiet { weights = hardware.readWeightsFresh() }
        val w = weights
        if (w.isNullOrEmpty()) return CommandOutcome.Failed("no tray data returned")
        val line = w.toSortedMap().entries.joinToString(" ") { "#${it.key}=${it.value}g" }
        return CommandOutcome.Ok("expecting $expected trays, got ${w.size} — $line")
    }

    /**
     * Restart the kiosk app.
     *
     * *** NEEDED BECAUSE SEVERAL THINGS ONLY HAPPEN AT STARTUP.
     *
     * The Marshall payment link is the sharp case: link.start() runs once and
     * then waits. If the Nayax terminal restarts — a firmware load, a power
     * cut — our app never notices, because it is still waiting on a handshake
     * it attempted hours earlier. Until now the only fix was adb or an operator
     * at the machine.
     *
     * The result is reported BEFORE the restart, since the process will be gone
     * before any later message could be sent.
     */
    /**
     * Give up Device Owner so the app can be uninstalled.
     *
     * *** GUARDED ON PURPOSE. Requires {confirm: "yes"}.
     *
     * This is not a routine command. Surrendering Device Owner also surrenders
     * silent OTA — the machine can no longer update itself, and every future
     * build needs someone physically at it with adb. Firing this by accident on
     * a placed machine turns a remotely maintainable fridge into one that needs
     * a site visit for every change.
     *
     * It exists because Android makes a Device Owner package otherwise
     * impossible to remove: not force-stoppable, not clearable, not
     * uninstallable. Without this the only alternative is a factory reset,
     * which destroys every remote channel on the board at once.
     */
    /**
     * Point the Nayax link at a different serial port and reconnect.
     *
     * *** THE PORT HAS NEVER BEEN VERIFIED ON GRAVITY HARDWARE. ttyS4 was
     * inherited and has never produced a received byte on 8626020716, while
     * Weimi's own app handshakes with the same terminal on the same board.
     * The coil machines use ttyS3 for Nayax; our ttyS3 is the weight bus, so
     * the assignment differs by machine type and ours is unconfirmed.
     *
     * Exists so the candidates can be tried from a dashboard rather than one
     * rebuild and one site visit per attempt.
     */
    private suspend fun setPaymentPort(cmd: MachineCommand): CommandOutcome {
        val path = cmd.str("port")
            ?: return CommandOutcome.Failed("give a port, e.g. {port:\"/dev/ttyS1\"}")
        if (!Regex("^/dev/ttyS[0-9]$").matches(path)) {
            return CommandOutcome.Failed("refused: '$path' is not a /dev/ttySn path")
        }
        // ttyS3 carries the weight bus on this hardware. Opening a second
        // reader on it would corrupt weights AND payment at once.
        if (path == "/dev/ttyS3") {
            return CommandOutcome.Failed("refused: ttyS3 is the gravity weight bus")
        }
        val set = onSetPaymentPort
            ?: return CommandOutcome.Unsupported("this build cannot change the payment port")
        return CommandOutcome.Ok(set(path))
    }

    private suspend fun clearDeviceOwner(cmd: MachineCommand): CommandOutcome {
        if (cmd.str("confirm") != "yes") {
            return CommandOutcome.Failed(
                "refused — send {confirm:\"yes\"}. This gives up silent OTA: " +
                    "the machine cannot update itself afterwards without adb on site.",
            )
        }
        val clear = onClearDeviceOwner
            ?: return CommandOutcome.Unsupported("this build cannot clear Device Owner")
        return CommandOutcome.Ok(clear())
    }

    private suspend fun restartApp(): CommandOutcome {
        val restart = onRestartApp
            ?: return CommandOutcome.Unsupported("this build cannot restart itself")
        // Give the poller time to report this result to the backend first.
        restart(3_000L)
        return CommandOutcome.Ok("restarting in 3s")
    }

    /**
     * Cabinet lighting, instant override.
     *
     * The durable policy lives in the machine config as an `led` block; this is
     * the "light it up to restock" / "does the wiring work" button, and the app
     * returns to the config policy on the next apply — the same relationship
     * set_aisle_enabled has with disabledAisles. The config half is NOT yet
     * implemented; this command is.
     *
     * *** OK HERE MEANS "SENT", NOT "THE LIGHTS CHANGED".
     *
     * The board does not acknowledge, and the SDK parameter mapping is inferred
     * rather than observed (see MotorFridgeHardware.setLedBrightness). The
     * backend derives ledCapability from this very answer and shows it as the
     * machine's own words, so the detail string has to carry that doubt — a
     * bare "ok" would flip the dashboard from an honest "cannot" to a confident
     * "working" on no evidence, which is worse than the dead button it
     * replaces.
     */
    private fun setLed(cmd: MachineCommand): CommandOutcome {
        val brightness = cmd.int("brightness")
            ?: return CommandOutcome.Failed("set_led needs params.brightness (0-100, 0 is off)")
        if (brightness !in 0..100) {
            return CommandOutcome.Failed("brightness $brightness out of range (0-100)")
        }
        hardware.setLedBrightness(brightness)
        return CommandOutcome.Ok(
            "sent ctlLed brightness=$brightness — NOT confirmed: the board does not " +
                "acknowledge and the parameter mapping is unverified. Watch the cabinet.",
        )
    }

    /**
     * Defrost cycle, on or off.
     *
     * Accepts {on: bool} or {enabled: bool}; absent means start one, since
     * asking for defrost is asking for it to run.
     *
     * Same "sent, not confirmed" rule as [setLed], with an extra reason to
     * doubt: this board runs its own thermostat and ignores ctrlCompressor
     * outright, so it may well own the defrost schedule too.
     */
    private fun defrost(cmd: MachineCommand): CommandOutcome {
        val on = when {
            cmd.params?.has("on") == true -> cmd.bool("on")
            cmd.params?.has("enabled") == true -> cmd.bool("enabled")
            else -> true
        }
        hardware.setDefrost(on)
        return CommandOutcome.Ok(
            "sent ctrlDefrost ${if (on) "on" else "off"} — NOT confirmed; the board does " +
                "not acknowledge and may run defrost on its own schedule regardless.",
        )
    }

    /**
     * Reboot the board, as distinct from restart_app.
     *
     * *** THE RESULT IS REPORTED BEFORE THE WORK HAPPENS, WHICH IS BACKWARDS
     * FOR EVERY OTHER COMMAND HERE.
     *
     * A reboot kills this process, so a result posted afterwards never gets
     * sent and the command sits pending forever — which reads on the dashboard
     * as a machine that died, exactly when someone is watching to see whether
     * it came back. So the reboot is deferred briefly and the outcome returned
     * now, letting the poller report before the board goes down.
     */
    private suspend fun restartMachine(): CommandOutcome {
        val reboot = onRestartMachine
            ?: return CommandOutcome.Unsupported("this build cannot reboot the board")
        return CommandOutcome.Ok(reboot())
    }

    /**
     * Bring TeamViewer QuickSupport up on the machine's screen.
     *
     * The operator still has to accept the session — that is QuickSupport's
     * design and not something we can or should bypass. What this removes is
     * the hard part: talking someone through finding an app on a kiosk with no
     * navigation bar. They press one button that is already on screen.
     */
    private suspend fun launchSupport(): CommandOutcome {
        val launch = onLaunchSupport
            ?: return CommandOutcome.Unsupported("this build cannot launch support")
        return CommandOutcome.Ok(launch())
    }

    private suspend fun readTemp(): CommandOutcome {
        val read = onReadTemp ?: return CommandOutcome.Unsupported(
            "this build cannot read temperature",
        )
        return when (val t = read()) {
            null -> CommandOutcome.Failed("no reading from the board")
            else -> CommandOutcome.Ok(t)
        }
    }

    private suspend fun syncPriceTags(cmd: MachineCommand): CommandOutcome {
        val sync = onSyncPriceTags
            ?: return CommandOutcome.Unsupported("no price tag sync wired in this build")
        val plan = planogram()
            ?: return CommandOutcome.Failed("no planogram loaded yet")
        val force = cmd.bool("force")
        // Held off the bus like any other tag write: the weight poll and a live
        // cart both need it more than a label does.
        var result = ""
        withBusQuiet { result = sync(force) }
        return CommandOutcome.Ok("${plan.baskets.size} basket(s): $result")
    }

    /**
     * Tare every basket in the planogram in one go, with the machine EMPTY.
     *
     * *** THIS EXISTS BECAUSE 32 SEPARATE COMMANDS IS HOW MISTAKES HAPPEN.
     *
     * A moved or newly assembled machine needs every basket zeroed, and the
     * offsets are large — we have seen -190 g to +155 g on an empty double. One
     * command per basket means 32 console calls, and the fleet is 46 machines.
     *
     * Same guard as the single tare: a basket reading more than 15 g either way
     * is refused unless {force: true}, because taring a LOADED basket sets a
     * false zero and mis-charges every later sale from it. On a machine that has
     * just been moved, force is normally what you want — the offsets are drift,
     * not product — but it must be a deliberate choice, so it is reported per
     * basket rather than hidden.
     *
     * Reports every basket individually. A silent partial success is worse than
     * a clear list of what did and did not take.
     */
    private suspend fun tareAll(cmd: MachineCommand): CommandOutcome {
        val plan = planogram() ?: return CommandOutcome.Failed("no planogram loaded yet")
        if (plan.baskets.isEmpty()) return CommandOutcome.Failed("planogram has no baskets")
        val force = cmd.bool("force")

        val done = mutableListOf<String>()
        val refused = mutableListOf<String>()
        val failed = mutableListOf<String>()

        withBusQuiet {
            for (basket in plan.baskets.sortedBy { it.trayIndex }) {
                val tray = basket.trayIndex
                val name = "${basket.cabinet}${basket.basket}"
                val grams = hardware.readTraysFresh(tray, 1)?.get(tray)
                if (grams == null) {
                    // No reply at all — an absent module, not a loaded basket.
                    failed += "$name(no reply)"
                    continue
                }
                if (!force && kotlin.math.abs(grams) > EMPTY_THRESHOLD_G) {
                    refused += "$name(${grams}g)"
                    continue
                }
                hardware.tareTray(tray)
                done += name
                // Space the writes; the bus is shared and a burst of 32 tares
                // is exactly the kind of traffic that has caused trouble here.
                delay(300)
            }
        }

        val parts = buildList {
            add("tared ${done.size}/${plan.baskets.size}")
            if (refused.isNotEmpty()) add("refused (not empty): ${refused.joinToString(",")}")
            if (failed.isNotEmpty()) add("no reply: ${failed.joinToString(",")}")
        }
        val summary = parts.joinToString(" — ")
        return if (done.isEmpty()) CommandOutcome.Failed(summary) else CommandOutcome.Ok(summary)
    }

    private suspend fun scaleRead(cmd: MachineCommand): CommandOutcome {
        val tray = trayOf(cmd) ?: return CommandOutcome.Failed("missing or unknown basket")
        var grams: Int? = null
        withBusQuiet { grams = hardware.readTraysFresh(tray, 1)?.get(tray) }
        return grams?.let { CommandOutcome.Ok("${label(cmd)}: $it g") }
            ?: CommandOutcome.Failed("${label(cmd)}: no reply from the scale")
    }

    private suspend fun scaleCalibrate(cmd: MachineCommand): CommandOutcome {
        val tray = trayOf(cmd) ?: return CommandOutcome.Failed("missing or unknown basket")
        val reference = cmd.int("referenceWeightG")
            ?: return CommandOutcome.Failed("missing referenceWeightG")
        if (reference <= 0) return CommandOutcome.Failed("referenceWeightG must be positive")
        withBusQuiet { hardware.calibrateTray(tray, reference) }
        return CommandOutcome.Ok("${label(cmd)} calibrated against ${reference} g")
    }

    /**
     * Tare (the stock app calls it "clear"). Zeroes at whatever load is on the
     * basket, so a tare with product on it sets a false baseline and mis-charges
     * every later sale on that basket. We refuse and report the grams we can see;
     * `force: true` is the deliberate override for a basket with a permanent
     * insert that should be part of the zero.
     */
    private suspend fun scaleTare(cmd: MachineCommand): CommandOutcome {
        val tray = trayOf(cmd) ?: return CommandOutcome.Failed("missing or unknown basket")
        val force = cmd.bool("force")
        var refusal: String? = null

        withBusQuiet {
            if (!force) {
                val grams = hardware.readTraysFresh(tray, 1)?.get(tray)
                if (grams == null) {
                    refusal = "${label(cmd)}: no reply from the scale, not taring blind"
                    return@withBusQuiet
                }
                // *** SYMMETRIC. This used to test `grams > threshold` only, so
                // a tray reading -210 g tared without complaint while one
                // reading +56 g was refused — both equally wrong, only one
                // caught. Offsets drift in both directions after a machine is
                // moved, which is exactly when someone reaches for tare.
                if (kotlin.math.abs(grams) > EMPTY_THRESHOLD_G) {
                    refusal = "${label(cmd)} reads $grams g — empty it first, " +
                        "or re-send with force if it IS empty and the offset has drifted"
                    return@withBusQuiet
                }
            }
            hardware.tareTray(tray)
        }

        return refusal?.let { CommandOutcome.Failed(it) }
            ?: CommandOutcome.Ok(
                "${label(cmd)} zeroed" + if (force) " (forced)" else "",
            )
    }

    /**
     * Look for an app update now, on the backend's instruction.
     *
     * Without this there is no remote way to make a machine check: the timer is
     * the only other trigger, and once Device Owner + Lock Task are active adb
     * can't even force-stop the app to restart it. This turns "update that
     * machine" into a dashboard button from anywhere.
     */
    private suspend fun checkUpdate(): CommandOutcome {
        val check = onCheckUpdate
            ?: return CommandOutcome.Unsupported("no updater wired in this build")
        return CommandOutcome.Ok(check())
    }

    // ---- helpers ----

    /**
     * Protocol tray for a command's basket.
     *
     * MUST use the cabinet. Basket numbers run 1-16 WITHIN EACH CABINET, so
     * `basket` alone is ambiguous on a double — cabinet B's basket 1 is a
     * different physical basket from cabinet A's. Resolving through the
     * planogram means the mapping lives in exactly one place (Basket.trayIndex)
     * rather than being re-derived here.
     *
     * Returns null for a basket this machine doesn't have, so a bad command
     * comes back as a clear refusal rather than acting on the wrong basket.
     */
    private fun trayOf(cmd: MachineCommand): Int? {
        val basket = cmd.int("basket") ?: return null
        if (basket < 1 || basket > Planogram.BASKETS_PER_CABINET) return null
        val cabinet = when (cmd.str("cabinet")?.uppercase()) {
            "A", null -> Cabinet.A   // absent cabinet means a single
            "B" -> Cabinet.B
            else -> return null
        }
        val spec = planogram()?.spec
        if (spec != null && cabinet !in spec.cabinets) return null
        // *** ADDRESS_BLOCK (20), NOT BASKETS_PER_CABINET (16).
        //
        // This was 16 until 2026-09-06 — Basket.trayIndex was corrected when
        // Weimi confirmed cabinet B addresses from 20, and THIS copy of the same
        // arithmetic was missed. The consequence was silent and dangerous:
        //   cabinet B basket 1 -> tray 16, which does not exist (no reply)
        //   cabinet B basket 5 -> tray 20, which IS cabinet B basket 1
        // So a tare or calibrate aimed at B5 landed on B1, and every later sale
        // from that basket would have been mis-charged with no error anywhere.
        //
        // tare_all was never affected — it walks the planogram and uses
        // Basket.trayIndex, which was already correct. Only the single-basket
        // commands used this path.
        return cabinet.ordinal * Planogram.ADDRESS_BLOCK_PER_CABINET + (basket - 1)
    }

    /** How to name a basket in a message — the number alone is ambiguous. */
    private fun label(cmd: MachineCommand): String =
        "cabinet ${cmd.str("cabinet")?.uppercase() ?: "A"} basket ${cmd.int("basket")}"

    private companion object {
        const val TAG = "CommandRunner"

        /**
         * Poll cadence. 5s because the operator case decides it: the machine is
         * idle precisely when someone is standing at it restocking, so polling
         * slowly when idle would be exactly backwards. 46 machines at 5s is about
         * 9 requests/second across the fleet — the backend has the arithmetic and
         * can ask for 10s if that's uncomfortable.
         */
        const val POLL_INTERVAL_MS = 5_000L

        /**
         * A basket reading at or below this counts as empty for the tare guard.
         * Matches the settlement noise floor: thermal drift alone moves an empty
         * basket by several grams over a few hours.
         */
        const val EMPTY_THRESHOLD_G = 15
    }
}
