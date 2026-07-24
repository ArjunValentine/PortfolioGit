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

    // Intel's documented Maven host for the prebuilt AAR
    // (egiintel.jfrog.io) no longer serves the artifact repo — it resolves
    // to JFrog's own generic landing page now, not Intel's Artifactory
    // instance. So instead of a remote coordinate, CI builds librealsense
    // from source (wrappers/android, ./gradlew assembleRelease) and drops
    // the resulting AAR here before this file gets evaluated. See
    // .github/workflows/rscamera-build.yml and RScamera/README.md.
    implementation(files("libs/librealsense.aar"))
}
