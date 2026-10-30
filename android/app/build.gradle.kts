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
// 注意：这里必须是 Copy 而不是 Sync。Sync 会把目标目录「同步成」源目录的样子，
// 于是被 exclude 掉的 bridge.js 会被它直接删掉 —— 兼容层就没了。
tasks.register<Copy>("syncUi") {
    from(uiSrc) {
        include("*.html", "*.js", "*.css")
        // bridge.js 在安卓上要的是 nodebundle.js 的内容，桌面端的空占位不能盖上去
        exclude("bridge.js")
    }
    into(layout.projectDirectory.dir("src/main/assets/ui"))
}
/* 安卓端的 <script src="bridge.js"> 必须直接拿到兼容层。
   以前靠 WebView 的 shouldInterceptRequest 拦截替换，部分 WebView 版本对
   file:///android_asset/ 不触发，页面就会加载到一个空脚本 —— 不报错，但 window.mo
   不存在，整个界面点什么都没反应。现在它是个普通静态文件，和普通资源一个加载路径。 */
tasks.register<Copy>("syncBridge") {
    dependsOn("syncUi")
    from(layout.projectDirectory.file("src/main/assets/nodebundle.js"))
    into(layout.projectDirectory.dir("src/main/assets/ui"))
    rename { "bridge.js" }
}
// 打包前确认 bridge.js 真的是兼容层而不是桌面端的空占位
tasks.register("checkBundle") {
    dependsOn("syncBridge")
    doLast {
        val f = layout.projectDirectory.file("src/main/assets/ui/bridge.js").asFile
        val size = if (f.exists()) f.length() else 0L
        if (size < 20000L) {
            throw GradleException(
                "assets/ui/bridge.js 缺失或过小（${size} 字节）。请先执行： npm run android:bundle"
            )
        }
    }
}
tasks.named("preBuild") { dependsOn("syncUi", "checkBundle") }
