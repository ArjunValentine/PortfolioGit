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
        // Intel's own Maven host for the librealsense Android AAR.
        // Not reachable from every sandboxed/CI network by default — see
        // RScamera/README.md if this repo fails to resolve.
        maven { url = uri("https://egiintel.jfrog.io/artifactory/librealsense") }
    }
}

rootProject.name = "RSCamera"
include(":app")
