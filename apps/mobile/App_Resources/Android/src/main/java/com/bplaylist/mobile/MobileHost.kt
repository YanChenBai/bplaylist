package com.bplaylist.mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject
import java.net.NetworkInterface

object MobileHost {
    private val handler = Handler(Looper.getMainLooper())
    private var application: Context? = null
    private var activityRef: java.lang.ref.WeakReference<Activity>? = null
    private var browser: WebView? = null
    private var script = ""
    private var navigation: JSONObject? = null
    private var navigationStarted = 0L
    private var navigationReady = false
    private var fullscreenDeadline = 0L
    private var fullscreenAttempt = false
    private var previousIdentity = ""
    private var webZoom = 1.0
    private var appliedViewport = ""
    private val resizeZoom = Runnable { applyWebZoom() }
    private var insetValues = JSONObject()
    private var polling = false
    private var latest = JSONObject()
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    @JvmStatic fun initialize(activity: Activity): String {
        application = activity.applicationContext
        activityRef = java.lang.ref.WeakReference(activity)
        webZoom = activity.getSharedPreferences("webview", Context.MODE_PRIVATE).getFloat("zoom", 1f).toDouble()
        configureWindow(activity)
        val result = NativeCore.call("open", JSONObject.quote(activity.getDatabasePath("bplaylist.sqlite").also { it.parentFile?.mkdirs() }.absolutePath))
        if (JSONObject(result).optBoolean("ok")) {
            val server = JSONObject(NativeCore.call("server", "{\"enabled\":true,\"lan\":true}"))
            if (!server.optBoolean("ok")) android.util.Log.w("BPlaylist", server.optString("error"))
        }
        return result
    }

    @JvmStatic fun call(method: String, payload: String): String = NativeCore.call(method, payload)

    private fun cloudKey(): javax.crypto.SecretKey {
        val store = java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("bplaylist-cloud", null) as? javax.crypto.SecretKey)?.let { return it }
        val generator = javax.crypto.KeyGenerator.getInstance("AES", "AndroidKeyStore")
        generator.init(android.security.keystore.KeyGenParameterSpec.Builder(
            "bplaylist-cloud", android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes("GCM").setEncryptionPaddings("NoPadding").build())
        return generator.generateKey()
    }

    @JvmStatic fun saveCloudConfig(value: String) {
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, cloudKey())
        val encrypted = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        check(application!!.getSharedPreferences("cloud", Context.MODE_PRIVATE).edit()
            .putString("config", android.util.Base64.encodeToString(encrypted, android.util.Base64.NO_WRAP)).commit())
    }

    @JvmStatic fun cloudConfig(): String {
        val encoded = application!!.getSharedPreferences("cloud", Context.MODE_PRIVATE).getString("config", null) ?: return ""
        val encrypted = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP)
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(javax.crypto.Cipher.DECRYPT_MODE, cloudKey(), javax.crypto.spec.GCMParameterSpec(128, encrypted.copyOfRange(0, 12)))
        return String(cipher.doFinal(encrypted.copyOfRange(12, encrypted.size)), Charsets.UTF_8)
    }

    @JvmStatic fun setScript(value: String) { script = value }

    @JvmStatic fun createBrowser(activity: Activity): WebView {
        WebView.setWebContentsDebuggingEnabled((activity.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        browser?.let { old -> (old.parent as? ViewGroup)?.removeView(old); old.destroy() }
        val view = WebView(activity)
        browser = view
        view.setBackgroundColor(Color.BLACK)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = true
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
            userAgentString = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(webView: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                return uri.scheme != "https" && uri.scheme != "http"
            }
            override fun onPageStarted(webView: WebView, url: String, favicon: android.graphics.Bitmap?) {
                navigationReady = false
                appliedViewport = ""
                handler.removeCallbacks(resizeZoom)
            }
            override fun onPageFinished(webView: WebView, url: String) {
                navigationReady = true
                CookieManager.getInstance().flush()
                applyWebZoom()
                armFullscreen()
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(custom: View, callback: CustomViewCallback) {
                if (fullscreenView != null) { callback.onCustomViewHidden(); return }
                fullscreenView = custom
                fullscreenCallback = callback
                (activity.window.decorView as ViewGroup).addView(custom, FrameLayout.LayoutParams(-1, -1))
                setImmersive(activity, true)
            }
            override fun onHideCustomView() { exitFullscreen(activity) }
        }
        view.addOnLayoutChangeListener { _, left, _, right, _, oldLeft, _, oldRight, _ ->
            if (right - left != oldRight - oldLeft) {
                handler.removeCallbacks(resizeZoom)
                handler.postDelayed(resizeZoom, 180)
            }
        }
        view.loadUrl("https://www.bilibili.com")
        startPolling()
        return view
    }

    @JvmStatic fun releaseBrowser() {
        polling = false
        browser?.let { view -> view.stopLoading(); view.destroy() }
        browser = null
        handler.removeCallbacks(tick)
        handler.removeCallbacks(resizeZoom)
        appliedViewport = ""
    }

    @JvmStatic fun navigate(url: String) {
        handler.post { navigation = null; browser?.loadUrl(url) }
    }

    @JvmStatic fun back(): Boolean {
        val view = browser ?: return false
        if (fullscreenView != null) { exitFullscreen(view.context as Activity); return true }
        if (view.canGoBack()) { view.goBack(); return true }
        return false
    }

    @JvmStatic fun command(method: String, payload: String) {
        val result = JSONObject(NativeCore.call(method, payload))
        if (!result.optBoolean("ok")) return
        drainCommand()
    }

    @JvmStatic fun snapshot(): String = latest.toString()
    @JvmStatic fun insets(): String = insetValues.toString()

    @JvmStatic fun setWebZoom(zoom: Float) {
        webZoom = zoom.toDouble().coerceIn(0.75, 1.5)
        application?.getSharedPreferences("webview", Context.MODE_PRIVATE)?.edit()?.putFloat("zoom", webZoom.toFloat())?.apply()
        applyWebZoom()
    }

    private fun applyWebZoom() {
        val view = browser ?: return
        val width = view.width / view.resources.displayMetrics.density
        if (width <= 0) return

        val viewport = (if (width < 600) 560.0 else maxOf(width.toDouble(), 900.0)) / webZoom
        val scale = width / viewport
        val content = "width=$viewport,initial-scale=$scale,user-scalable=yes"
        if (content == appliedViewport) return

        appliedViewport = content
        view.settings.textZoom = if (width < 600) 125 else 110
        viewScript("""
            (()=>{let m=document.querySelector('meta[name="viewport"]');if(!m){m=document.createElement('meta');m.name='viewport';document.head.appendChild(m)}
            if(m.content!='$content')m.content='$content';
            document.documentElement.style.zoom='1';})()
        """.trimIndent())
    }

    @JvmStatic fun armFullscreen() {
        val state = JSONObject(NativeCore.call("state", "null"))
        if (state.optJSONObject("data")?.optBoolean("autoFullscreen", true) != true) return

        fullscreenDeadline = android.os.SystemClock.elapsedRealtime() + 12000
        fullscreenAttempt = false
    }

    private fun updateFullscreen(snapshot: JSONObject) {
        val uri = android.net.Uri.parse(snapshot.optString("url"))
        if (!uri.isHierarchical || uri.host?.endsWith("bilibili.com") != true) return
        val identity = "${uri.path}?p=${uri.getQueryParameter("p") ?: "1"}"
        if (identity != previousIdentity) {
            previousIdentity = identity
            armFullscreen()
        }
        if (fullscreenDeadline == 0L || fullscreenAttempt) return
        if (snapshot.optBoolean("webFullscreen") || android.os.SystemClock.elapsedRealtime() > fullscreenDeadline) {
            fullscreenDeadline = 0L
            return
        }
        if (!snapshot.optBoolean("available")) return

        fullscreenAttempt = true
        browser?.evaluateJavascript("""
            (()=>{if(document.fullscreenElement)return true;
            const b=document.querySelector('.bpx-player-ctrl-web,.bilibili-player-video-web-fullscreen,[aria-label="网页全屏"],[title*="网页全屏"]');
            if(!b)return false;b.click();return true;})()
        """.trimIndent()) { result ->
            fullscreenAttempt = false
            if (result == "true") fullscreenDeadline = 0L
        }
    }

    @JvmStatic fun setTheme(light: Boolean) {
        handler.post { applyTheme(light) }
    }

    private fun applyTheme(light: Boolean) {
        val window = activityRef?.get()?.window ?: return
        @Suppress("DEPRECATION")
        val legacyFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = if (light) window.decorView.systemUiVisibility or legacyFlags else window.decorView.systemUiVisibility and legacyFlags.inv()
        if (Build.VERSION.SDK_INT >= 30) {
            val flags = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (light) flags else 0, flags)
        }
        @Suppress("DEPRECATION")
        window.navigationBarColor = if (light) Color.rgb(250,250,250) else Color.rgb(14,14,14)
    }

    @JvmStatic fun animateLayout(view: ViewGroup) {
        val durationScale = android.provider.Settings.Global.getFloat(view.context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        if (durationScale == 0f) return

        val transition = android.transition.TransitionSet().apply {
            addTransition(android.transition.ChangeBounds())
            addTransition(android.transition.Fade())
            duration = 200
            interpolator = android.view.animation.PathInterpolator(0.2f, 0f, 0f, 1f)
        }
        // WebView 使用自己的合成表面，逐帧插值其边界会触发空白重绘。
        browser?.let { transition.excludeTarget(it, true) }
        android.transition.TransitionManager.beginDelayedTransition(view, transition)
    }

    @JvmStatic fun connection(lan: Boolean): String {
        val result = JSONObject(NativeCore.call("server", JSONObject().put("enabled", true).put("lan", lan).toString()))
        if (!result.optBoolean("ok")) return result.toString()
        val data = result.getJSONObject("data")
        val addresses = mutableListOf("127.0.0.1")
        if (lan) {
            NetworkInterface.getNetworkInterfaces()?.toList()?.filter { it.isUp && !it.isLoopback }?.forEach { network ->
                network.inetAddresses.toList().filter { !it.isLoopbackAddress && it is java.net.Inet4Address }.forEach { addresses.add(it.hostAddress ?: "") }
            }
        }
        data.put("endpoints", org.json.JSONArray(addresses.map { "http://$it:47821" }))
        return result.toString()
    }

    private fun startPolling() {
        if (polling) return
        polling = true
        handler.post(tick)
    }

    private val tick = object : Runnable {
        override fun run() {
            if (!polling) return
            val view = browser
            if (view != null && script.isNotBlank()) {
                view.evaluateJavascript(script) { raw ->
                    try {
                        val snapshot = JSONObject(raw ?: "{}")
                        latest = snapshot
                        updateFullscreen(snapshot)
                        val wasNavigating = navigation != null
                        applyNavigation(snapshot)
                        if (!wasNavigating && navigation == null) {
                            val result = JSONObject(NativeCore.call("snapshot", snapshot.toString()))
                            if (result.optBoolean("ok")) applyCommand(result.optJSONObject("data"))
                        }
                        PlaybackService.update(snapshot)
                    } catch (error: Exception) {
                        android.util.Log.w("BPlaylist", "Cannot read player snapshot", error)
                    }
                }
            }
            drainCommand()
            handler.postDelayed(this, 800)
        }
    }

    private fun drainCommand() {
        val result = JSONObject(NativeCore.call("command", "null"))
        if (result.optBoolean("ok")) applyCommand(result.optJSONObject("data"))
    }

    private fun applyCommand(command: JSONObject?) {
        command ?: return
        val view = browser ?: return
        when (command.optString("action")) {
            "navigate" -> {
                navigation = command
                navigationStarted = android.os.SystemClock.elapsedRealtime()
                navigationReady = false
                view.loadUrl(command.getString("url"))
            }
            "resume" -> {
                ensurePlaybackService()
                view.evaluateJavascript("document.querySelector('video')?.play()?.catch(()=>{})", null)
            }
            "pause" -> view.evaluateJavascript("document.querySelector('video')?.pause()", null)
            "seek" -> view.evaluateJavascript("(()=>{const v=document.querySelector('video');if(v)v.currentTime=${command.optDouble("position",0.0)}})()", null)
        }
    }

    private fun applyNavigation(snapshot: JSONObject) {
        val pending = navigation ?: return
        if (!navigationReady) return
        if (android.os.SystemClock.elapsedRealtime() - navigationStarted > 30000) { navigation = null; return }
        if (!snapshot.optBoolean("available") || snapshot.optDouble("duration",0.0) <= 0) return
        fun identity(value: String): String {
            val uri = android.net.Uri.parse(value)
            return "${uri.path?.trimEnd('/')}?p=${uri.getQueryParameter("p") ?: "1"}"
        }
        if (identity(snapshot.optString("url")) != identity(pending.optString("url"))) return
        val start = pending.optDouble("start",0.0)
        val range = JSONObject().put("start",start).put("end",pending.opt("end"))
        viewScript("""
            (()=>{const v=document.querySelector('video');if(!v)return;
            window.__bplaylistRange=$range;v.currentTime=$start;v.play().catch(()=>{});
            })()
        """.trimIndent())
        navigation = null
        if (pending.optBoolean("autoFullscreen")) armFullscreen()
        ensurePlaybackService()
    }

    private fun viewScript(source: String) { browser?.evaluateJavascript(source, null) }

    private fun ensurePlaybackService() {
        val context = application ?: return
        try { context.startForegroundService(Intent(context, PlaybackService::class.java)) }
        catch (error: Exception) { android.util.Log.w("BPlaylist", "Cannot start media service", error) }
    }

    private fun exitFullscreen(activity: Activity) {
        fullscreenView?.let { (it.parent as? ViewGroup)?.removeView(it) }
        fullscreenView = null
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        setImmersive(activity, false)
    }

    @JvmStatic fun setImmersive(activity: Activity, immersive: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            activity.window.insetsController?.apply {
                systemBarsBehavior = android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                if (immersive) hide(WindowInsets.Type.systemBars()) else show(WindowInsets.Type.systemBars())
            }
        } else {
            @Suppress("DEPRECATION")
            activity.window.decorView.systemUiVisibility = if (immersive) 5894 else 1792
        }
    }

    @JvmStatic fun configureWindow(activity: Activity) {
        val window = activity.window
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
        else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = 1792
        }
        if (Build.VERSION.SDK_INT >= 28) window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= 30) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        window.decorView.setOnApplyWindowInsetsListener { _, insets ->
            val density = activity.resources.displayMetrics.density
            if (Build.VERSION.SDK_INT >= 30) {
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                insetValues = JSONObject().put("left",safe.left/density).put("top",safe.top/density).put("right",safe.right/density).put("bottom",safe.bottom/density)
            } else {
                @Suppress("DEPRECATION")
                val cutout = if (Build.VERSION.SDK_INT >= 28) insets.displayCutout else null
                @Suppress("DEPRECATION")
                insetValues = JSONObject().put("left",maxOf(insets.systemWindowInsetLeft,cutout?.safeInsetLeft ?: 0)/density).put("top",maxOf(insets.systemWindowInsetTop,cutout?.safeInsetTop ?: 0)/density).put("right",maxOf(insets.systemWindowInsetRight,cutout?.safeInsetRight ?: 0)/density).put("bottom",maxOf(insets.systemWindowInsetBottom,cutout?.safeInsetBottom ?: 0)/density)
            }
            insets
        }
        window.decorView.requestApplyInsets()
        setTheme(false)
    }
}
