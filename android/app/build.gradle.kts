plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cn.moread.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "cn.moread.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "2.1.0"
        resourceConfigurations += setOf("zh", "zh-rCN", "en")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    packaging {
        resources { excludes += setOf("META-INF/*.kotlin_module") }
    }
    // assets 里的 ui 正面/sbin_cache
    sourceSets.getByName("main") {
        assets.srcDirs("src/main/assets")
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
    // 书源/WebDAV 会用到 PROPFIND、MKCOL 这类非标准方法，HttpURLConnection 不支持
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

/* 把上一层 ui/ 里的 html/css/js 同步进 assets，保持桌面版与安卓版共用同一套界面 */
val uiSrc = rootProject.file("../ui")
tasks.register<Sync>("syncUi") {
    from(uiSrc) {
        include("*.html", "*.js", "*.css")
    }
    into(layout.projectDirectory.dir("src/main/assets/ui"))
}
tasks.named("preBuild") { dependsOn("syncUi") }
