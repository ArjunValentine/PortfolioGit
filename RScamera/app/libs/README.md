# app/libs

Drop `librealsense.aar` here before building.

Get it one of two ways:

1. **Maven** (fastest if it still resolves) — add IntelRealSense's maven repo
   to `settings.gradle` and depend on the artifact directly instead of using
   this folder. As of writing, the AAR's availability on maven is uncertain,
   so treat this as "try first, fall back to option 2."
2. **Build from source** (reliable) — clone
   [IntelRealSense/librealsense](https://github.com/IntelRealSense/librealsense),
   follow `wrappers/android/README.md`, and build the AAR yourself with the
   NDK/CMake toolchain. Copy the resulting `librealsense.aar` into this
   directory.

This folder is otherwise empty on purpose — the AAR is a vendor binary and
isn't committed to the repo (see `.gitignore`).
