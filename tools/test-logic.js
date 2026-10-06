/**
 * 业务逻辑自检（storage / fitness / format）
 *   node tools/test-logic.js
 *
 * storage 依赖 wx API，这里做一个最小 mock，不碰真实存储。
 */

'use strict'

const mem = {}
global.wx = {
  getStorageSync: (k) => (k in mem ? mem[k] : ''),
  setStorageSync: (k, v) => { mem[k] = v },
  removeStorageSync: (k) => { delete mem[k] }
}

const store = require('../utils/storage.js')
const fit = require('../utils/fitness.js')
const fmt = require('../utils/format.js')

let pass = 0
let fail = 0

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log(' FAIL  ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')) }
}
function eq(name, a, b) { ok(name, a === b, { got: a, want: b }) }

console.log('=== format ===')
eq('duration 65 → 01:05', fmt.duration(65), '01:05')
eq('duration 3725 → 1:02:05', fmt.duration(3725), '1:02:05')
eq('durationText 90s → 1分30秒', fmt.durationText(90000), '1分30秒')
eq('durationText 2h → 2小时0分', fmt.durationText(7200000), '2小时0分')
ok('dayKey 形如 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(fmt.dayKey(Date.now())))
eq('dayLabel 今天', fmt.dayLabel(fmt.dayKey(Date.now())), '今天')
eq('dayLabel 昨天', fmt.dayLabel(fmt.dayKey(Date.now() - 86400000)), '昨天')

console.log('')
console.log('=== calories ===')
// MET 5.0 × 70kg × (600s/3600) = 58.33
const cal = fit.calories({ seconds: 600, weight: 70 })
ok('600s/70kg ≈ 58.3 千卡', Math.abs(cal - 58.3) < 0.2, cal)
// MET 5.0 × 60kg × 1h = 300
eq('weight 缺省用 60kg → 1小时300千卡', fit.calories({ seconds: 3600, weight: undefined }), 300)
eq('caloriesFloor 100次 ≈ 28千卡', fit.caloriesFloor(100, 60), 28)

console.log('')
console.log('=== storage 设置合并 ===')
const s0 = store.getSettings()
eq('默认灵敏度 medium', s0.sensitivity, 'medium')
eq('默认检测方式 tilt', s0.detectMode, 'tilt')
store.saveSettings({ sensitivity: 'high' })
const s1 = store.getSettings()
eq('覆盖后灵敏度 high', s1.sensitivity, 'high')
eq('未覆盖字段保留默认', s1.detectMode, 'tilt')
eq('未覆盖字段保留默认2', s1.voiceEvery, 10)

console.log('')
console.log('=== 连续天数 ===')
const DAY = 86400000
const now = Date.now()
function sessionAt(daysAgo, count) {
  return { id: 'x' + daysAgo + '_' + count, start: now - daysAgo * DAY, end: now - daysAgo * DAY, count: count || 10, durationMs: 60000, calories: 5 }
}
eq('今天+昨天+前天 = 3', fit.computeStreak([sessionAt(0), sessionAt(1), sessionAt(2)]), 3)
eq('今天没练，从昨天起算', fit.computeStreak([sessionAt(1), sessionAt(2)]), 2)
eq('中间断一天 = 1', fit.computeStreak([sessionAt(0), sessionAt(2), sessionAt(3)]), 1)
eq('一条不练 = 0', fit.computeStreak([]), 0)
eq('最长连续 = 4', fit.bestStreak([sessionAt(4), sessionAt(3), sessionAt(2), sessionAt(1), sessionAt(7)]), 4)

console.log('')
console.log('=== summary / 图表 ===')
const list = [sessionAt(0, 30), sessionAt(0, 20), sessionAt(1, 50)]
const sum = fit.summary(list)
eq('总次数', sum.totalCount, 100)
eq('训练条数', sum.sessions, 3)
eq('场均 = 33', sum.avgCount, 33)
eq('单次最多 = 50', sum.bestSingle, 50)
eq('今日合计 50', fit.weeklySeries(list)[6].count, 50)
const hm = fit.heatmapSeries(list, 12)
eq('热力图 12×7 = 84 格', hm.cells.length, 84)
ok('今日格子 level>0', hm.cells.find((c) => c.key === fmt.dayKey(now)).level > 0)
ok('存在未来格子', hm.cells.some((c) => c.future))

console.log('')
console.log('=== 勋章 ===')
const b = fit.evaluateBadges(list)
eq('勋章总数 9', b.length, 9)
eq('first 已解锁', b.find((x) => x.id === 'first').unlocked, true)
eq('single50 已解锁', b.find((x) => x.id === 'single50').unlocked, true)
eq('total5000 未解锁', b.find((x) => x.id === 'total5000').unlocked, false)
ok('进度被夹在 0~1', b.every((x) => x.progress >= 0 && x.progress <= 1))

console.log('')
console.log('=== 记录增删 ===')
store.clearSessions()
store.addSession({ id: 'a', start: now, count: 10, durationMs: 1000, calories: 3 })
store.addSession({ id: 'b', start: now, count: 20, durationMs: 2000, calories: 6 })
eq('新记录排在最前', store.getSessions()[0].id, 'b')
store.removeSession('b')
eq('删除后剩 1 条', store.getSessions().length, 1)
store.clearSessions()
eq('清空后为 0', store.getSessions().length, 0)

console.log('')
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)