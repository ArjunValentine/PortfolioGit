# RealSense D415 on Android — layer breakdown

How a librealsense-based Android app for the Intel RealSense D415 is put
together, bottom to top.

## 1. Native SDK layer (librealsense core)

- The librealsense C++ library itself, built for Android via CMake/NDK, or
  pulled in as `librealsense.aar` from the maven repo if it still resolves.
- This gives you the actual depth/color stream decoding, camera control, and
  USB protocol handling. You don't reimplement this, you just link against
  it.

## 2. USB/permissions layer

- Android's `UsbManager` and `UsbDeviceConnection` APIs, since the D415
  shows up as a USB host device over OTG.
- Your app needs to request `android.permission.USB_PERMISSION` at runtime
  and handle the intent filter for device attach/detach events
  (`ACTION_USB_DEVICE_ATTACHED`).
- librealsense's AAR wraps most of this, but you still own the Android-side
  permission prompt and lifecycle (what happens if the cable disconnects
  mid-stream).

## 3. JNI bridge

- The AAR exposes a Java API (`RsContext`, `Pipeline`, `Config`,
  `FrameSet`) that calls down into the native C++ through JNI.
- You mostly work at this Java layer unless you need custom native
  processing (like doing depth math yourself), in which case you'd write
  your own `.cpp` file and add it to `CMakeLists.txt`.

## 4. Pipeline/streaming layer (your code starts here)

```java
RsContext ctx = new RsContext();
Pipeline pipeline = new Pipeline();
Config cfg = new Config();
cfg.enableStream(StreamType.COLOR, 640, 480, StreamFormat.RGB8, 30);
cfg.enableStream(StreamType.DEPTH, 640, 480, StreamFormat.Z16, 30);
pipeline.start(cfg);
```

- Wrap this in a background thread (`HandlerThread` or coroutine), never on
  the UI thread, since `pipeline.waitForFrames()` blocks.
- This thread's only job: pull `FrameSet` objects in a loop and hand them
  off to the rendering layer.

## 5. Frame conversion layer

- Depth frames come back as 16-bit `Z16` data, color as `RGB8`. You need a
  converter step: either colorize depth on the native side (librealsense
  has a `Colorizer` class for this) or do it yourself if you want custom
  depth-to-color mapping.
- Output target here is either a `Bitmap` (simple, slower) or a
  `ByteBuffer` you feed directly into a GPU texture (faster, needed if you
  want smooth fps).

## 6. Rendering layer

- Simplest path: `ImageView` updated with `Bitmap.setPixels()` per frame.
  Fine for a basic preview, will cap out around 15 to 20fps depending on
  device.
- Better path: `GLSurfaceView` with a custom `Renderer`, upload frame data
  as an OpenGL ES texture each frame. This is what you'd want if
  smoothness matters for the actual use case rather than just confirming
  the camera works.
- Side-by-side color+depth preview is just two textures or two views,
  nothing exotic.

## 7. UI/lifecycle layer

- One `Activity` (or Fragment) owning: permission request flow,
  connect/disconnect state, start/stop pipeline calls tied to
  `onResume`/`onPause`, and the preview surface.
- Handle the disconnect case explicitly since OTG cameras dropping
  mid-session is common and the pipeline needs a clean stop/restart rather
  than crashing.

## Build tooling you'll need

- Android Studio with NDK and CMake components installed.
- Gradle module set up to either pull `librealsense.aar` from the maven
  repo, or build the native library yourself from the librealsense GitHub
  source (safer bet now given the AAR situation is uncertain).
- A physical Android device for testing since none of this works in an
  emulator (no USB host passthrough).
