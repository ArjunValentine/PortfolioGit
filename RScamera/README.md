# RScamera — RealSense D415 Android viewer

Status: **unbuilt prototype scaffold**, not a working app yet. This is why
it isn't on the homepage's Live Systems list — there's nothing installable
to link to.

## What's here

- `ARCHITECTURE.md` — the original layer-by-layer design doc.
- A real Android Studio project (`app/`, Gradle wrapper, manifest, one
  `MainActivity.kt`) implementing that design: USB permission flow for the
  D415 over OTG, a background pipeline thread, color + colorized-depth
  preview side by side.
- `.github/workflows/rscamera-build.yml` (repo root) — builds a debug APK
  on every push under `RScamera/**` and uploads it as a workflow artifact.

## What's *not* verified

This was written in a sandbox with no Android SDK, no NDK, and no network
route to `egiintel.jfrog.io` (the Maven host Intel publishes the
`librealsense` AAR from — its Gradle coordinates were confirmed by reading
Intel's own docs/source on GitHub, but never actually resolved or
compiled). The `com.intel.realsense.librealsense.*` calls in
`MainActivity.kt` are cross-checked line-by-line against the AAR's public
Java source, not against a real compile. Treat the first CI run as the
real test — expect a signature or two to need a fix.

Nothing here has run against real hardware. No physical D415 or
USB-OTG-capable Android device was available to test against.

## What I need from you to turn this into a free APK download

1. **Kick off the build.** Push/merge this branch (or run the workflow
   manually) and I'll watch CI, fix whatever the librealsense AAR
   integration gets wrong on first contact, and iterate until
   `assembleDebug` is green.
2. **Hardware, for anything past "it compiles."** A D415 and an
   Android phone/tablet with USB-C OTG support (and ideally USB 3 — depth
   + color at 640x480x30fps combined can be tight over USB 2 bandwidth).
   Without this I can get you a build, but I can't confirm the camera
   actually streams, and there's real risk the librealsense AAR version I
   pinned (2.58.3) doesn't have Android artifacts published for it — the
   AAR release cadence lags the main SDK and I can't browse the Maven repo
   from here to check.
3. **Where to host the download.** I'd suggest a GitHub Release with the
   APK attached (CI can be extended to do this automatically on tag push)
   rather than committing a binary into the repo. I can then add a
   download link from the site once there's something real to point at —
   say the word and I'll wire that up.
4. **Signing.** For a free, direct-download APK (not Play Store), the
   standard debug-signed build CI already produces is fine — Android will
   just show the normal "install from unknown sources" prompt on the
   device. Let me know if you'd rather I set up a proper release keystore
   (needed only if you want auto-update-friendly versioning or ever plan
   to put it on Play).
5. **Scope check for v1.** Current scaffold is intentionally the "simplest
   path" from the architecture doc — `ImageView` + `Bitmap`, no GPU
   texture rendering, no depth math beyond the colorizer. Good enough to
   prove the pipeline; say if you want more before I invest further (e.g.
   the `GLSurfaceView` path for smoother fps, on-screen distance readout,
   recording).

## Building locally (once you have the SDK)

```
cd RScamera
./gradlew assembleDebug
```

Requires Android SDK (API 34) + a JDK 17. No NDK needed — this uses the
prebuilt AAR, not a native build.
