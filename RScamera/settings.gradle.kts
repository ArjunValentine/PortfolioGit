pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // No longer pulling librealsense from Intel's Maven host
        // (egiintel.jfrog.io) — it's dead, see RScamera/README.md. CI
        // builds the AAR from source instead and app/build.gradle.kts
        // depends on the local file directly.
    }
}

rootProject.name = "RSCamera"
include(":app")
