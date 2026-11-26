import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/* 正式发布签名：android/keystore.properties + moread-release.keystore（都不入库）。
 * 商店只收正式签名的包；这个 keystore 丢了就永远无法更新已上架应用，务必异地备份。
 * 文件不存在时退回 debug 签名，本地自测不受影响。 */
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { this.load(it) }
}
val hasReleaseKey = keystoreProps.getProperty("storeFile") != null &&
    rootProject.file(keystoreProps.getProperty("storeFile") ?: "_").exists()

android {
    namespace = "cn.moread.app"
    /* Google Play 自 2026-08-31 起：新应用必须 targetSdk 36（Android 16）。
     * minSdk 26 = Android 8.0，覆盖 98%+ 设备；升级只影响编译目标，不改运行时行为。 */
    compileSdk = 36

    defaultConfig {
        applicationId = "cn.moread.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 614
        versionName = "0.6.14"
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            // 有正式密钥用正式签名；没有再退回 debug（debug 包商店会拒收）
            signingConfig = if (hasReleaseKey) signingConfigs.getByName("release")
                           else signingConfigs.getByName("debug")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures { buildConfig = true }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "META-INF/DEPENDENCIES")
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.activity:activity-ktx:1.8.2")
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

/* ---------------- 界面资源同步 ----------------
 * ui/ 是桌面端和安卓端共用的同一套 HTML/CSS/JS。构建前把会变的几个文件复制进 assets，
 * 少一个界面就退回旧界面，所以固定在这做，不靠人记得手动拷。
 *
 * index.html 不参与同步：两端 DOM 不同（安卓有形态标记脚本、自检面板，桌面没有
 * bridge.js 引用），各自维护各自的一份。bridge.js 由 build/gen-nodebundle.js 生成。 */
val syncUiAssets = tasks.register<Copy>("syncUiAssets") {
    from(rootProject.file("../ui")) {
        include("app.js", "style.css", "engine.js", "detect.js")
    }
    into(layout.projectDirectory.dir("src/main/assets/ui"))
}

/* 校验兼容层真的打进包里 —— 这一层空掉的话 window.mo 不存在，
 * 界面能画出来但所有按钮都没反应，且没有任何报错，极难排查。 */
val checkBundle = tasks.register("checkBundle") {
    val bundle = layout.projectDirectory.file("src/main/assets/ui/bridge.js").asFile
    doLast {
        if (!bundle.exists()) throw GradleException("缺少 assets/ui/bridge.js，先跑 node build/gen-nodebundle.js")
        val kb = bundle.length() / 1024
        if (bundle.length() < 20 * 1024) throw GradleException("bridge.js 只有 ${bundle.length()} 字节（${kb}KB），兼容层没打进去")
        logger.lifecycle("兼容层 bridge.js  ${kb}KB  OK")
    }
}

tasks.named("preBuild") {
    dependsOn(syncUiAssets)
    dependsOn(checkBundle)
}
