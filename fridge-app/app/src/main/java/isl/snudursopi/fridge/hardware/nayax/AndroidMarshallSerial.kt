package isl.snudursopi.fridge.hardware.nayax

import android.util.Log
import com.bitmick.marshall.interfaces.lowlevel_i
import com.weimi.serialport.SerialportSocket
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream

/**
 * Android serial transport for the Nayax Marshall Java SDK.
 *
 * The Marshall SDK is decoupled from serial I/O via the [lowlevel_i] interface
 * (the desktop demo implemented it with jSerialComm, which doesn't work on
 * Android). This implementation backs it with Weimi's proven native serial
 * library (SerialportSocket + libWeimiSerialPort.so), which opens /dev/ttyS4
 * at 115200 8N1 the same way the stock app does.
 *
 * The SDK calls:
 *   init(port, baud) -> we remember them
 *   register_link_events(cb) -> we keep the callback to push received frames
 *   start() -> open the port + spawn a read thread
 *   transmit(bytes, len) -> write to the port
 *   stop()/reset()
 *
 * The read thread mirrors the demo's framing: read bytes, the first 2 bytes are
 * the frame length (big-endian-ish per Marshall), and when a full frame is
 * buffered we call link_events.onReceive(buf, 0, expectedLen).
 */
class AndroidMarshallSerial : lowlevel_i {

    companion object {
        private const val TAG = "MarshallSerial"
        // Marshall max message size (matches marshall_t.MARSHALL_MSG_MAX_SIZE region).
        private const val MAX_MSG = 1024
    }

    private var portPath: String = "/dev/ttyS4"
    private var baud: Int = 115200

    private var linkEvents: lowlevel_i.link_events_t? = null

    private var socket: SerialportSocket? = null
    private var input: InputStream? = null
    private var output: OutputStream? = null

    @Volatile private var running = false
    private var readThread: Thread? = null

    override fun init(ifc: Any?, ifcParams: Any?) {
        // SDK passes port (String) and baud (Integer).
        portPath = ifc as? String ?: portPath
        baud = (ifcParams as? Int) ?: baud
        Log.i(TAG, "init port=$portPath baud=$baud")
    }

    override fun register_link_events(events: lowlevel_i.link_events_t?) {
        linkEvents = events
    }

    override fun start() {
        try {
            val s = SerialportSocket()
            s.init(portPath, baud, 0, 0)
            // open()/connect() are private/obfuscated and Kotlin won't resolve
            // the synthetic access$open bridge directly — so we invoke it via
            // reflection. It calls the native open (libWeimiSerialPort.so does
            // termios 115200 8N1) and returns a configured FileDescriptor.
            val m = SerialportSocket::class.java.getDeclaredMethod(
                "access\$open",
                SerialportSocket::class.java,
                String::class.java,
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
            )
            m.isAccessible = true
            val fd = m.invoke(null, s, portPath, baud, 0, 0) as FileDescriptor
            socket = s
            input = FileInputStream(fd)
            output = FileOutputStream(fd)
            running = true
            readThread = Thread(ReadLoop()).also { it.isDaemon = true; it.start() }
            Log.i(TAG, "serial opened on $portPath @ $baud")
        } catch (t: Throwable) {
            Log.e(TAG, "start failed: ${t.message}", t)
        }
    }

    override fun stop() {
        running = false
        readThread?.interrupt()
        readThread = null
        try {
            input?.close()
            output?.close()
        } catch (_: Throwable) {
        }
        socket = null
        input = null
        output = null
        Log.i(TAG, "serial stopped")
    }

    override fun reset() {
        // no-op; matches demo behaviour
    }

    override fun transmit(data: ByteArray?, len: Int): Boolean {
        return try {
            if (data != null && output != null) {
                output!!.write(data, 0, len)
                output!!.flush()
            }
            true
        } catch (t: Throwable) {
            Log.e(TAG, "transmit failed: ${t.message}")
            false
        }
    }

    override fun onLinkTimerTick(ms: Long) {
        // no-op
    }

    /**
     * Reads bytes and reassembles Marshall frames. Frame length is in the first
     * two bytes (little-endian per string_utils.byte_arr_to_short) + 2. When a
     * full frame is present, push it up via onReceive.
     */
    private inner class ReadLoop : Runnable {
        private val rx = ByteArray(MAX_MSG * 2)
        private var head = 0
        private var lastRx = System.currentTimeMillis()

        override fun run() {
            head = 0
            while (running) {
                try {
                    val avail = input?.available() ?: 0
                    if (avail > 0) {
                        val toRead = minOf(avail, rx.size - head)
                        val n = input!!.read(rx, head, toRead)
                        if (n > 0) {
                            head += n
                            lastRx = System.currentTimeMillis()
                            // first 2 bytes = length (little-endian short) + 2
                            val expLen = byteArrToShort(rx, 0) + 2
                            if (expLen < 9 || expLen > MAX_MSG) {
                                head = 0
                            } else if (head >= expLen) {
                                linkEvents?.onReceive(rx, 0, expLen)
                                head = 0
                            }
                        }
                    } else {
                        if (head != 0 && System.currentTimeMillis() - lastRx > 100) {
                            head = 0 // discard stale partial frame
                        }
                        Thread.sleep(5)
                    }
                } catch (e: InterruptedException) {
                    break
                } catch (t: Throwable) {
                    Log.e(TAG, "read loop error: ${t.message}")
                    Thread.sleep(5)
                }
            }
        }

        private fun byteArrToShort(b: ByteArray, off: Int): Int {
            // little-endian unsigned short (matches SDK string_utils.byte_arr_to_short)
            return (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8)
        }
    }
}
