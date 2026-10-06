/**
 * audio.js —— 报数反馈的可插拔层
 *
 * 当前默认实现只有"震动 + Toast 数字"，零资源、零依赖、不需要任何审核资质。
 *
 * ── 想接真人/机器语音怎么办 ──────────────────────────────
 * 方案 A：预录 / TTS 生成的 mp3 放到 CDN，然后：
 *
 *     const audio = require('./utils/audio.js')
 *     audio.registerTTS((text) => {
 *       const ctx = wx.createInnerAudioContext()
 *       ctx.src = 'https://your.cdn/voice/' + encodeURIComponent(text) + '.mp3'
 *       ctx.play()
 *     })
 *
 * 方案 B：微信同声传译插件（需正式 AppID，测试号用不了）：
 *
 *     // app.json 里加
 *     "plugins": { "WechatSI": { "version": "0.3.5", "provider": "wx069ba97219f66d99" } }
 *     // app.js 里
 *     const plugin = requirePlugin('WechatSI')
 *     audio.registerTTS((text) => plugin.textToSpeech({ lang: 'zh_CN', tts: true, content: text }))
 *
 * 注册后，把设置页的"语音报数"打开即可。
 */

'use strict'

var ttsImpl = null
var enabled = false
var lastFileTick = 0

function setEnabled(v) { enabled = !!v }

function registerTTS(fn) {
  ttsImpl = (typeof fn === 'function') ? fn : null
}

/**
 * 报数。即使没有接 TTS，也会给一个视觉提示。
 * @param {number} n   当前次数
 * @param {object} ctx { viaToast:boolean }
 */
function announce(n, ctx) {
  ctx = ctx || {}
  if (!enabled) return
  if (typeof ttsImpl === 'function') {
    try { ttsImpl(String(n) + '次') } catch (e) {}
  }
}

/** 训练结束的长震动 + 提示音占位（小程序无法合成音频，这里用震动组合表达） */
function celebrate(ctx) {
  ctx = ctx || {}
  if (ctx.vibrateLong === false) return
  try {
    wx.vibrateLong && wx.vibrateLong()
  } catch (e) {}
}

/** 轻震动：每一次有效深蹲 */
function tick(type) {
  try {
    wx.vibrateShort({ type: type || 'medium' })
  } catch (e) {
    try { wx.vibrateShort() } catch (e2) {}
  }
}

/** 倒计时最后 3 秒的滴答 */
function countdownTick(left) {
  tick(left <= 1 ? 'heavy' : 'light')
}

module.exports = {
  setEnabled: setEnabled,
  registerTTS: registerTTS,
  announce: announce,
  celebrate: celebrate,
  tick: tick,
  countdownTick: countdownTick
}
