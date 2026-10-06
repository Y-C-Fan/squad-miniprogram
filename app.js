/**
 * 蹲队 Squad —— app.js
 */
'use strict'

var store = require('./utils/storage.js')

App({
  globalData: {
    version: '1.0.0'
  },

  onLaunch: function () {
    // 首次进入时把默认设置落盘，后续设置页读写就有值了
    var settings = store.getSettings()
    store.saveSettings(settings)
    // 语音报数：在这里注册一次全局 TTS 实现即可，详见 utils/audio.js
  }
})
