import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
/**
 * *** PROVISIONING VALUES NOW COME FROM ~/.gradle/gradle.properties FIRST-CLASS.
 *
 * Every new version gets a fresh folder unzipped from the delivered build, so a
 * per-folder local.properties starts BLANK every time and the machine key has to
 * be re-pasted. That bit us after the 2026-07-30 factory reset. ~/.gradle lives
 * outside every project folder, so it is set once and picked up forever, and it
 * can never travel in a zip or reach git.
 *
 * PRECEDENCE, and the blank check is the whole point: a local.properties value
 * wins ONLY if it is non-blank, so the empty TEST_MACHINE_KEY that ships in the
 * zip falls through to the Gradle property instead of overriding it with "".
 * A per-folder override still works if you ever build for a different machine.
 */
fun provisioningValue(localKey: String, gradleKey: String): String =
    (localProps.getProperty(localKey)?.takeIf { it.isNotBlank() }
        ?: (project.findProperty(gradleKey) as String?)
        ?: "").trim()

val testMachineKey: String = provisioningValue("TEST_MACHINE_KEY", "SNARL_FRIDGE_MACHINE_KEY")
val testMachineDeviceCode: String =
    provisioningValue("TEST_MACHINE_DEVICE_CODE", "SNARL_FRIDGE_DEVICE_CODE")

// Say at build time whether the key arrived, and from where — never the value.
// A silently blank key produces an unprovisioned machine, which looks like a
// backend fault rather than a build one.
logger.lifecycle(
    "snarl-fridge provisioning: deviceCode=" +
        (testMachineDeviceCode.ifBlank { "<none>" }) +
        ", machineKey=" + (if (testMachineKey.isBlank()) "<none>" else "present"),
)

android {
    namespace = "isl.snudursopi.fridge"
    compileSdk = 34

    defaultConfig {
        applicationId = "isl.snudursopi.fridge"
        minSdk = 24
        targetSdk = 34
        // Fridge app starts its OWN forward-only version line at 1 (decision D5),
        // never shared with the coil app's ~128 line.
        versionCode = 135
        versionName = "0.54.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }

        buildConfigField("String", "TEST_MACHINE_KEY", "\"$testMachineKey\"")
        buildConfigField("String", "TEST_MACHINE_DEVICE_CODE", "\"$testMachineDeviceCode\"")
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
    implementation(platform("org.jetbrains.kotlin:kotlin-bom:2.0.0"))

    val composeBom = platform("androidx.compose:compose-bom:2024.09.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.1")
    implementation("org.jetbrains.kotlin:kotlin-reflect:2.0.0")

    // Networking + JSON (backend client)
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.2")

    // Product images on the cart tiles (R2-hosted) — same lib as the coil app.
    implementation("io.coil-kt:coil-compose:2.7.0")

    // Weimi hardware SDKs: base + motor (MotorSerialPortKit drives the weight
    // bus AND the door lock via WeightInstruct/LockInstruct) + annuo + marshall
    // (Nayax). motor-sdk IS required for the fridge — it's the real serial
    // framework the official Weimi sample uses. Drop AARs/jar into app/libs/.
    implementation(fileTree("libs") { include("*.aar", "*.jar") })

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
