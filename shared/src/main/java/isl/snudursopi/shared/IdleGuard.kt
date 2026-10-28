package isl.snudursopi.shared

import android.util.Log
import java.util.concurrent.atomic.AtomicLong

/**
 * Keeps one (or more) CPU cores out of the board's deep idle state.
 *
 * *** THE BOARD CAN STOP EXECUTING FOR 44 MINUTES WITH NOTHING WRONG IN THE APP.
 *
 * Grótta vinstri (62160479, WM55 / Rockchip), 2026-10-27 19:31 and 2026-10-28 04:44: every
 * process on the board went silent for exactly 2,681 s each time — the kernel's own 60-second
 * heartbeat included — while the kernel never entered suspend (suspend_stats: 0) and its clock
 * kept counting. Each time the board came back on an interrupt from outside the CPU: the router
 * dropping the silent client after its inactivity timeout. Its sibling hægri, same board, same
 * wall branch, same router, never stalled; the difference is a USB device on hægri's port that
 * interrupts all the time. The reading is: all four cores in the `cpu-sleep` state (powered
 * down, residency 1 ms) and the timer wake that should end it lost, until some other interrupt
 * arrives. A firmware fault of the board; nothing an app can fix at its root.
 *
 * What an app can do: keep a core from ever entering that state. A thread that wakes every
 * [intervalUs] microseconds (default 500, below the 1,000 µs residency of `cpu-sleep`) makes the
 * idle governor keep its core in `WFI`, the light state whose own timer always works. One core
 * waking 2,000 times a second costs about a percent of it, on a machine on mains. Off by
 * default; switched on per machine from the dashboard (config.idleGuard) so the effect can be
 * measured on one machine before the next. Measured with the kernel heartbeat gaps:
 *   dmesg | grep healthd | awk -F'[][]' '{t=$2+0; if (p && t-p>120) print "gap", t-p, "ending at", t; p=t}'
 */
object IdleGuard {
    private const val TAG = "IdleGuard"
    @Volatile private var running = false
    @Volatile private var threads: List<Thread> = emptyList()
    @Volatile private var threadCount = 0
    @Volatile private var intervalUs = 0
    private val wakeups = AtomicLong()

    /** Bring the guard in line with the config. Restarts only when a parameter changed. */
    @Synchronized
    fun apply(enabled: Boolean, threads: Int, intervalUs: Int) {
        val n = threads.coerceIn(1, 8)
        val us = intervalUs.coerceIn(100, 10_000)
        if (!enabled) { if (running) stop(); return }
        if (running && n == threadCount && us == this.intervalUs) return
        if (running) stop()
        start(n, us)
    }

    private fun start(n: Int, us: Int) {
        running = true
        threadCount = n
        intervalUs = us
        wakeups.set(0)
        threads = (1..n).map { i ->
            Thread({ loop(us) }, "idle-guard-$i").apply { isDaemon = true; priority = Thread.MIN_PRIORITY; start() }
        }
        Log.i(TAG, "on: $n thread(s) waking every $us µs")
    }

    private fun loop(us: Int) {
        val ms = (us / 1000).toLong()
        val ns = (us % 1000) * 1000
        while (running) {
            try { Thread.sleep(ms, ns) } catch (e: InterruptedException) { /* stop() */ }
            wakeups.incrementAndGet()
        }
    }

    @Synchronized
    private fun stop() {
        running = false
        threads.forEach { it.interrupt() }
        threads = emptyList()
        Log.i(TAG, "off after ${wakeups.get()} wakeups")
    }

    fun status(): String = if (running) "on ($threadCount × $intervalUs µs, ${wakeups.get()} wakeups)" else "off"
}
