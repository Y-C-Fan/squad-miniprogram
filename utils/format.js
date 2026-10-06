/**
 * format.js —— 时间/日期格式化小工具
 */

'use strict'

var DAY = 86400000

function pad(n) { return n < 10 ? '0' + n : '' + n }

/** 秒 → mm:ss 或 h:mm:ss */
function duration(seconds) {
  seconds = Math.max(0, Math.floor(seconds))
  var h = Math.floor(seconds / 3600)
  var m = Math.floor((seconds % 3600) / 60)
  var s = seconds % 60
  if (h > 0) return h + ':' + pad(m) + ':' + pad(s)
  return pad(m) + ':' + pad(s)
}

/** 毫秒 → "12分34秒" / "1小时2分" */
function durationText(ms) {
  var sec = Math.floor(ms / 1000)
  if (sec < 60) return sec + '秒'
  var m = Math.floor(sec / 60)
  var s = sec % 60
  if (m < 60) return s ? m + '分' + s + '秒' : m + '分'
  var h = Math.floor(m / 60)
  return h + '小时' + (m % 60) + '分'
}

/** 本地日期 key：YYYY-MM-DD */
function dayKey(ts) {
  var d = new Date(ts)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 取 ts 所在自然日的 00:00 */
function startOfDay(ts) {
  var d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "今天" / "昨天" / "10-06" / "2025-10-06" */
function dayLabel(key) {
  var todayKey = dayKey(Date.now())
  var yesterdayKey = dayKey(Date.now() - DAY)
  if (key === todayKey) return '今天'
  if (key === yesterdayKey) return '昨天'
  var parts = key.split('-')
  var isThisYear = parts[0] === String(new Date().getFullYear())
  return isThisYear ? parts[1] + '-' + parts[2] : key
}

/** timestamp → "10-06 22:15" */
function dateTime(ts) {
  var d = new Date(ts)
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** timestamp → "22:15"，给记录列表用 */
function clockText(ts) {
  var d = new Date(ts)
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

module.exports = {
  DAY: DAY,
  pad: pad,
  duration: duration,
  durationText: durationText,
  dayKey: dayKey,
  startOfDay: startOfDay,
  dayLabel: dayLabel,
  dateTime: dateTime,
  clockText: clockText
}
