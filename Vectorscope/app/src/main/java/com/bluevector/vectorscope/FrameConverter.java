package com.bluevector.vectorscope;

import android.graphics.Bitmap;

import com.intel.realsense.librealsense.Colorizer;
import com.intel.realsense.librealsense.DepthFrame;
import com.intel.realsense.librealsense.Frame;
import com.intel.realsense.librealsense.FrameSet;
import com.intel.realsense.librealsense.VideoFrame;

/**
 * Converts raw librealsense frames into ARGB Bitmaps for the simple
 * ImageView preview path. Depth is colorized natively (Colorizer) rather
 * than mapped by hand — swap this out if custom depth-to-color mapping is
 * ever needed.
 */
final class FrameConverter {

    private FrameConverter() {}

    static Bitmap colorFrameToBitmap(FrameSet frames, int width, int height) {
        try (VideoFrame colorFrame = frames.getColorFrame()) {
            return rgb8ToBitmap(colorFrame, width, height);
        }
    }

    static Bitmap depthFrameToBitmap(FrameSet frames, Colorizer colorizer, int width, int height) {
        try (DepthFrame depthFrame = frames.getDepthFrame();
             Frame colorized = colorizer.colorize(depthFrame)) {
            return rgb8ToBitmap((VideoFrame) colorized, width, height);
        }
    }

    private static Bitmap rgb8ToBitmap(VideoFrame frame, int width, int height) {
        byte[] raw = new byte[frame.getDataSize()];
        frame.getData(raw);

        int[] pixels = new int[width * height];
        for (int i = 0, p = 0; p < pixels.length; i += 3, p++) {
            int r = raw[i] & 0xFF;
            int g = raw[i + 1] & 0xFF;
            int b = raw[i + 2] & 0xFF;
            pixels[p] = 0xFF000000 | (r << 16) | (g << 8) | b;
        }

        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        bitmap.setPixels(pixels, 0, width, 0, 0, width, height);
        return bitmap;
    }
}
