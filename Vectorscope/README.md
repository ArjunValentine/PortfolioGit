# Vectorscope

Minimal Android app scaffold for streaming color + depth from an Intel
RealSense D415 over USB-OTG, using librealsense's Java/JNI wrapper. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the full layer breakdown this is
built from.

Status: buildable scaffold, not yet a working app — it pulls
`librealsense.aar` from the RealSense SDK's artifactory at build time (no
manual step needed, see below), but hasn't actually been built or run
anywhere yet (see "No APK yet" below).

**Naming note:** this app is named independently of Intel/RealSense — it
doesn't use their product or trademarked names. It does depend on and
credit librealsense (Apache License 2.0) under the hood; that attribution
stays intact in source and belongs in an in-app "About" screen too. Renaming
the product is normal practice for third-party hardware clients; dropping
the license attribution would not be.

## What's here

```
Vectorscope/
├── ARCHITECTURE.md          architecture notes (native SDK → UI, layer by layer)
├── build.gradle              root Gradle config
├── settings.gradle           module list + repos
├── app/
│   ├── build.gradle           app module config, AAR dependency wiring
│   ├── libs/README.md         where to put librealsense.aar
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/bluevector/vectorscope/
│       │   ├── MainActivity.java       USB permission flow + lifecycle
│       │   ├── RealSenseStreamer.java  background pipeline thread
│       │   └── FrameConverter.java     Z16/RGB8 → Bitmap conversion
│       └── res/                        layout, strings, launcher icon, USB device filter
```

## Get it building

`librealsense.aar` comes from the RealSense SDK's own artifactory —
`settings.gradle` points at it and `app/build.gradle` depends on
`com.intel.realsense:librealsense:2.+@aar`, so there's no manual download
step for the normal path. (If that ever stops resolving, `app/libs/README.md`
has the from-source fallback.)

1. **Open in Android Studio**: `File → Open` → select the `Vectorscope/`
   folder. It'll generate the Gradle wrapper on first sync.
2. **Build an APK**: `Build → Build Bundle(s)/APK(s) → Build APK(s)`, or
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

## No APK yet

There is no prebuilt `.apk` in this repo. Producing one needs an Android
SDK/NDK toolchain and internet access to the Google/Maven/artifactory repos
above, plus validating it needs a physical D415 + Android device — none of
which are available in an automated environment. The straightforward way to
get a real binary is to open this in Android Studio locally (step-by-step
above) and build it yourself, or wire up a CI workflow (e.g. GitHub Actions,
which does have Android SDK/internet access) to build and attach the APK to
a release — that's a separate, sizeable follow-up if wanted.

## Known gaps

- Preview path is the simple `ImageView.setImageBitmap()` per frame — caps
  out around 15–20fps. Swap in a `GLSurfaceView` + OpenGL ES texture upload
  if higher/smoother fps is needed (see `ARCHITECTURE.md` §6).
- No launcher-icon PNGs are committed — the adaptive icon is built from
  vector drawables (`res/drawable/ic_launcher_*.xml`) so it needs no raster
  assets, but it's a placeholder, not final branding.
