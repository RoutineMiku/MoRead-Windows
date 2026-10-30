package cn.moread.app

import android.content.Intent
import android.os.Build
import android.util.Log
import android.webkit.JavascriptInterface
import cn.moread.app.util.fromB64
import org.json.JSONObject
import java.util.Locale

private const val TAG = "MoBridge"

/**
 * JS ⇄ 原生 的唯一入口。为了避开 Binder 事务 1MB 的限制，
 * 大文件一律不从这里过（见 MoFiles.read 的 tooBig + runtime.js 的 XHR 兜底）。
 */
class MoBridge(private val act: MainActivity) {

    fun emitToJs(js: String) {
        act.runOnUiThread {
            runCatching { act.webView.evaluateJavascript(js, null) }
                .onFailure { Log.w(TAG, "evaluateJavascript 失败: ${it.message}") }
        }
    }

    @JavascriptInterface
    fun callSync(name: String, argsJson: String): String {
        val args = runCatching { if (argsJson.isBlank()) JSONObject() else JSONObject(argsJson) }
            .getOrElse { JSONObject() }
        return try {
            dispatch(name, args).toString()
        } catch (e: Throwable) {
            Log.w(TAG, "callSync($name) 失败: ${e.message}")
            JSONObject().put("__error", e.message ?: e.javaClass.simpleName).toString()
        }
    }

    /** 不需要返回值的单向调用，避免 JS 白等 */
    @JavascriptInterface
    fun callFire(name: String, argsJson: String) {
        try {
            val args = if (argsJson.isBlank()) JSONObject() else JSONObject(argsJson)
            dispatch(name, args)
        } catch (e: Throwable) {
            Log.w(TAG, "callFire($name) 失败: ${e.message}")
        }
    }

    private fun dispatch(name: String, a: JSONObject): JSONObject = when {
        name == "http.request" -> MoNet.request(a)
        name.startsWith("zlib.") -> MoFiles.zlib(name.substring(5), a)
        name.startsWith("file.") -> files(name.substring(5), a)
        name.startsWith("dialog.") -> dialog(name.substring(7), a)
        name.startsWith("tts.") -> tts(name.substring(4), a)
        name.startsWith("env.") -> env(name.substring(4), a)
        name.startsWith("app.") -> app(name.substring(4), a)
        name.startsWith("win.") -> win(name.substring(4), a)
        name.startsWith("ui.") -> ui(name.substring(3), a)
        else -> throw IllegalArgumentException("未知的原生方法: $name")
    }

    /* ---------------- 文件 ---------------- */
    private fun files(op: String, a: JSONObject): JSONObject = when (op) {
        "exists" -> MoFiles.exists(a)
        "stat" -> MoFiles.stat(a)
        "mkdir" -> MoFiles.mkdir(a)
        "list" -> MoFiles.list(a)
        "read" -> MoFiles.read(a)
        "write" -> MoFiles.write(a)
        "copy" -> MoFiles.copy(a)
        "rename" -> MoFiles.rename(a)
        "remove" -> MoFiles.remove(a)
        "abs" -> MoFiles.abs(a)
        "stage" -> JSONObject().put("path", MoFiles.stage(act, a.optString("path")))
        else -> throw IllegalArgumentException("未知文件操作: $op")
    }

    /* ---------------- 文件选择 / 保存 ---------------- */
    private fun dialog(op: String, a: JSONObject): JSONObject = when (op) {
        "open" -> {
            val mimes = ArrayList<String>()
            val arr = a.optJSONArray("mimes")
            if (arr != null) for (i in 0 until arr.length()) mimes.add(arr.optString(i))
            if (mimes.isEmpty()) mimes.add("*/*")
            val picked = act.pickFiles(mimes, a.optBoolean("multiple", false))
            val items = org.json.JSONArray()
            for (p in picked) {
                items.put(JSONObject()
                    .put("name", p.name)
                    .put("path", p.staged)
                    .put("size", p.size)
                    .put("uri", p.uri.toString()))
            }
            JSONObject().put("ok", true).put("items", items)
        }
        "save" -> {
            val name = a.optString("name").ifBlank { "export.bin" }
            val mime = a.optString("mime").ifBlank { mimeOf(name) }
            val uri = act.createDocument(name, mime)
            if (uri == null) {
                JSONObject().put("ok", false)
            } else {
                val bytes = if (a.has("b64")) a.optString("b64").fromB64()
                else a.optString("text").toByteArray(Charsets.UTF_8)
                if (writeBytes(uri, bytes)) {
                    JSONObject().put("ok", true).put("path", uri.toString()).put("name", name).put("size", bytes.size)
                } else {
                    JSONObject().put("ok", false).put("error", "写入失败")
                }
            }
        }
        else -> throw IllegalArgumentException("未知对话框操作: $op")
    }

    private fun writeBytes(uri: android.net.Uri, bytes: ByteArray): Boolean = try {
        act.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } != null
    } catch (e: Exception) {
        Log.w(TAG, "写文件失败 ${e.message}")
        false
    }

    private fun mimeOf(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase(Locale.US)
        return when (ext) {
            "json" -> "application/json"
            "zip" -> "application/zip"
            "txt" -> "text/plain"
            "epub" -> "application/epub+zip"
            else -> "application/octet-stream"
        }
    }

    /* ---------------- 环境信息 ---------------- */
    private fun env(op: String, a: JSONObject): JSONObject = when (op) {
        "info" -> {
            val paths = JSONObject()
                .put("root", MoFiles.root().absolutePath)
                .put("cache", act.cacheDir.absolutePath)
                .put("external", act.getExternalFilesDir(null)?.absolutePath ?: "")
            JSONObject()
                .put("app", "moread")
                .put("platform", "android")
                .put("version", BuildConfig.VERSION_NAME)
                .put("code", BuildConfig.VERSION_CODE)
                .put("sdk", Build.VERSION.SDK_INT)
                .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
                .put("paths", paths)
        }
        "layout" -> act.layoutInfo()
        "insets" -> act.insetInfo()
        "corners" -> act.cornerInfo()
        else -> throw IllegalArgumentException("未知环境查询: $op")
    }

    /* ---------------- 应用 / 系统 ---------------- */
    private fun app(op: String, a: JSONObject): JSONObject = when (op) {
        "toast" -> { act.toast(a.optString("msg")); JSONObject().put("ok", true) }
        "quit" -> { act.runOnUiThread { act.finishAndRemoveTask() }; JSONObject().put("ok", true) }
        "browse" -> {
            val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(a.optString("url")))
            act.startActivity(intent)
            JSONObject().put("ok", true)
        }
        "log" -> { Log.i(TAG, a.optString("msg")); JSONObject().put("ok", true) }
        "ready" -> JSONObject().put("ok", true)
        else -> throw IllegalArgumentException("未知应用操作: $op")
    }

    /* ---------------- 窗口 ---------------- */
    private fun win(op: String, a: JSONObject): JSONObject = when (op) {
        "minimize" -> { act.runOnUiThread { act.moveTaskToBack(true) }; JSONObject().put("ok", true) }
        "fullscreen" -> JSONObject().put("full", act.toggleFullscreen())
        "isFull" -> JSONObject().put("full", act.fullscreen)
        else -> throw IllegalArgumentException("未知窗口操作: $op")
    }

    /* ---------------- 界面细节 ---------------- */
    private fun ui(op: String, a: JSONObject): JSONObject = when (op) {
        "keepScreenOn" -> { act.setKeepScreenOn(a.optBoolean("on", true)); JSONObject().put("ok", true) }
        "orientation" -> { act.requestOrientation(a.optString("mode", "user")); JSONObject().put("ok", true) }
        else -> throw IllegalArgumentException("未知界面操作: $op")
    }

    /* ---------------- 朗读 ---------------- */
    private fun tts(op: String, a: JSONObject): JSONObject = when (op) {
        "voices" -> MoTts.voices()
        "state" -> MoTts.state()
        "speak" -> MoTts.speak(a)
        "stop" -> MoTts.stop()
        "set" -> MoTts.set(a)
        else -> throw IllegalArgumentException("未知朗读操作: $op")
    }

    companion object {
        fun escape(s: String): String = JSONObject.quote(s)
    }
}
