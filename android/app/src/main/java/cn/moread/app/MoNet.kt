package cn.moread.app

import android.util.Log
import cn.moread.app.util.b64
import cn.moread.app.util.fromB64
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayOutputStream
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.*
import org.json.JSONObject

private const val TAG = "MoNet"

/** 浏览器 UA：很多小说站对非浏览器 UA 直接 403 */
private const val UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

/**
 * 网络层。这里只提供「发一次 HTTP 请求」这一件原子能力，
 * 字符集嗅探、编码解码、重定向、书源规则全部由 JS 侧的 src/net.js 负责。
 * 之所以要用 OkHttp 而不是 HttpURLConnection：书源时会用到 PROPFIND / MKCOL 这类非标准方法。
 */
object MoNet {
    private val cache: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .retryOnConnectionFailure(true)
        .build()

    /** 证书降级专用 client：忽略过期/自签名/域名不匹配 */
    private val insecureClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .sslSocketFactory(laxSslSocketFactory(), laxTrustManager())
        .hostnameVerifier { _, _ -> true }
        .build()

    private fun laxTrustManager(): X509TrustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private fun laxSslSocketFactory(): SSLSocketFactory {
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf<TrustManager>(laxTrustManager()), SecureRandom())
        return ctx.socketFactory
    }

    /** args: {url, method, headers, bodyB64, timeout, maxBytes, insecure} */
    fun request(args: JSONObject): JSONObject {
        val out = JSONObject()
        val url = args.optString("url")
        if (url.isEmpty()) return out.put("error", "缺少请求地址")

        val method = args.optString("method").takeIf { it.isNotEmpty() } ?: "GET"
        val timeoutMs = args.optInt("timeout").takeIf { it > 0 } ?: 18_000
        val maxBytes = args.optInt("maxBytes").takeIf { it > 0 } ?: (12 * 1024 * 1024)
        val insecure = args.optBoolean("insecure", false)

        val bodyBytes = args.optString("bodyB64").takeIf { it.isNotEmpty() }?.fromB64()
        val reqBody = when {
            bodyBytes == null -> null
            method == "GET" || method == "HEAD" -> null
            else -> bodyBytes.toRequestBody(null, 0, bodyBytes.size)
        }

        val builder = Request.Builder().url(url)
        builder.method(method, reqBody)

        // 默认请求头：书源最常依赖 UA / Accept / Accept-Language
        builder.header("User-Agent", UA)
        builder.header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        builder.header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        // 不在 native 层自动解压，交给 JS（net.js 会按 Content-Encoding 处理），避免"解压两次"
        builder.header("Accept-Encoding", "identity")

        val headers = args.optJSONObject("headers")
        if (headers != null) {
            for (key in headers.keys()) {
                val v = headers.optString(key, "")
                if (v.isEmpty()) continue
                // 这两个交给上层控制，避免每个键都被默认覆盖
                when (key.lowercase()) {
                    "content-length" -> Unit
                    else -> builder.header(key, v)
                }
            }
        }

        val client = if (insecure) insecureClient else cache
        val callClient = if (timeoutMs == 18000) client
        else client.newBuilder()
            .connectTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            .build()

        val callMs = System.currentTimeMillis()
        return try {
            callClient.newCall(builder.build()).execute().use { resp ->
                val hdr = JSONObject()
                for ((name, value) in resp.headers) {
                    if (name.equals("Content-Encoding", true)) continue   // 已在 identity 下不需要解压
                    if (hdr.has(name.lowercase())) {
                        hdr.put(name.lowercase(), hdr.optString(name.lowercase()) + ", " + value)
                    } else {
                        hdr.put(name.lowercase(), value)
                    }
                }
                val bytes = resp.body?.byteStream()?.use { stream ->
                    val buf = ByteArrayOutputStream()
                    val chunk = ByteArray(8192)
                    var total = 0
                    while (true) {
                        val n = stream.read(chunk)
                        if (n <= 0) break
                        if (total + n > maxBytes) break
                        buf.write(chunk, 0, n)
                        total += n
                    }
                    buf.toByteArray()
                } ?: ByteArray(0)

                out.put("status", resp.code)
                out.put("headers", hdr)
                out.put("url", resp.request.url.toString())
                out.put("b64", bytes.b64())
                val ms = System.currentTimeMillis() - callMs
                Log.d(TAG, "$method ${resp.code} ${bytes.size}B ${ms}ms $url")
                out
            }
        } catch (e: Exception) {
            Log.w(TAG, "请求失败 $method $url -> ${e.message}")
            val msg = friendlyError(e)
            out.put("error", msg)
            out.put("code", e.javaClass.simpleName.uppercase())
            out
        }
    }

    /** 把异常翻译成人话，和桌面版 net.js 的错误提示保持一致的口径 */
    private fun friendlyError(e: Throwable): String {
        val raw = e.message ?: ""
        val low = raw.lowercase()
        return when {
            e is java.net.UnknownHostException -> "域名无法解析：$raw（网站可能已关停）"
            low.contains("certificate") || low.contains("sslhandshake") || low.contains("trust anchor")
                || low.contains("certpathvalidator") -> "证书校验失败（会自动放宽后重试）"
            low.contains("timeout") || low.contains("timed out") -> "请求超时"
            low.contains("connection reset") -> "连接被重置"
            low.contains("econnrefused") -> "连接被拒绝"
            low.contains("network is unreachable") || low.contains("enonet") -> "网络不可用"
            low.contains("cleartext") -> "明文 HTTP 被系统拦截"
            else -> raw.ifBlank { "请求失败：" + e.javaClass.simpleName }
        }
    }
}
