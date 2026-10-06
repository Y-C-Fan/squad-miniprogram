/**
 * 设置页
 */

'use strict'

var store = require('../../utils/storage.js')
var fit = require('../../utils/fitness.js')

var SENS = [
  { key: 'low', label: '低' },
  { key: 'medium', label: '中' },
  { key: 'high', label: '高' }
]
var SENS_DESC = {
  low: '需要蹲得很深才计数，几乎不会误判',
  medium: '推荐：常规幅度深蹲',
  high: '轻微屈膝也会计数，容易多算'
}
var MODES = [
  { key: 'tilt', label: '口袋 / 绑腿' },
  { key: 'lift', label: '手持' }
]
var MODE_DESC = {
  tilt: '靠设备倾角变化判断。手机放裤袋或绑小腿上时用这个 —— 倾角是归一化信号，能区分「小幅屈伸」和「真深蹲」，准确率更高，优先用这个。',
  lift: '靠垂直位移判断。手机拿在手上、基本不转动时用。位移是绝对信号，无法区分小幅屈伸和深蹲，容易多算 —— 只在 tilt 模式完全数不出来时才用。'
}
var EVERY = [5, 10, 20]

Page({
  data: {
    settings: {},
    sensList: SENS,
    sensDesc: '',
    modeList: MODES,
    modeDesc: '',
    everyList: EVERY
  },

  onLoad: function () {
    this.load()
  },

  onShow: function () {
    this.load()
  },

  load: function () {
    var s = store.getSettings()
    this.setData({
      settings: s,
      sensDesc: SENS_DESC[s.sensitivity] || '',
      modeDesc: MODE_DESC[s.detectMode] || ''
    })
  },

  patch: function (key, value) {
    var s = {}
    var src = this.data.settings || {}
    for (var k in src) { s[k] = src[k] }
    s[key] = value
    store.saveSettings(s)
    this.setData({
      settings: s,
      sensDesc: SENS_DESC[s.sensitivity] || '',
      modeDesc: MODE_DESC[s.detectMode] || ''
    })
    return s
  },

  onWeight: function (e) {
    var v = parseFloat(e.detail.value)
    if (isNaN(v) || v <= 0) v = 60
    this.patch('weight', Math.min(200, Math.max(20, Math.round(v))))
  },

  onSens: function (e) { this.patch('sensitivity', e.currentTarget.dataset.key) },
  onMode: function (e) { this.patch('detectMode', e.currentTarget.dataset.key) },
  onEvery: function (e) { this.patch('voiceEvery', parseInt(e.currentTarget.dataset.key, 10)) },

  onSwitch: function (e) {
    this.patch(e.currentTarget.dataset.key, !!e.detail.value)
  },

  onClear: function () {
    var self = this
    wx.showModal({
      title: '清空所有训练记录？',
      content: '本地数据将被永久删除，无法恢复',
      confirmColor: '#ff7a5c',
      success: function (res) {
        if (!res.confirm) return
        store.clearSessions()
        wx.showToast({ title: '已清空', icon: 'none' })
        wx.reLaunch({ url: '/pages/index/index' })
      }
    })
  },

  onExport: function () {
    var sessions = store.getSessions()
    var lines = ['日期,时间,模式,次数,时长(秒),千卡,检测方式,灵敏度']
    for (var i = sessions.length - 1; i >= 0; i--) {
      var s = sessions[i]
      var d = new Date(s.start)
      var p = function (n) { return n < 10 ? '0' + n : '' + n }
      lines.push([
        d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
        p(d.getHours()) + ':' + p(d.getMinutes()),
        s.mode,
        s.count,
        Math.round((s.durationMs || 0) / 1000),
        s.calories,
        s.detectMode || '',
        s.sensitivity || ''
      ].join(','))
    }
    wx.setClipboardData({
      data: lines.join('\n'),
      success: function () {
        wx.showToast({ title: 'CSV 已复制到剪贴板', icon: 'none' })
      }
    })
  },

  goStats: function () {
    wx.switchTab({ url: '/pages/stats/stats' })
  }
})
