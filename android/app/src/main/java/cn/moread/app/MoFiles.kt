package cn.moread.app

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.MimeTypeMap
import cn.moread.app.util.b64
import cn.moread.app.util.fromB64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.zip.*

private const val TAG = "MoFiles"

/**
 * 文件层。所有 book/cache/data 都在应用私有目录下，路径对 JS 完全透明，
 * 由 env.paths.root 告诉 JS 根目录是什么。
 */
object MoFiles {

    private lateinit var rootDir: File

    fun init(context: Context) {
        rootDir = context.filesDir
        File(rootDir, "books").mkdirs()
        File(rootDir, "cache").mkdirs()
        File(rootDir, "cache/parsed").mkdirs()
        File(rootDir, "tmp").mkdirs()
        File(rootDir, "import").mkdirs()
    }

    fun root(): File = rootDir

    /** content:// 或外部路径 → 私有目录内的真实文件 */
    fun resolve(raw: String): File {
        val clean = raw.removePrefix("file://")
        if (clean.startsWith("content://")) {
            throw IllegalArgumentException("content Uri 必须先 stage")
        }
        return File(clean)
    }

    /** 把外部文件（SAF Uri 或绝对路径）拷到 tmp 目录，返回可直接读写的内部路径 */
    fun stage(context: Context, raw: String): String {
        val uri = Uri.parse(raw)
        val name = guessName(context, uri, raw)
        val dest = File(File(rootDir, "tmp"), System.currentTimeMillis().toString() + "-" + sanitize(name))
        return try {
            when (uri.scheme) {
                ContentResolver.SCHEME_CONTENT, ContentResolver.SCHEME_FILE -> {
                    context.contentResolver.openInputStream(uri)?.use { input ->
                        FileOutputStream(dest).use { out -> input.copyTo(out) }
                    } ?: throw IllegalStateException("无法打开所选文件")
                }
                ContentResolver.SCHEME_ANDROID_RESOURCE ->
                    throw IllegalStateException("不支持的资源类型")
                null -> {
                    val f = File(raw)
                    if (!f.exists()) throw IllegalStateException("文件不存在")
                    f.copyTo(dest, overwrite = true)
                    dest.absolutePath
                }
                else -> throw IllegalStateException("不支持的地址: " + uri.scheme)
            }
            dest.absolutePath
        } catch (e: Exception) {
            Log.w(TAG, "stage 失败 $raw -> ${e.message}")
            throw IllegalStateException("读取所选文件失败：" + (e.message ?: ""))
        }
    }

    private fun sanitize(name: String): String =
        name.replace(Regex("[^\\w.\\-一-龥()（）\\[\\] ]"), "_").take(72).ifBlank { "file" }

    private fun guessName(context: Context, uri: Uri, raw: String): String {
        if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
            runCatching {
                context.contentResolver.query(uri, null, null, null, null)?.use { c ->
                    val idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0 && c.moveToFirst()) return c.getString(idx)
                }
            }
        }
        return raw.substringAfterLast('/').ifBlank { "file" }
    }

    /* ---------------- 文件操作 ---------------- */

    fun exists(args: JSONObject): JSONObject {
        val f = resolve(args.optString("path"))
        return JSONObject().put("exists", f.exists())
    }

    fun stat(args: JSONObject): JSONObject {
        val f = resolve(args.optString("path"))
        return JSONObject()
            .put("exists", f.exists())
            .put("size", if (f.exists()) f.length() else 0)
            .put("isDir", f.isDirectory)
            .put("mtime", f.lastModified())
    }

    fun mkdir(args: JSONObject): JSONObject {
        val f = resolve(args.optString("path"))
        if (!f.exists()) {
            if (args.optBoolean("recursive", true)) f.mkdirs() else f.mkdir()
        }
        return JSONObject().put("ok", f.exists())
    }

    fun list(args: JSONObject): JSONObject {
        val f = resolve(args.optString("path"))
        val arr = JSONArray()
        if (f.isDirectory) {
            for (child in f.listFiles() ?: emptyArray()) {
                arr.put(JSONObject().put("name", child.name).put("isDir", child.isDirectory).put("size", child.length()))
            }
        }
        return JSONObject().put("items", arr)
    }

    fun read(args: JSONObject): JSONObject {
        val f = resolve(args.optString("path"))
        if (!f.exists()) throw IllegalStateException("文件不存在: " + f.name)
        if (f.isDirectory) throw IllegalStateException("这是一个目录")
        val size = f.length()
        val out = JSONObject().put("size", size)
            .put("abs", "file://" + f.absolutePath)
        if (size > 512 * 1024) {
            // 太大，不通过桥接返回内容，让 JS 用 file:// 自己读
            out.put("tooBig", true)
            return out
        }
        val bytes = f.readBytes()
        // 二进制被当成 UTF-8 文本时会有一堆 U+FFFD，这种情况直接走 XHR
        if (args.optBoolean("text")) {
            val s = bytes.toString(Charsets.UTF_8)
            val broken = s.count { it == '�' }
            if (broken * 3 > bytes.size / 4) {
                out.put("tooBig", true)
                return out
            }
            out.put("text", s)
        } else {
            out.put("b64", bytes.b64())
        }
        return out
    }

    fun write(args: JSONObject): JSONObject {
        val f = resolve(args.optString("path"))
        f.parentFile?.let { if (!it.exists()) it.mkdirs() }
        val append = args.optBoolean("append")
        runCatching {
            when {
                args.has("b64") -> {
                    val bytes = args.optString("b64").fromB64()
                    FileOutputStream(f, append).use { it.write(bytes) }
                }
                else -> {
                    val text = args.optString("text")
                    FileOutputStream(f, append).use { it.write(text.toByteArray(Charsets.UTF_8)) }
                }
            }
        }.onFailure { throw IllegalStateException("写入失败：" + (it.message ?: "")) }
        return JSONObject().put("ok", true).put("size", f.length())
    }

    fun copy(args: JSONObject): JSONObject {
        val from = resolve(args.optString("from"))
        val to = resolve(args.optString("to"))
        from.copyTo(to, overwrite = true)
        return JSONObject().put("ok", true)
    }

    fun rename(args: JSONObject): JSONObject {
        val from = resolve(args.optString("from"))
        val to = resolve(args.optString("to"))
        if (!from.renameTo(to)) throw IllegalStateException("重命名失败")
        return JSONObject().put("ok", true)
    }

    fun remove(args: JSONObject): JSONObject {
        val f = resolve(args.optString("path"))
        val ok = if (f.isDirectory) f.deleteRecursively() else f.delete()
        return JSONObject().put("ok", ok)
    }

    fun abs(args: JSONObject): JSONObject {
        val f = resolve(args.optString("path"))
        return JSONObject().put("abs", "file://" + f.absolutePath)
    }

    /* ---------------- zip / 压缩（给 zip.js 的 zlib 调用用） ---------------- */

    fun zlib(op: String, args: JSONObject): JSONObject {
        val input = args.optString("b64").fromB64()
        val out = runCatching {
            when (op) {
                "inflateRaw" -> Inflater(true).let { inflate(it, input) }
                "inflate" -> Inflater(false).let { inflate(it, input) }
                "gunzip" -> GZIPInputStream(input.inputStream()).use { it.readBytes() }
                "deflateRaw" -> rawDeflate(input)
                "deflate" -> zlibDeflate(input)
                "gzip" -> gzip(input)
                else -> throw IllegalArgumentException("未知的压缩操作: " + op)
            }
        }
        return out.fold(
            onSuccess = { JSONObject().put("b64", it.b64()) },
            onFailure = { JSONObject().put("error", it.message ?: "解压失败") }
        )
    }

    private fun inflate(inf: Inflater, input: ByteArray): ByteArray {
        inf.setInput(input)
        val bos = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (true) {
            val n = inf.inflate(buf)
            if (n == 0) break
            bos.write(buf, 0, n)
        }
        inf.end()
        return bos.toByteArray()
    }

    private fun rawDeflate(input: ByteArray): ByteArray {
        val def = Deflater(Deflater.DEFAULT_COMPRESSION, true)
        def.setInput(input)
        def.finish()
        val bos = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (!def.finished()) bos.write(buf, 0, def.deflate(buf))
        def.end()
        return bos.toByteArray()
    }

    private fun zlibDeflate(input: ByteArray): ByteArray {
        val def = Deflater()
        def.setInput(input)
        def.finish()
        val bos = ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (!def.finished()) bos.write(buf, 0, def.deflate(buf))
        def.end()
        return bos.toByteArray()
    }

    private fun gzip(input: ByteArray): ByteArray {
        val bos = ByteArrayOutputStream()
        GZIPOutputStream(bos).use { it.write(input) }
        return bos.toByteArray()
    }
}
