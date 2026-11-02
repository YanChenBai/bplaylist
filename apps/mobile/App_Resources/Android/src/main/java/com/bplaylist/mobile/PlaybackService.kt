package com.bplaylist.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import org.json.JSONObject

class PlaybackService : Service() {
    private lateinit var session: MediaSession
    private var lastNotification = 0L
    private var artwork: android.graphics.Bitmap? = null

    companion object {
        private var instance: PlaybackService? = null
        fun update(snapshot: JSONObject) {
            instance?.publish(snapshot)
            if (instance == null && snapshot.optBoolean("available") && !snapshot.optBoolean("paused",true)) {
                MobileHost.command("resume", "null")
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        val artworkId = resources.getIdentifier("ic_launcher_foreground", "drawable", packageName)
        artwork = android.graphics.BitmapFactory.decodeResource(resources, artworkId)
        // WebView 已管理音频焦点；再次申请会让 Chromium 暂停正在播放的视频。
        session = MediaSession(this,"BPlaylist")
        session.setCallback(object : MediaSession.Callback() {
            override fun onPlay() { MobileHost.command("resume","null") }
            override fun onPause() { MobileHost.command("pause","null") }
            override fun onSkipToNext() { MobileHost.command("next","null") }
            override fun onSkipToPrevious() { MobileHost.command("previous","null") }
            override fun onSeekTo(position: Long) { MobileHost.command("seek",(position/1000.0).toString()) }
            override fun onStop() { MobileHost.command("pause","null"); stopSelf() }
        })
        session.isActive = true
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(NotificationChannel("playback","播放控制",NotificationManager.IMPORTANCE_LOW))
        val notification = notification(JSONObject())
        if (Build.VERSION.SDK_INT >= 29) startForeground(1,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(1,notification)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "pause","resume","next","previous" -> MobileHost.command(intent.action!!,"null")
        }
        return START_NOT_STICKY
    }

    private fun publish(snapshot: JSONObject) {
        val paused = snapshot.optBoolean("paused",true)
        val actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_STOP
        session.setPlaybackState(PlaybackState.Builder().setActions(actions).setState(if (paused) PlaybackState.STATE_PAUSED else PlaybackState.STATE_PLAYING,(snapshot.optDouble("position",0.0)*1000).toLong(),if (paused) 0f else 1f,SystemClock.elapsedRealtime()).build())
        session.setMetadata(MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE,snapshot.optString("title","BPlaylist"))
            .putString(MediaMetadata.METADATA_KEY_ARTIST,snapshot.optString("partTitle","哔哩哔哩"))
            .putLong(MediaMetadata.METADATA_KEY_DURATION,(snapshot.optDouble("duration",0.0)*1000).toLong())
            .putBitmap(MediaMetadata.METADATA_KEY_ART, artwork)
            .putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork)
            .putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON, artwork)
            .build())
        if (SystemClock.elapsedRealtime()-lastNotification>1000) {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(1,notification(snapshot))
            lastNotification = SystemClock.elapsedRealtime()
        }
    }

    private fun notification(snapshot: JSONObject): Notification {
        val icon = resources.getIdentifier("ic_notification","drawable",packageName)
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val builder = Notification.Builder(this,"playback")
            .setSmallIcon(icon).setContentTitle(snapshot.optString("title","BPlaylist"))
            .setLargeIcon(artwork)
            .setContentText(snapshot.optString("partTitle","播放列表"))
            .setVisibility(Notification.VISIBILITY_PUBLIC).setOnlyAlertOnce(true)
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0,1,2))
        if (launch != null) builder.setContentIntent(PendingIntent.getActivity(this,0,launch,PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        for ((index, action) in listOf("previous",if(snapshot.optBoolean("paused",true)) "resume" else "pause","next").withIndex()) {
            val resource = when(action) {"previous"->android.R.drawable.ic_media_previous;"next"->android.R.drawable.ic_media_next;"pause"->android.R.drawable.ic_media_pause;else->android.R.drawable.ic_media_play}
            builder.addAction(Notification.Action.Builder(resource,action,PendingIntent.getService(this,index,Intent(this,PlaybackService::class.java).setAction(action),PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build())
        }
        return builder.build()
    }

    override fun onDestroy() {
        instance = null
        session.isActive = false
        session.release()
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
}
