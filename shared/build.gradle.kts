// Code both kiosk apps run unchanged: what keeps a placed machine alive and reachable.
// Included by coil-app/ and fridge-app/ (settings.gradle.kts in each), so one fix lands in
// both builds. No Compose, no app resources, no BuildConfig constants — only Android
// framework, coroutines and the HTTP/JSON stack the apps already share.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "isl.snudursopi.shared"
    compileSdk = 34
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(platform("org.jetbrains.kotlin:kotlin-bom:2.0.0"))
    implementation("androidx.core:core-ktx:1.13.1")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // BackendPoster speaks JsonNode, the type both apps' HTTP helpers already return.
    api("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.2")
    implementation("org.jetbrains.kotlin:kotlin-reflect:2.0.0")
    testImplementation("junit:junit:4.13.2")
}
