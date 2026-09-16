package isl.snudursopi.fridge.hardware

import android.util.Log
import java.io.File

/**
 * Makes the serial devices readable/writable by this app at startup.
 *
 * THE PROBLEM: /dev/ttyS3 (weight bus + door lock) and /dev/ttyS4 (Nayax) are
 * root-only on this hardware. During bring-up we granted access by hand:
 *
 *   adb shell su 0 chmod 666 /dev/ttyS3 /dev/ttyS4
 *
 * That does NOT survive a reboot, so a power cut currently leaves the machine
 * unable to weigh, unlock, or take payment until someone turns up with a
 * laptop. For an unattended fridge in a shop corridor that's the single biggest
 * deployment blocker.
 *
 * WHAT WON'T FIX IT: Device Owner. It grants *policy* powers (lock task, app
 * management), not filesystem permissions on /dev nodes — a common assumption
 * worth writing down so nobody burns a day on it.
 *
 * WHAT MIGHT: these boards usually ship with a permissive `su` binary. If the
 * app can invoke it, it can chmod its own ports on every start and the problem
 * disappears with no external tooling. If it can't, we need a different route
 * (see [Outcome.NoSuBinary] below) — so this class is deliberately
 * SELF-DIAGNOSING: it logs exactly which step failed rather than silently
 * leaving the hardware dead.
 *
 * Idempotent and cheap: if the ports are already accessible it does nothing, so
 * it is safe to call on every launch and from the boot receiver.
 */
object TtyPermissions {

    private const val TAG = "TtyPerms"

    /** The ports this app needs. Both live on the same permission problem. */
    // ttyS3 = gravity weight bus, ttyS1 = Nayax Marshall (confirmed 2026-09-06).
    // ttyS4 kept because older machines may still be pointed at it by config
    // until they are corrected, and chmod on an unused port is harmless.
    val REQUIRED_PORTS = listOf("/dev/ttyS1", "/dev/ttyS3", "/dev/ttyS4")

    sealed class Outcome {
        /** Already readable+writable; nothing was done. The happy path. */
        object AlreadyOpen : Outcome()

        /** su worked and the ports are now accessible. */
        data class Granted(val via: String) : Outcome()

        /**
         * A su binary ran but the ports are STILL not accessible. Means su
         * exists yet didn't give us root (some builds prompt, or restrict to
         * the shell user). Next avenue: a boot-time init.d/service script, or
         * signing the app with the platform key.
         */
        data class SuFailed(val detail: String) : Outcome()

        /**
         * No usable su binary. The app cannot fix this itself; the machine
         * needs either a rooted/permissive image, a platform-signed build, or
         * an init script installed once per unit.
         */
        object NoSuBinary : Outcome()
    }

    /**
     * Ensure the ports are accessible, escalating only as far as needed.
     * Never throws — hardware bring-up decides what to do with the [Outcome].
     */
    fun ensureAccess(ports: List<String> = REQUIRED_PORTS): Outcome {
        if (ports.all { isAccessible(it) }) {
            Log.i(TAG, "ports already accessible: ${ports.joinToString(" ")}")
            return Outcome.AlreadyOpen
        }

        Log.w(TAG, "ports NOT accessible: " + ports.joinToString(" ") { "$it=${describe(it)}" })

        // Different su builds take different argument styles, so try each. The
        // order matters only for logging clarity; the first that works wins.
        val attempts = listOf(
            "su 0" to arrayOf("su", "0", "chmod", "666", *ports.toTypedArray()),
            "su -c" to arrayOf("su", "-c", "chmod 666 " + ports.joinToString(" ")),
            "su (stdin)" to arrayOf("su"),
        )

        // This runs on the main thread just before hardware init (ordering
        // matters more than latency here), so the whole operation is bounded:
        // a cold start must never stall behind a prompting su.
        val deadline = System.currentTimeMillis() + TOTAL_BUDGET_MS
        var sawSu = false
        for ((label, cmd) in attempts) {
            if (System.currentTimeMillis() > deadline) {
                Log.w(TAG, "tty grant budget exhausted — giving up for this start")
                break
            }
            val ran = runCommand(cmd, stdin = if (label == "su (stdin)") {
                "chmod 666 " + ports.joinToString(" ") + "\nexit\n"
            } else null)
            if (ran == null) {
                // exec failed = no su binary on this image. The other variants
                // invoke the SAME binary, so there is nothing to gain by trying
                // them — bail out fast rather than burning the budget.
                break
            }
            sawSu = true
            if (ports.all { isAccessible(it) }) {
                Log.i(TAG, "granted via '$label' (exit=$ran)")
                return Outcome.Granted(label)
            }
            Log.w(TAG, "'$label' ran (exit=$ran) but ports still closed")
        }

        return if (sawSu) {
            val detail = ports.joinToString(" ") { "$it=${describe(it)}" }
            Log.e(
                TAG,
                "su present but could not open ports — needs an init script or a " +
                    "platform-signed build. State: $detail",
            )
            Outcome.SuFailed(detail)
        } else {
            Log.e(
                TAG,
                "no usable su binary — this app cannot grant its own port access on " +
                    "this image. Hardware will stay unavailable until granted externally.",
            )
            Outcome.NoSuBinary
        }
    }

    /**
     * True when the app can actually open the node. Checked rather than assumed:
     * the permission BITS can look right while SELinux still refuses, and only
     * a real read/write check catches that.
     */
    private fun isAccessible(path: String): Boolean {
        val f = File(path)
        return f.exists() && f.canRead() && f.canWrite()
    }

    private fun describe(path: String): String {
        val f = File(path)
        if (!f.exists()) return "missing"
        return buildString {
            append(if (f.canRead()) "r" else "-")
            append(if (f.canWrite()) "w" else "-")
        }
    }

    /**
     * Run a command, returning its exit code, or null if the binary could not
     * be executed at all (which is how we distinguish "no su" from "su said
     * no"). Bounded so a prompting su can't hang startup forever.
     */
    private fun runCommand(cmd: Array<String>, stdin: String?): Int? {
        return try {
            val proc = Runtime.getRuntime().exec(cmd)
            if (stdin != null) {
                runCatching {
                    proc.outputStream.bufferedWriter().use { it.write(stdin) }
                }
            }
            // A permissive su returns immediately; a prompting one would block,
            // so cap the wait and treat a timeout as failure rather than hanging
            // the whole app on a screen a customer is standing in front of.
            val finished = waitFor(proc, TIMEOUT_MS)
            if (!finished) {
                runCatching { proc.destroy() }
                Log.w(TAG, "'${cmd.joinToString(" ")}' timed out after ${TIMEOUT_MS}ms")
                return -1
            }
            proc.exitValue()
        } catch (e: Exception) {
            // IOException here almost always means "binary not found".
            Log.w(TAG, "could not exec '${cmd.first()}': ${e.message}")
            null
        }
    }

    /** waitFor(timeout) is API 26+; this keeps the floor at our minSdk 24. */
    private fun waitFor(proc: Process, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            try {
                proc.exitValue()
                return true
            } catch (_: IllegalThreadStateException) {
                Thread.sleep(50)
            }
        }
        return false
    }

    /** Per-attempt cap. A permissive su returns in milliseconds. */
    private const val TIMEOUT_MS = 1_500L

    /** Cap across ALL attempts, so cold start can't stall on a prompting su. */
    private const val TOTAL_BUDGET_MS = 2_500L
}
