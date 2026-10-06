/**
 * fitness.js —— 卡路里估算 / 连续天数 / 热力图 / 勋章
 * 纯计算，不碰 wx API，方便写单测。
 */

'use strict'

var fmt = require('./format.js')

/** 深蹲的代谢当量 MET。中速徒手深蹲约 5.0（ACSM 口径） */
var SQUAT_MET = 5.0

/**
 * 卡路里（千卡）= MET × 体重(kg) × 时长(h)
 * 这是国际通用估算式；不追求精确，只求不同人之间可比。
 */
function calories(opts) {
  var weight = opts.weight || 60
  var hours = (opts.seconds || 0) / 3600
  return Math.round(SQUAT_MET * weight * hours * 10) / 10
}

/** 单次训练应消耗热量 → 由 Count 反推的补充下限，避免"秒停但蹲了很多次"估成 0 */
function caloriesFloor(count, weight) {
  return Math.round((count || 0) * 0.28 * ((weight || 60) / 60) * 10) / 10
}

/** [{key,count}] ← 把 sessions 聚合成按天计数 */
function groupByDay(sessions) {
  var map = {}
  var list = sessions || []
  for (var i = 0; i < list.length; i++) {
    var s = list[i]
    var key = fmt.dayKey(s.start || s.end || Date.now())
    map[key] = (map[key] || 0) + (s.count || 0)
  }
  return map
}

/**
 * 连续训练天数。
 * 今天还没练不算断签（今天还没过完），从昨天接着往前数。
 */
function computeStreak(sessions) {
  var map = groupByDay(sessions)
  var streak = 0
  var cursor = Date.now()
  if (!map[fmt.dayKey(cursor)]) cursor = cursor - fmt.DAY   // 今天没练 → 从昨天起算
  while (map[fmt.dayKey(cursor)] > 0) {
    streak += 1
    cursor -= fmt.DAY
  }
  return streak
}

/** 历史最长连续天数 */
function bestStreak(sessions) {
  var map = groupByDay(sessions)
  var keys = Object.keys(map).sort()
  var best = 0
  var run = 0
  var prev = null
  for (var i = 0; i < keys.length; i++) {
    var t = new Date(keys[i] + 'T00:00:00').getTime()
    if (prev && t - prev <= fmt.DAY + 100) run += 1
    else run = 1
    prev = t
    if (run > best) best = run
  }
  return Math.max(best, computeStreak(sessions))
}

/** 近 7 天（含今天）柱状图数据 */
function weeklySeries(sessions) {
  var map = groupByDay(sessions)
  var out = []
  for (var i = 6; i >= 0; i--) {
    var ts = Date.now() - i * fmt.DAY
    var key = fmt.dayKey(ts)
    out.push({
      key: key,
      label: ['日', '一', '二', '三', '四', '五', '六'][new Date(ts).getDay()],
      count: map[key] || 0,
      today: i === 0
    })
  }
  return out
}

/**
 * 12 周热力图数据（列优先，每列 = 一周，从周日开始）
 * level 0~4 用于配色
 */
function heatmapSeries(sessions, weeks) {
  weeks = weeks || 12
  var map = groupByDay(sessions)
  var now = new Date()
  // 本周周日的 0 点，再往前推 weeks-1 周 ⇒ 正好 weeks*7 个格子
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  var start = new Date(todayStart.getTime() - todayStart.getDay() * fmt.DAY)
  start = new Date(start.getTime() - (weeks - 1) * 7 * fmt.DAY)

  var max = 1
  var cells = []
  for (var d = 0; d < weeks; d++) {
    for (var w = 0; w < 7; w++) {
      var ts = start.getTime() + (d * 7 + w) * fmt.DAY
      var key = fmt.dayKey(ts)
      var c = map[key] || 0
      if (c > max) max = c
      cells.push({ key: key, label: fmt.dayLabel(key), count: c, future: ts > now.getTime() })
    }
  }
  for (var i = 0; i < cells.length; i++) {
    var cell = cells[i]
    var ratio = cell.count / max
    cell.level = cell.count === 0 ? 0 : (ratio > 0.75 ? 4 : (ratio > 0.5 ? 3 : (ratio > 0.25 ? 2 : 1)))
  }
  return { cells: cells, max: max }
}

/** 汇总统计 */
function summary(sessions) {
  var list = sessions || []
  var totalCount = 0
  var totalMs = 0
  var totalCalories = 0
  var bestSingle = 0
  for (var i = 0; i < list.length; i++) {
    totalCount += list[i].count || 0
    totalMs += list[i].durationMs || 0
    totalCalories += list[i].calories || 0
    if ((list[i].count || 0) > bestSingle) bestSingle = list[i].count || 0
  }
  return {
    sessions: list.length,
    totalCount: totalCount,
    totalMs: totalMs,
    totalCalories: Math.round(totalCalories * 10) / 10,
    bestSingle: bestSingle,
    avgCount: list.length ? Math.round(totalCount / list.length) : 0,
    streak: computeStreak(list),
    bestStreak: bestStreak(list)
  }
}

/**
 * 勋章 / 成就
 * val = 当前值，goal = 达标值，用于画进度条
 */
var BADGES = [
  { id: 'first',   name: '起步',     desc: '完成第一次训练',   icon: '01', val: function (s) { return s.length },                      goal: 1 },
  { id: 'single50', name: '半百',    desc: '单次训练 50 次',   icon: '50', val: function (s) { return maxCount(s) },                    goal: 50 },
  { id: 'single100', name: '百次',   desc: '单次训练 100 次',  icon: '100', val: function (s) { return maxCount(s) },                   goal: 100 },
  { id: 'total500', name: '积累者',  desc: '累计 500 次',      icon: '05', val: function (s) { return summary(s).totalCount },          goal: 500 },
  { id: 'total5000', name: '五千腿', desc: '累计 5000 次',     icon: '50', val: function (s) { return summary(s).totalCount },          goal: 5000 },
  { id: 'streak3',  name: '三日不断', desc: '连续打卡 3 天',   icon: '3',  val: function (s) { return summary(s).bestStreak },          goal: 3 },
  { id: 'streak7',  name: '七日不断', desc: '连续打卡 7 天',   icon: '7',  val: function (s) { return summary(s).bestStreak },          goal: 7 },
  { id: 'streak30', name: '月度铁人', desc: '连续打卡 30 天',  icon: '30', val: function (s) { return summary(s).bestStreak },          goal: 30 },
  { id: 'hour5',    name: '五小时',  desc: '累计训练 5 小时',  icon: 'H',  val: function (s) { return Math.floor(summary(s).totalMs / 3600000) }, goal: 5 }
]

function maxCount(sessions) {
  var m = 0
  for (var i = 0; i < (sessions || []).length; i++) {
    if ((sessions[i].count || 0) > m) m = sessions[i].count || 0
  }
  return m
}

/** [{id,name,desc,icon,val,goal,unlocked,progress}] */
function evaluateBadges(sessions, opts) {
  opts = opts || {}
  var only = opts.only
  var out = []
  for (var i = 0; i < BADGES.length; i++) {
    var b = BADGES[i]
    if (only && only.indexOf(b.id) === -1) continue
    var v = b.val(sessions || [])
    out.push({
      id: b.id, name: b.name, desc: b.desc, icon: b.icon,
      val: v, goal: b.goal,
      unlocked: v >= b.goal,
      progress: Math.min(1, v / b.goal)
    })
  }
  return out
}

module.exports = {
  SQUAT_MET: SQUAT_MET,
  calories: calories,
  caloriesFloor: caloriesFloor,
  groupByDay: groupByDay,
  computeStreak: computeStreak,
  bestStreak: bestStreak,
  weeklySeries: weeklySeries,
  heatmapSeries: heatmapSeries,
  summary: summary,
  evaluateBadges: evaluateBadges,
  BADGES: BADGES
}
