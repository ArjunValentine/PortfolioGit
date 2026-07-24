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
- `.github/workflows/rscamera-build.yml` (repo root) — builds librealsense
  from source and the app's debug APK on every push under `RScamera/**`,
  uploaded as a workflow artifact.

## The librealsense AAR situation

Intel's documented Maven host for the prebuilt Android library
(`egiintel.jfrog.io`) is dead — CI confirmed it resolves to JFrog's own
generic marketing landing page now, not Intel's Artifactory instance. No
credible prebuilt mirror exists (checked JitPack and GitHub releases).

So CI builds the AAR from source instead: clones `librealsense` at tag
`v2.58.3` (pinned in `rscamera-build.yml`'s `env:` block), runs its own
`wrappers/android` Gradle build (`assembleRelease`, which cross-compiles
the native C++ core via NDK/CMake for `arm64-v8a` + `x86_64`), and drops
the resulting `.aar` into `app/libs/` before building the app itself.
Intel's own docs describe this as "a few minutes," not a lengthy build.
`app/build.gradle.kts` depends on that local file
(`implementation(files("libs/librealsense.aar"))`), not a remote
coordinate.

## What's *not* verified

This was written and CI-iterated from a sandbox with no Android SDK, no
NDK, no physical hardware, and a network policy that blocks most external
hosts (which is exactly how the dead-Maven-host problem got caught — it
surfaced in CI, which has full internet access, not here). The
`com.intel.realsense.librealsense.*` calls in `MainActivity.kt` are
cross-checked line-by-line against the AAR's public Java source, not
against a real compile — expect a signature or two to still need fixing
as CI iterates.

Nothing here has run against real hardware. No physical D415 or
USB-OTG-capable Android device was available to test against from this
environment.

## Can local hardware + Claude Code on your desktop help?

Yes — meaningfully more than anything possible from this cloud sandbox,
for two different reasons:

1. **librealsense's desktop SDK isn't affected by the dead jfrog host at
   all.** That endpoint was specific to the Android AAR distribution.
   Desktop librealsense installs cleanly via `apt` (Ubuntu has an official
   repo), Homebrew, or `pip install pyrealsense2`, and ships
   `realsense-viewer` plus CLI tools (`rs-enumerate-devices`,
   `rs-fw-update`, etc.). With the D415 plugged into your desktop, Claude
   Code running locally could install that SDK, run those tools against
   the real camera, and read back real firmware/product-ID/stream-capability
   data — which would let me tighten `device_filter.xml` (currently a
   loose match on Intel's vendor ID only, no product ID) and sanity-check
   assumptions I could only source from documentation here.
2. **A locally-connected Android device closes the loop entirely.** With
   `adb` access to a phone/tablet (and the D415 connected to it via USB-C
   OTG), Claude Code locally could build with the real Android SDK/NDK,
   `adb install` the APK, run it against the actual camera, and read
   `adb logcat` for real crashes/errors — a genuine debug loop instead of
   the static, read-the-source-and-guess approach this session is limited
   to.

One clarification on scope: this isn't "reverse-engineer the USB protocol
from scratch" territory, and shouldn't need to be — librealsense already
implements the D415's protocol (it runs its own userspace USB backend on
Android via the `-DFORCE_RSUSB_BACKEND=TRUE` CMake flag, precisely because
Android doesn't allow installing a kernel driver). Local hardware access
would be for *validating and iterating* on the app against the real
device, not reimplementing something Intel already solved.

If you want to go this route: install Claude Code locally, open this repo
there, plug in the D415 (and an OTG-capable Android device once you're
past desktop validation), and pick up from wherever CI in this PR left
off.

## What I need from you to turn this into a free APK download

1. **Let CI finish proving out the from-source build.** I'll keep
   iterating on failures as they come back.
2. **Hardware, for anything past "it compiles."** Covered above — desktop
   first for SDK/protocol validation, then an OTG Android device for the
   real app.
3. **Where to host the download.** I'd suggest a GitHub Release with the
   APK attached (CI can be extended to publish there automatically on tag
   push) rather than committing a binary into the repo. Say the word once
   there's a working build and I'll wire a download link into the site.
4. **Signing.** The debug-signed build CI produces is fine for a free
   direct download (normal "install from unknown sources" prompt). A real
   release keystore is only worth it for Play Store or auto-update.
5. **Scope check for v1.** Current scaffold is intentionally the
   "simplest path" from the architecture doc — `ImageView` + `Bitmap`, no
   GPU texture rendering, no depth math beyond the colorizer. Say if you
   want more before I invest further (the `GLSurfaceView` path for
   smoother fps, on-screen distance readout, recording).

## Building locally

```
cd RScamera
# One-time: build librealsense's AAR from source and drop it in app/libs/
# — see the "Clone librealsense" / "Build librealsense AAR from source" /
# "Drop the built AAR" steps in ../.github/workflows/rscamera-build.yml
# for the exact commands. Requires Android NDK 28.0.13004108 + CMake 3.22.1.
./gradlew assembleDebug
```

Requires Android SDK (API 34), NDK 28.0.13004108, CMake 3.22.1, and a JDK
17 — the NDK/CMake are only needed for that one-time librealsense build,
not for iterating on the app itself afterward.
