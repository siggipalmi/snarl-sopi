import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// ---- Local-only secrets (do NOT commit) ----
// Read optional test machine key from local.properties so we can test
// against the live backend before provisioning ships. local.properties is
// gitignored, so the key never enters the repo.
//
// When TEST_MACHINE_KEY is unset (which is the case for every developer
// who hasn't manually added it), BuildConfig.TEST_MACHINE_KEY is empty
// and VendingViewModel falls back to its normal placeholder behaviour.
//
// Delete this block once /api/v1/machines/provision is wired end-to-end.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val testMachineKey: String = localProps.getProperty("TEST_MACHINE_KEY", "")
val testMachineDeviceCode: String = localProps.getProperty("TEST_MACHINE_DEVICE_CODE", "")

android {
    namespace = "isl.snudursopi.vending"
    compileSdk = 34

    defaultConfig {
        applicationId = "isl.snudursopi.vending"
        minSdk = 24
        targetSdk = 34
        versionCode = 165
        versionName = "0.80.9"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }

        // Surface the local-only test key to runtime. Empty string is the
        // safe default; the kiosk treats empty as "no test key configured".
        buildConfigField("String", "TEST_MACHINE_KEY", "\"$testMachineKey\"")
        buildConfigField("String", "TEST_MACHINE_DEVICE_CODE", "\"$testMachineDeviceCode\"")
    }

    /*
     * Every coil machine's APK is signed with the debug keystore from Siggi's Mac
     * (SHA-256 c3d1dfdb…4a746f52, the same key as the fridge fleet), and Android
     * refuses an update signed with anything else. CI writes that keystore to a
     * file and points FLEET_DEBUG_KEYSTORE at it. Left to find "the" debug keystore
     * by itself, the first CI build signed with a key of its own (7c42701d…) and
     * the release workflow refused it — the trap snarl-fridge hit on 2026-10-01,
     * fixed there the same way.
     *
     * Unset on the Mac, so local builds keep the default — which is the same key.
     */
    signingConfigs {
        getByName("debug") {
            System.getenv("FLEET_DEBUG_KEYSTORE")?.takeIf { it.isNotBlank() }?.let {
                storeFile = file(it)
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            applicationIdSuffix = ".debug"
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
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    // ---- Kotlin BOM: force ALL kotlin artifacts (stdlib, reflect, etc.) to
    // the same version as the compiler (2.0.0). Without this, transitive deps
    // (e.g. jackson-module-kotlin) drag in kotlin-reflect 1.7.22, which
    // mismatches the 2.0.0 stdlib and causes "String != String" /
    // "cannot infer type" compile failures across the whole module.
    implementation(platform("org.jetbrains.kotlin:kotlin-bom:2.0.0"))
    // Self-healing, auto-revert, clock guard, payment-status report… — see ../shared.
    implementation(project(":shared"))

    // ---- Compose BOM (manages versions) ----
    val composeBom = platform("androidx.compose:compose-bom:2024.09.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    // ---- Core Android + Compose ----
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // ---- DataStore (settings persistence) ----
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // ---- Coroutines ----
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.1")
    // Pin kotlin-reflect to match the compiler (2.0.0). Jackson pulls 1.7.22
    // transitively, which mismatches the 2.0.0 stdlib and breaks compilation.
    implementation("org.jetbrains.kotlin:kotlin-reflect:2.0.0")

    // ---- Networking (Weimi API) ----
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.2")

    // ---- Image loading ----
    implementation("io.coil-kt:coil-compose:2.7.0")

    // ---- Video playback (for ad region) ----
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")

    // ---- Weimi vending hardware SDKs (drop AARs into app/libs/) ----
    implementation(fileTree("libs") { include("*.aar", "*.jar") })

    // ---- Testing ----
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
