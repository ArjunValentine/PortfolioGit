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

    // Version pinned to the latest librealsense tag at the time this was
    // written (2.58.3). The AAR publish cadence to the jfrog Maven repo can
    // lag the main SDK releases — if this fails to resolve, browse
    // https://egiintel.jfrog.io/artifactory/librealsense/com/intel/realsense/librealsense/
    // for the actual published versions and bump this.
    implementation("com.intel.realsense:librealsense:2.58.3@aar")
}
