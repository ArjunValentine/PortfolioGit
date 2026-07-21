# RScamera

Minimal Android app scaffold for streaming color + depth from an Intel
RealSense D415 over USB-OTG, using librealsense's Java/JNI wrapper. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the full layer breakdown this is
built from.

Status: buildable scaffold, not yet a working app — it needs
`librealsense.aar` supplied locally (see below) before it will compile.

## What's here

```
RScamera/
├── ARCHITECTURE.md          architecture notes (native SDK → UI, layer by layer)
├── build.gradle              root Gradle config
├── settings.gradle           module list + repos
├── app/
│   ├── build.gradle           app module config, AAR dependency wiring
│   ├── libs/README.md         where to put librealsense.aar
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/bluevector/rscamera/
│       │   ├── MainActivity.java       USB permission flow + lifecycle
│       │   ├── RealSenseStreamer.java  background pipeline thread
│       │   └── FrameConverter.java     Z16/RGB8 → Bitmap conversion
│       └── res/                        layout, strings, launcher icon, USB device filter
```

## Get it building

1. **Get `librealsense.aar`.** It isn't vendored in this repo (see
   `app/libs/README.md`) — either point `settings.gradle` at IntelRealSense's
   maven repo if it still resolves, or build the AAR yourself from
   [IntelRealSense/librealsense](https://github.com/IntelRealSense/librealsense)
   (`wrappers/android/`) and drop it in `app/libs/`.
2. **Open in Android Studio**: `File → Open` → select the `RScamera/`
   folder. It'll generate the Gradle wrapper on first sync.
3. **Build an APK**: `Build → Build Bundle(s)/APK(s) → Build APK(s)`, or
   from the command line:
   ```
   ./gradlew assembleDebug
   ```
   Output: `app/build/outputs/apk/debug/app-debug.apk`.

## Install it on a device

You'll need a physical Android device (API 26+) with USB-C/USB-A OTG — none
of this works in an emulator, there's no USB host passthrough.

**Via adb (recommended for dev):**
```
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
Requires USB debugging enabled on the device (Settings → About phone → tap
Build number 7×  → Developer options → USB debugging).

**Via sideload:** copy the APK to the device (cable, cloud drive, email),
open it with a file manager, and allow "Install unknown apps" for that
source when prompted.

This won't be distributed through the Play Store — it's a niche
USB-OTG/hardware app, sideloading is the intended path.

## Using it

1. Launch the app, then plug in the D415 over an OTG adapter.
2. Accept the USB permission prompt — the app requests it automatically
   when an Intel-vendor USB device (`0x8086`) is detected
   (`MainActivity.requestPermissionIfRealSenseAttached`).
3. Color and depth (colorized) preview side by side once the pipeline
   starts. Unplugging the camera stops the pipeline cleanly rather than
   crashing.

## Known gaps

- `librealsense.aar` availability from maven is unverified as of writing;
  building it from source is the safe fallback (see step 1 above).
- Preview path is the simple `ImageView.setImageBitmap()` per frame — caps
  out around 15–20fps. Swap in a `GLSurfaceView` + OpenGL ES texture upload
  if higher/smoother fps is needed (see `ARCHITECTURE.md` §6).
- No launcher-icon PNGs are committed — the adaptive icon is built from
  vector drawables (`res/drawable/ic_launcher_*.xml`) so it needs no raster
  assets, but it's a placeholder, not final branding.
