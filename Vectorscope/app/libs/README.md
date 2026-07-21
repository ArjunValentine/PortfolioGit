# app/libs

Empty on purpose — the default build pulls `librealsense.aar` straight from
the RealSense SDK's artifactory (see `settings.gradle` + the dependency in
`app/build.gradle`), so nothing needs to go in this folder for a normal
build.

Only use this folder as a **fallback**, if that artifactory dependency ever
stops resolving:

1. **Build the AAR from source.** Clone
   [realsenseai/librealsense](https://github.com/realsenseai/librealsense)
   (this is the current org — the project moved from `IntelRealSense/` after
   RealSense spun out of Intel as its own company; the old URL redirects).
   Then:
   ```
   cd librealsense/wrappers/android
   ./gradlew assembleRelease        # Windows: gradlew.bat assembleRelease
   ```
   Needs Android Studio's NDK + CMake components installed. Output lands at
   `librealsense/wrappers/android/librealsense/build/outputs/aar/`.
2. Copy the resulting `.aar` into this folder.
3. In `app/build.gradle`, comment out the
   `implementation 'com.intel.realsense:librealsense:2.+@aar'` line and
   uncomment the `fileTree(dir: 'libs', ...)` line right below it.

Vendor binaries aren't committed to this repo (see `.gitignore`), so
whichever path you take, the AAR itself stays local to your machine.
