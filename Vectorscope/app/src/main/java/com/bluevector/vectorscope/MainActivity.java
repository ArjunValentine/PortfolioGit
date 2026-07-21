package com.bluevector.vectorscope;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Bundle;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import java.util.HashMap;

public class MainActivity extends AppCompatActivity implements RealSenseStreamer.FrameListener {

    private static final String ACTION_USB_PERMISSION = "com.bluevector.vectorscope.USB_PERMISSION";
    private static final int INTEL_VENDOR_ID = 0x8086;

    private ImageView colorPreview;
    private ImageView depthPreview;
    private TextView statusText;

    private UsbManager usbManager;
    private RealSenseStreamer streamer;
    private boolean receiverRegistered = false;

    private final BroadcastReceiver usbReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (ACTION_USB_PERMISSION.equals(action)) {
                synchronized (this) {
                    UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                    if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) && device != null) {
                        startStreaming();
                    } else {
                        statusText.setText(R.string.status_permission_denied);
                    }
                }
            } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                requestPermissionIfRealSenseAttached();
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                stopStreaming();
                statusText.setText(R.string.status_disconnected);
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        colorPreview = findViewById(R.id.colorPreview);
        depthPreview = findViewById(R.id.depthPreview);
        statusText = findViewById(R.id.statusText);

        usbManager = (UsbManager) getSystemService(Context.USB_SERVICE);
    }

    @Override
    protected void onResume() {
        super.onResume();

        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_USB_PERMISSION);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(usbReceiver, filter);
        }
        receiverRegistered = true;

        requestPermissionIfRealSenseAttached();
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopStreaming();
        if (receiverRegistered) {
            unregisterReceiver(usbReceiver);
            receiverRegistered = false;
        }
    }

    private void requestPermissionIfRealSenseAttached() {
        HashMap<String, UsbDevice> devices = usbManager.getDeviceList();
        for (UsbDevice device : devices.values()) {
            if (device.getVendorId() == INTEL_VENDOR_ID) {
                if (usbManager.hasPermission(device)) {
                    startStreaming();
                } else {
                    int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                            ? PendingIntent.FLAG_MUTABLE
                            : 0;
                    PendingIntent permissionIntent = PendingIntent.getBroadcast(
                            this, 0, new Intent(ACTION_USB_PERMISSION), flags);
                    usbManager.requestPermission(device, permissionIntent);
                    statusText.setText(R.string.status_permission_requested);
                }
                return;
            }
        }
        statusText.setText(R.string.status_waiting_for_device);
    }

    private void startStreaming() {
        if (streamer != null) return;
        streamer = new RealSenseStreamer(this);
        streamer.start();
        statusText.setText(R.string.status_streaming);
    }

    private void stopStreaming() {
        if (streamer != null) {
            streamer.stop();
            streamer = null;
        }
    }

    @Override
    public void onFrames(Bitmap color, Bitmap depth) {
        colorPreview.setImageBitmap(color);
        depthPreview.setImageBitmap(depth);
    }

    @Override
    public void onError(Exception e) {
        stopStreaming();
        statusText.setText(getString(R.string.status_pipeline_error, e.getMessage()));
    }
}
