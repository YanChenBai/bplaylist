package com.bplaylist.mobile

object NativeCore {
    init { System.loadLibrary("bplaylist_mobile") }
    @JvmStatic external fun call(method: String, payload: String): String
}
