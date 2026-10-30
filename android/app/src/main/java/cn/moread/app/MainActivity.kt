package cn.moread.app

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.webkit.*
import android.widget.EditText
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultCallback
import androidx.activity.result.contract.ActivityResultContract
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val TAG = "MainActivity"

/** 桌面 UA：内嵌网页嗅探需要按桌面站点渲染 */
private const val DESKTOP_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

data class Picked(val uri: Uri, val name: String, val size: Long, val staged: String)

class MainActivity : AppCompatActivity() {

    lateinit var webView: WebView
        private set
    private lateinit var bridge: MoBridge

    var fullscreen: Boolean = false
        private set

    private var lastInsets = JSONObject()
    private var pendingExternal: JSONObject? = null
    private var backPressedAt = 0L
    private val mainHandler = Handler(Looper.getMainLooper())

    /* ---------- 文件选择的结果回传 ---------- */
    @Volatile private var pickSink: ((List<Uri>) -> Unit)? = null
    @Volatile private var saveSink: ((Uri?) -> Unit)? = null

    private class PickContract : ActivityResultContract<Pair<Array<String>, Boolean>, List<Uri>>() {
        override fun createIntent(context: Context, input: Pair<Array<String>, Boolean>): Intent {
            val mimes = input.first
            return Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, input.second)
                putExtra(Intent.EXTRA_MIME_TYPES, mimes)
                type = if (mimes.size == 1) mimes[0] else "*/*"
            }
        }
        override fun parseResult(resultCode: Int, intent: Intent?): List<Uri> {
            val out = mutableListOf<Uri>()
            val clip = intent?.clipData
            if (clip != null) {
                for (i in 0 until clip.itemCount) out.add(clip.getItemAt(i).uri)
            } else {
                intent?.data?.let { out.add(it) }
            }
            return out
        }
    }

    private class CreateContract : ActivityResultContract<Pair<String, String>, Uri?>() {
        override fun createIntent(context: Context, input: Pair<String, String>): Intent =
            Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = input.first
                putExtra(Intent.EXTRA_TITLE, input.second)
            }
        override fun parseResult(resultCode: Int, intent: Intent?): Uri? = intent?.data
    }

    private val pickLauncher =
        registerForActivityResult(PickContract()) { uris -> pickSink?.invoke(uris); pickSink = null }

    private val createLauncher =
        registerForActivityResult(CreateContract()) { uri -> saveSink?.invoke(uri); saveSink = null }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 边到边绘制，顶部/底部留白交给 CSS 的 safe-area 变量处理
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false

        setContentView(R.layout.activity_main)

        MoFiles.init(this)
        MoTts.init(this)

        bridge = MoBridge(this)
        MoTts.setEventListener { type, id, extra ->
            val arg = extra?.toString() ?: "null"
            bridge.emitToJs("if(window.MoApp&&window.MoApp.tts){window.MoApp.tts('$type','$id',$arg)}")
        }

        webView = findViewById(R.id.web)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        configureWebView()
        collectInsets()
        setupBack()
        handleIncoming(intent)

        webView.loadUrl("file:///android_asset/ui/index.html")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            // 页面要用 XHR 直接读内部文件（避开桥接的返回值上限），必须开这个
            allowUniversalAccessFromFileURLs = true
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = false
            loadsImagesAutomatically = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // 必须关掉：开着会让 WebView 按 980px 虚拟视口渲染再整页缩小，
            // 界面变成 1/3 大小、触摸目标只有十几像素，点不准也点不动
            useWideViewPort = false
            loadWithOverviewMode = false
            textZoom = 100
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            userAgentString = "$DESKTOP_UA MoReadAndroid/${BuildConfig.VERSION_NAME}"
        }
        webView.addJavascriptInterface(bridge, "MoNativeBridge")

        webView.webViewClient = object : WebViewClient() {
            /** index.html 里那句 <script src="bridge.js"> 在安卓上由这里接管，返回 Node 兼容层 */
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url.toString()
                if (url.endsWith("bridge.js")) {
                    return runCatching {
                        WebResourceResponse("application/javascript", "UTF-8", assets.open("nodebundle.js"))
                    }.onFailure { Log.e(TAG, "加载 nodebundle.js 失败", it) }.getOrNull()
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith("file://") || url.startsWith("about:") || url.startsWith("javascript:")) return false
                // 外链交给系统浏览器
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    true
                } catch (e: ActivityNotFoundException) {
                    false
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                pushLayout()
                pendingExternal?.let {
                    pendingExternal = null
                    bridge.emitToJs("if(window.MoApp&&window.MoApp.onOpenFile){window.MoApp.onOpenFile($it)}")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                val tag = "JS/" + when (m.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> "E"
                    ConsoleMessage.MessageLevel.WARNING -> "W"
                    else -> "D"
                }
                Log.d(tag, "${m.message()}  <- ${m.sourceId()}:${m.lineNumber()}")
                return true
            }
            override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton("确定") { _, _ -> result.confirm() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
            }
            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton("确定") { _, _ -> result.confirm() }
                    .setNegativeButton("取消") { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
            }
            override fun onJsPrompt(
                view: WebView, url: String, message: String, defaultValue: String, result: JsPromptResult
            ): Boolean {
                val input = EditText(this@MainActivity)
                input.setText(defaultValue)
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setView(input)
                    .setPositiveButton("确定") { _, _ -> result.confirm(input.text.toString()) }
                    .setNegativeButton("取消") { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
            }
        }
    }

    private fun collectInsets() {
        val root: View = window.decorView
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, ins ->
            val bars = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            val t = ins.getInsets(bars)
            lastInsets = JSONObject()
                .put("top", t.top).put("bottom", t.bottom)
                .put("left", t.left).put("right", t.right)
            pushLayout()
            ViewCompat.onApplyWindowInsets(v, ins)
            ins
        }
    }

    private fun setupBack() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function(){try{return !!(window.MoApp&&window.MoApp.onBack?window.MoApp.onBack():false)}catch(e){return false}})()"
                ) { r ->
                    val consumed = r == "true" || r == "\"true\""
                    if (!consumed) finishWithConfirm()
                }
            }
        })
    }

    /** 页面没消费返回键时：两秒内再按一次才退出 */
    private fun finishWithConfirm() {
        val now = System.currentTimeMillis()
        if (now - backPressedAt < 2000) {
            finishAffinity()
        } else {
            backPressedAt = now
            Toast.makeText(this, "再按一次退出墨读", Toast.LENGTH_SHORT).show()
        }
    }

    fun toast(msg: String) {
        runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }
    }

    /* ---------- 横竖屏 / 折叠屏 ---------- */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // 用刚传进来的 configuration：折叠屏开合时 resources 可能还没刷成新的
        pushLayout(newConfig)
    }

    private fun pushLayout(cfg: Configuration? = null) {
        val info = layoutInfo(cfg)
        val mode = info.optString("mode")
        val js = "if(window.MoApp&&window.MoApp.onLayout){window.MoApp.onLayout('$mode',$info)}"
        bridge.emitToJs(js)
        // WebView 视口尺寸的更新比 configuration 慢一拍，补两枪确保页面拿到的是最终尺寸
        mainHandler.postDelayed({ bridge.emitToJs(js) }, 150)
        mainHandler.postDelayed({ bridge.emitToJs(js) }, 450)
    }

    /**
     * 形态判定：
     *  - 竖屏一律 portrait（底部导航）——竖向握持时底部比侧边顺手
     *  - 横屏按最小宽度分 landscape（窄）/ wide（≥600dp，左栏加宽）
     * sw 档位（compact/medium/expanded）另外给页面用来调栅格密度
     */
    fun layoutInfo(cfgIn: Configuration? = null): JSONObject {
        val cfg = cfgIn ?: resources.configuration
        val sw = cfg.smallestScreenWidthDp
        val wDp = cfg.screenWidthDp
        val hDp = cfg.screenHeightDp
        val landscape = wDp > hDp || cfg.orientation == Configuration.ORIENTATION_LANDSCAPE
        val mode = when {
            landscape && sw >= 600 -> "wide"
            landscape -> "landscape"
            else -> "portrait"
        }
        val metrics = resources.displayMetrics
        return JSONObject()
            .put("mode", mode)
            .put("sw", sw)
            .put("bucket", if (sw >= 840) "expanded" else if (sw >= 600) "medium" else "compact")
            .put("landscape", landscape)
            .put("widthDp", wDp)
            .put("heightDp", hDp)
            .put("pxWidth", metrics.widthPixels)
            .put("pxHeight", metrics.heightPixels)
            .put("density", metrics.density.toDouble())
            .put("insets", insetInfo())
            .put("corners", cornerInfo())
    }

    /** 屏幕圆角半径（Android 12+ 才拿得到；拿不到就当 0，页面按直角处理） */
    @SuppressLint("NewApi")
    fun cornerInfo(): JSONObject {
        val out = JSONObject().put("tl", 0).put("tr", 0).put("bl", 0).put("br", 0)
        if (Build.VERSION.SDK_INT < 31) return out
        val wi = ViewCompat.getRootWindowInsets(window.decorView)?.toWindowInsets() ?: return out
        fun radius(pos: Int): Int = runCatching {
            val c = wi.getRoundedCorner(pos) ?: return@runCatching 0
            c.radius
        }.getOrDefault(0)
        out.put("tl", radius(android.view.RoundedCorner.POSITION_TOP_LEFT))
        out.put("tr", radius(android.view.RoundedCorner.POSITION_TOP_RIGHT))
        out.put("bl", radius(android.view.RoundedCorner.POSITION_BOTTOM_LEFT))
        out.put("br", radius(android.view.RoundedCorner.POSITION_BOTTOM_RIGHT))
        return out
    }

    fun insetInfo(): JSONObject = lastInsets

    /* ---------- 全屏 / 常亮 / 方向 ---------- */
    fun toggleFullscreen(): Boolean {
        fullscreen = !fullscreen
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (fullscreen) controller.hide(WindowInsetsCompat.Type.systemBars())
        else controller.show(WindowInsetsCompat.Type.systemBars())
        return fullscreen
    }

    fun setKeepScreenOn(on: Boolean) {
        runOnUiThread {
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    fun requestOrientation(mode: String) {
        requestedOrientation = when (mode) {
            "landscape" -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            "portrait" -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            "sensor" -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
            else -> android.content.pm.ActivityInfo.SCREEN_ORIENTATION_USER
        }
    }

    /* ---------- 文件选择 / 保存 ---------- */
    fun pickFiles(mimes: List<String>, multiple: Boolean): List<Picked> {
        val latch = CountDownLatch(1)
        var result: List<Uri> = emptyList()
        runOnUiThread {
            pickSink = { uris ->
                result = uris
                latch.countDown()
            }
            runCatching {
                pickLauncher.launch(Pair(if (mimes.isEmpty()) arrayOf("*/*") else mimes.toTypedArray(), multiple))
            }.onFailure { latch.countDown() }
        }
        latch.await(3, TimeUnit.MINUTES)
        return result.mapNotNull { uri ->
            takePermission(uri)
            runCatching {
                Picked(uri, queryName(uri), querySize(uri), MoFiles.stage(this, uri.toString()))
            }.onFailure { Log.w(TAG, "暂存文件失败: ${it.message}") }.getOrNull()
        }
    }

    fun createDocument(name: String, mime: String): Uri? {
        val latch = CountDownLatch(1)
        var uri: Uri? = null
        runOnUiThread {
            saveSink = { u ->
                uri = u
                latch.countDown()
            }
            runCatching { createLauncher.launch(Pair(mime, name)) }.onFailure { latch.countDown() }
        }
        latch.await(3, TimeUnit.MINUTES)
        return uri
    }

    private fun takePermission(uri: Uri) {
        runCatching {
            contentResolver.takePersistableUriPermission(
                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        }
    }

    private fun queryName(uri: Uri): String = try {
        contentResolver.query(uri, null, null, null, null)?.use { c ->
            val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (i >= 0 && c.moveToFirst()) c.getString(i) else null
        } ?: uri.lastPathSegment ?: "file"
    } catch (e: Exception) {
        uri.lastPathSegment ?: "file"
    }

    private fun querySize(uri: Uri): Long = try {
        contentResolver.query(uri, null, null, null, null)?.use { c ->
            val i = c.getColumnIndex(OpenableColumns.SIZE)
            if (i >= 0 && c.moveToFirst()) c.getLong(i) else 0L
        } ?: 0L
    } catch (e: Exception) {
        0L
    }

    /* ---------- 外部用墨读打开 txt / epub / 备份 ---------- */
    private fun handleIncoming(intent: Intent?) {
        val data = intent?.data ?: return
        if (intent.action != Intent.ACTION_VIEW) return
        runCatching {
            val staged = MoFiles.stage(this, data.toString())
            pendingExternal = JSONObject()
                .put("path", staged)
                .put("name", queryName(data))
                .put("mime", intent.type ?: "")
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncoming(intent)
        bridge.emitToJs(
            pendingExternal?.let { "if(window.MoApp.onOpenFile){window.MoApp.onOpenFile($it)}" } ?: ""
        )
        pendingExternal = null
    }

    override fun onPause() {
        super.onPause()
        bridge.emitToJs("if(window.MoApp&&window.MoApp.onPause){window.MoApp.onPause()}")
    }

    override fun onResume() {
        super.onResume()
        pushLayout()
        bridge.emitToJs("if(window.MoApp&&window.MoApp.onResume){window.MoApp.onResume()}")
    }

    override fun onDestroy() {
        runCatching { webView.destroy() }
        MoTts.destroy()
        super.onDestroy()
    }
}
