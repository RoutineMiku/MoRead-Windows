package cn.moread.app.util

import android.util.Base64

fun ByteArray.b64(): String = Base64.encodeToString(this, Base64.NO_WRAP)
fun String.fromB64(): ByteArray = Base64.decode(this, Base64.DEFAULT)

/** 把任意路径压平，防止越出应用私有目录 */
fun java.io.File.safeUnder(root: java.io.File): Boolean =
    try { canonicalPath.startsWith(root.canonicalPath) } catch (e: Exception) { false }
