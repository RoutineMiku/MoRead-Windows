package cn.moread.app

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

private const val TAG = "MoTts"

/**
 * 朗读。WebView 自带的 speechSynthesis 在安卓上不出声，所以由这里接管，
 * JS 侧只是把 Web Speech API 转发过来（见 runtime.js 的 polyfill）。
 */
object MoTts {

    private var tts: TextToSpeech? = null
    private var ready = false
    private var lastLang = ""
    private var lastRate = 1f
    private var lastPitch = 1f
    private var onEvent: ((type: String, id: String, extra: JSONObject?) -> Unit)? = null

    fun init(context: Context) {
        tts = TextToSpeech(context.applicationContext) { status ->
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
                tts?.language = Locale.SIMPLIFIED_CHINESE
                Log.d(TAG, "TTS 就绪")
            } else {
                Log.w(TAG, "TTS 初始化失败 status=$status")
            }
        }.also { engine ->
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    utteranceId?.let { emit("start", it) }
                }
                override fun onDone(utteranceId: String?) {
                    utteranceId?.let { emit("done", it) }
                }
                @Deprecated("legacy")
                override fun onError(utteranceId: String?) {
                    utteranceId?.let { emit("error", it, JSONObject().put("error", "unknown")) }
                }
                override fun onError(utteranceId: String?, errorCode: Int) {
                    utteranceId?.let {
                        emit("error", it, JSONObject().put("error", "code-$errorCode").put("code", errorCode))
                    }
                }
                override fun onStop(utteranceId: String?, interrupted: Boolean) {
                    utteranceId?.let { emit(if (interrupted) "stopped" else "done", it) }
                }
            })
        }
    }

    fun setEventListener(cb: (type: String, id: String, extra: JSONObject?) -> Unit) {
        onEvent = cb
    }

    private fun emit(type: String, id: String, extra: JSONObject? = null) {
        onEvent?.invoke(type, id, extra)
    }

    fun destroy() {
        runCatching { tts?.shutdown() }
        tts = null
        ready = false
    }

    fun voices(): JSONObject {
        val arr = JSONArray()
        if (!ready) return JSONObject().put("voices", arr).put("ready", false)
        val engineVoices: Set<Voice> = runCatching { tts!!.voices }.getOrNull() ?: emptySet()
        for (v in engineVoices) {
            arr.put(JSONObject()
                .put("id", v.name)
                .put("name", v.name.replace('_', ' ').take(40))
                .put("lang", v.locale.toLanguageTag())
                .put("network", runCatching { v.isNetworkConnectionRequired }.getOrDefault(false))
                .put("quality", runCatching { v.quality }.getOrDefault(0)))
        }
        // 有些引擎只在 getVoices() 里返回默认语言，兜一个
        if (arr.length() == 0) {
            arr.put(JSONObject().put("id", "default").put("name", "系统默认").put("lang", "zh-CN"))
        }
        return JSONObject().put("voices", arr).put("ready", true)
    }

    fun state(): JSONObject = JSONObject()
        .put("ready", ready)
        .put("speaking", runCatching { tts!!.isSpeaking }.getOrDefault(false))
        .put("lang", lastLang)
        .put("rate", lastRate)
        .put("pitch", lastPitch)

    fun speak(args: JSONObject): JSONObject {
        val engine = tts
            ?: return JSONObject().put("ok", false).put("error", "语音引擎还在初始化，稍等几秒再试")
        if (!ready) return JSONObject().put("ok", false).put("error", "语音引擎未就绪")

        val text = args.optString("text")
        if (text.isEmpty()) return JSONObject().put("ok", false).put("error", "没有要朗读的内容")
        val id = args.optString("id").ifBlank { "u" + System.currentTimeMillis() }
        val lang = args.optString("lang").ifBlank { "zh-CN" }
        val voiceURI = args.optString("voiceURI")
        val rate = args.optDouble("rate", 1.0).toFloat().coerceIn(0.2f, 3f)
        val pitch = args.optDouble("pitch", 1.0).toFloat().coerceIn(0.2f, 2f)
        val volume = args.optDouble("volume", 1.0).toFloat().coerceIn(0f, 1f)

        if (voiceURI.isNotEmpty()) {
            val v = runCatching { tts!!.voices }.getOrNull()?.firstOrNull { it.name == voiceURI }
            if (v != null) runCatching { tts!!.voice = v }
            else applyLang(lang)
        } else applyLang(lang)

        lastRate = rate; lastPitch = pitch
        engine.setSpeechRate(rate)
        engine.setPitch(pitch)

        val params = Bundle()
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume)
        val r = engine.speak(text, TextToSpeech.QUEUE_FLUSH, params, id)
        if (r != TextToSpeech.SUCCESS) {
            Log.w(TAG, "speak 返回 $r")
            return JSONObject().put("ok", false).put("error", "朗读失败（引擎返回 $r）")
        }
        return JSONObject().put("ok", true).put("id", id)
    }

    private fun applyLang(tag: String) {
        if (tag == lastLang) return
        val locale = runCatching { Locale.forLanguageTag(tag) }.getOrNull() ?: Locale.SIMPLIFIED_CHINESE
        val r = runCatching { tts!!.setLanguage(locale) }.getOrDefault(TextToSpeech.LANG_MISSING_DATA)
        lastLang = tag
        Log.d(TAG, "setLanguage $tag -> $r")
    }

    fun stop(): JSONObject {
        runCatching { tts?.stop() }
        return JSONObject().put("ok", true)
    }

    fun set(args: JSONObject): JSONObject {
        if (args.has("rate")) lastRate = args.optDouble("rate", 1.0).toFloat()
        if (args.has("pitch")) lastPitch = args.optDouble("pitch", 1.0).toFloat()
        if (args.has("voice")) {
            val id = args.optString("voice")
            val v = runCatching { tts!!.voices }.getOrNull()?.firstOrNull { it.name == id }
            if (v != null) runCatching { tts!!.voice = v }
        }
        return JSONObject().put("ok", true)
    }
}
