plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.bluevector.rscamera"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.bluevector.rscamera"
        // USB host API (UsbManager device/permission flow) needs API 21+;
        // pinned higher here since untested below API 26.
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-prototype"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")

    // Pinning to a specific version (tried 2.58.3, the latest SDK tag at
    // the time this was written) failed CI: that version was never
    // published to this AAR-specific Maven repo, which lags the main SDK
    // release cadence and doesn't mirror it 1:1. Falling back to the
    // floating range Intel's own docs use, which resolves to whatever the
    // highest published AAR version actually is. See the CI job's
    // "List available librealsense AAR versions" step for what's really
    // there — worth pinning to a real version once known.
    implementation("com.intel.realsense:librealsense:2.+@aar")
}
