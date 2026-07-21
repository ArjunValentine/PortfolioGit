package com.bluevector.rscamera;

import android.graphics.Bitmap;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;

import com.intel.realsense.librealsense.Colorizer;
import com.intel.realsense.librealsense.Config;
import com.intel.realsense.librealsense.FrameSet;
import com.intel.realsense.librealsense.Pipeline;
import com.intel.realsense.librealsense.RsContext;
import com.intel.realsense.librealsense.StreamFormat;
import com.intel.realsense.librealsense.StreamType;

/**
 * Owns the librealsense pipeline on a dedicated thread. waitForFrames()
 * blocks, so this never touches the UI thread directly — frames are handed
 * back to the caller's Handler (main looper) as Bitmaps.
 */
class RealSenseStreamer {

    interface FrameListener {
        void onFrames(Bitmap color, Bitmap depth);
        void onError(Exception e);
    }

    private static final String TAG = "RealSenseStreamer";
    private static final int WIDTH = 640;
    private static final int HEIGHT = 480;
    private static final int FPS = 30;

    private final FrameListener listener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private HandlerThread thread;
    private Handler workerHandler;
    private Pipeline pipeline;
    private Colorizer colorizer;
    private volatile boolean streaming = false;

    RealSenseStreamer(FrameListener listener) {
        this.listener = listener;
    }

    void start() {
        if (streaming) return;
        streaming = true;

        thread = new HandlerThread("RealSenseStreamer");
        thread.start();
        workerHandler = new Handler(thread.getLooper());
        workerHandler.post(this::runPipeline);
    }

    void stop() {
        streaming = false;
        if (workerHandler != null) {
            workerHandler.post(() -> {
                if (pipeline != null) {
                    try {
                        pipeline.stop();
                    } catch (Exception e) {
                        Log.w(TAG, "pipeline.stop() failed", e);
                    }
                }
            });
        }
        if (thread != null) {
            thread.quitSafely();
            try {
                thread.join(500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private void runPipeline() {
        try (RsContext ctx = new RsContext()) {
            pipeline = new Pipeline();
            colorizer = new Colorizer();

            Config cfg = new Config();
            cfg.enableStream(StreamType.COLOR, WIDTH, HEIGHT, StreamFormat.RGB8, FPS);
            cfg.enableStream(StreamType.DEPTH, WIDTH, HEIGHT, StreamFormat.Z16, FPS);
            pipeline.start(cfg);

            while (streaming) {
                try (FrameSet frames = pipeline.waitForFrames()) {
                    Bitmap colorBitmap = FrameConverter.colorFrameToBitmap(frames, WIDTH, HEIGHT);
                    Bitmap depthBitmap = FrameConverter.depthFrameToBitmap(frames, colorizer, WIDTH, HEIGHT);
                    mainHandler.post(() -> listener.onFrames(colorBitmap, depthBitmap));
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Streaming pipeline failed", e);
            mainHandler.post(() -> listener.onError(e));
        } finally {
            if (colorizer != null) colorizer.close();
            if (pipeline != null) pipeline.close();
        }
    }
}
