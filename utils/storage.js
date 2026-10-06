/**
 * storage.js —— 本地持久化
 *
 * 立场：全部数据只存在用户手机本地（wx.Storage），不上传任何服务器。
 * 和 DunDun 官方声明的 "未提供服务器保存你的隐私数据" 保持一致。
 */

'use strict'

var KEY_SESSIONS = 'sq:sessions'
var KEY_SETTINGS = 'sq:settings'

var DEFAULT_SETTINGS = {
  weight: 60,            // 体重 kg，仅用于卡路里估算
  sensitivity: 'medium', // low | medium | high
  detectMode: 'tilt',    // tilt(口袋/绑腿) | lift(手持)
  vibration: true,       // 每次有效深蹲震动
  vibrationStrong: true, // 组/目标完成时强震动
  voice: false,          // 语音报数（需自行接入 TTS，见 utils/audio.js）
  voiceEvery: 10,        // 每多少次报一次数
  debug: false           // 显示实时倾角等调试信息
}

function getSessions() {
  try {
    var list = wx.getStorageSync(KEY_SESSIONS)
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function saveSessions(list) {
  try { wx.setStorageSync(KEY_SESSIONS, list) } catch (e) {}
}

/** 新增一条训练记录（最新的排在最前） */
function addSession(session) {
  var list = getSessions()
  list.unshift(session)
  saveSessions(list)
  return session
}

function removeSession(id) {
  var list = getSessions().filter(function (s) { return s.id !== id })
  saveSessions(list)
  return list
}

function clearSessions() {
  try { wx.removeStorageSync(KEY_SESSIONS) } catch (e) {}
}

function getSettings() {
  var saved = {}
  try { saved = wx.getStorageSync(KEY_SETTINGS) || {} } catch (e) {}
  var merged = {}
  for (var k in DEFAULT_SETTINGS) {
    merged[k] = (saved[k] === undefined || saved[k] === null) ? DEFAULT_SETTINGS[k] : saved[k]
  }
  return merged
}

function saveSettings(settings) {
  try { wx.setStorageSync(KEY_SETTINGS, settings) } catch (e) {}
  return settings
}

module.exports = {
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  getSessions: getSessions,
  saveSessions: saveSessions,
  addSession: addSession,
  removeSession: removeSession,
  clearSessions: clearSessions,
  getSettings: getSettings,
  saveSettings: saveSettings
}
