package com.bplaylist.mobile

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import kotlin.concurrent.thread

interface FileCallback {
    fun complete(value: String?, error: String?)
}

object PlaylistFiles {
    private const val MAX_CHARACTERS = 8 * 1024 * 1024
    private val handler = Handler(Looper.getMainLooper())

    @JvmStatic fun read(context: Context, uri: Uri, callback: FileCallback) {
        perform(callback) {
            val stream = context.contentResolver.openInputStream(uri)
                ?: error("无法打开所选文件")

            stream.bufferedReader(Charsets.UTF_8).use { reader ->
                val result = StringBuilder()
                val buffer = CharArray(8192)

                while (true) {
                    val count = reader.read(buffer)
                    if (count < 0) break
                    require(result.length + count <= MAX_CHARACTERS) { "播放列表文件过大" }

                    result.append(buffer, 0, count)
                }

                result.toString()
            }
        }
    }

    @JvmStatic fun write(context: Context, uri: Uri, text: String, callback: FileCallback) {
        perform(callback) {
            val stream = context.contentResolver.openOutputStream(uri, "wt")
                ?: error("无法写入所选文件")

            stream.bufferedWriter(Charsets.UTF_8).use { writer -> writer.write(text) }
            "saved"
        }
    }

    private fun perform(callback: FileCallback, operation: () -> String) {
        thread(name = "BPlaylistFiles") {
            try {
                val value = operation()
                handler.post { callback.complete(value, null) }
            } catch (error: Exception) {
                handler.post { callback.complete(null, error.localizedMessage ?: "文件操作失败") }
            }
        }
    }
}
