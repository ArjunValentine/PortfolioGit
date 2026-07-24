package com.bluevector.rscamera

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.intel.realsense.librealsense.Colorizer
import com.intel.realsense.librealsense.Config
import com.intel.realsense.librealsense.Frame
import com.intel.realsense.librealsense.Pipeline
import com.intel.realsense.librealsense.RsContext
import com.intel.realsense.librealsense.StreamFormat
import com.intel.realsense.librealsense.StreamType
import java.nio.ByteBuffer

/**
 * Prototype viewer for the Intel RealSense D415 over USB-C OTG.
 *
 * Streaming layer per RScamera/ARCHITECTURE.md: background thread pulls
 * FrameSets, colorizes depth, and pushes both previews to the UI thread as
 * Bitmaps. This is the "simplest path" from the doc (ImageView + Bitmap),
 * not the GLSurfaceView path — good enough to prove the camera pipeline
 * works, not tuned for frame rate.
 *
 * CAVEAT: the com.intel.realsense.librealsense.* calls below are written
 * against the public Java source on GitHub (IntelRealSense/librealsense,
 * wrappers/android/librealsense), not compiled or run against the real
 * AAR — this sandbox has no Android SDK and can't reach the jfrog Maven
 * host the AAR is published from. Frame/Filter/Pipeline method names were
 * cross-checked against that source, but treat this as unverified until
 * it's actually built. See RScamera/README.md.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "RSCamera"
        private const val ACTION_USB_PERMISSION = "com.bluevector.rscamera.USB_PERMISSION"
        private const val STREAM_WIDTH = 640
        private const val STREAM_HEIGHT = 480
        private const val STREAM_FPS = 30
    }

    private lateinit var statusText: TextView
    private lateinit var colorPreview: ImageView
    private lateinit var depthPreview: ImageView
    private lateinit var usbManager: UsbManager

    private var streamingThread: HandlerThread? = null
    private var streamingHandler: Handler? = null
    private var pipeline: Pipeline? = null
    private val colorizer = Colorizer()

    @Volatile
    private var keepStreaming = false

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_USB_PERMISSION -> {
                    synchronized(this) {
                        val device: UsbDevice? =
                            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
                        val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                        if (granted && device != null) {
                            startStreaming()
                        } else {
                            setStatus(getString(R.string.status_disconnected))
                            Log.w(TAG, "USB permission denied for $device")
                        }
                    }
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> requestUsbPermissionIfNeeded()
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    stopStreaming()
                    setStatus(getString(R.string.status_waiting))
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        colorPreview = findViewById(R.id.colorPreview)
        depthPreview = findViewById(R.id.depthPreview)
        usbManager = getSystemService(Context.USB_SERVICE) as UsbManager

        RsContext.init(applicationContext)

        val filter = IntentFilter().apply {
            addAction(ACTION_USB_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(usbReceiver, filter)
        }
    }

    override fun onResume() {
        super.onResume()
        requestUsbPermissionIfNeeded()
    }

    override fun onPause() {
        super.onPause()
        stopStreaming()
    }

    override fun onDestroy() {
        super.onDestroy()
        unregisterReceiver(usbReceiver)
    }

    private fun requestUsbPermissionIfNeeded() {
        val device = usbManager.deviceList.values.firstOrNull { it.vendorId == 0x8086 }
        if (device == null) {
            setStatus(getString(R.string.status_waiting))
            return
        }
        if (usbManager.hasPermission(device)) {
            startStreaming()
            return
        }
        setStatus(getString(R.string.status_permission))
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            android.app.PendingIntent.FLAG_MUTABLE
        } else {
            0
        }
        val permissionIntent = android.app.PendingIntent.getBroadcast(
            this, 0, Intent(ACTION_USB_PERMISSION), flags
        )
        usbManager.requestPermission(device, permissionIntent)
    }

    private fun startStreaming() {
        if (keepStreaming) return
        keepStreaming = true
        setStatus(getString(R.string.status_streaming))

        val thread = HandlerThread("rscamera-pipeline").also { it.start() }
        streamingThread = thread
        val handler = Handler(thread.looper)
        streamingHandler = handler

        handler.post {
            try {
                val cfg = Config().apply {
                    // RGBA8 (not RGB8) on purpose: its 4-bytes-per-pixel layout
                    // maps straight onto Bitmap.Config.ARGB_8888 with no
                    // per-pixel expansion needed.
                    //
                    // The 6-arg overload takes a stream `index` before
                    // width/height (index -1 = "any" — the D415 doesn't
                    // expose multiple streams of the same type, so this
                    // just picks whichever one matches width/height/format).
                    enableStream(StreamType.COLOR, -1, STREAM_WIDTH, STREAM_HEIGHT, StreamFormat.RGBA8, STREAM_FPS)
                    enableStream(StreamType.DEPTH, -1, STREAM_WIDTH, STREAM_HEIGHT, StreamFormat.Z16, STREAM_FPS)
                }
                val pipe = Pipeline()
                pipe.start(cfg)
                pipeline = pipe
                streamLoop(pipe)
            } catch (e: Exception) {
                // Pipeline.start() throws if the device is already claimed,
                // firmware is incompatible, or USB negotiation failed —
                // none of which is verifiable without real hardware.
                Log.e(TAG, "Failed to start pipeline", e)
                runOnUiThread { setStatus("Pipeline error: ${e.message}") }
                keepStreaming = false
            }
        }
    }

    private fun streamLoop(pipe: Pipeline) {
        while (keepStreaming) {
            pipe.waitForFrames().closing { frames ->
                frames.first(StreamType.COLOR).closing { colorFrame ->
                    val bitmap = rgba8ToBitmap(colorFrame, STREAM_WIDTH, STREAM_HEIGHT)
                    runOnUiThread { colorPreview.setImageBitmap(bitmap) }
                }
                frames.first(StreamType.DEPTH).closing { depthFrame ->
                    // Colorizer is a Filter; process() returns the false-color
                    // RGB8 frame. Caller must close it, hence the nested call.
                    colorizer.process(depthFrame).closing { colorizedDepth ->
                        val bitmap = rgb8ToBitmap(colorizedDepth, STREAM_WIDTH, STREAM_HEIGHT)
                        runOnUiThread { depthPreview.setImageBitmap(bitmap) }
                    }
                }
            }
        }
    }

    /**
     * librealsense's Frame/FrameSet only expose close(), they don't
     * implement java.io.Closeable — so Kotlin's stdlib `.use {}` doesn't
     * apply. This is the same try/finally in extension-function form.
     */
    private inline fun <T : Frame, R> T.closing(block: (T) -> R): R {
        try {
            return block(this)
        } finally {
            close()
        }
    }

    /** RGBA8 is 4 bytes/pixel in R,G,B,A order — the same layout Bitmap
     *  expects for ARGB_8888, so this is a straight buffer copy. */
    private fun rgba8ToBitmap(frame: Frame, width: Int, height: Int): Bitmap {
        val data = ByteArray(frame.dataSize)
        frame.getData(data)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(data))
        return bitmap
    }

    /** RGB8 is 3 bytes/pixel (no alpha) — librealsense's colorizer default
     *  output. Expanded per-pixel into an opaque ARGB_8888 bitmap. */
    private fun rgb8ToBitmap(frame: Frame, width: Int, height: Int): Bitmap {
        val data = ByteArray(frame.dataSize)
        frame.getData(data)
        val pixels = IntArray(width * height)
        var src = 0
        for (i in pixels.indices) {
            val r = data[src].toInt() and 0xFF
            val g = data[src + 1].toInt() and 0xFF
            val b = data[src + 2].toInt() and 0xFF
            pixels[i] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
            src += 3
        }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.setPixels(pixels, 0, width, 0, 0, width, height)
        return bitmap
    }

    private fun stopStreaming() {
        keepStreaming = false
        pipeline?.let {
            try {
                it.stop()
            } catch (e: Exception) {
                Log.w(TAG, "Pipeline stop threw, ignoring", e)
            }
        }
        pipeline = null
        streamingThread?.quitSafely()
        streamingThread = null
        streamingHandler = null
    }

    private fun setStatus(text: String) {
        runOnUiThread { statusText.text = text }
    }
}
