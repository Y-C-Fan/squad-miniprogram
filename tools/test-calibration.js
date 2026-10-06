/**
 * 校准行为专项自检
 *   node tools/test-calibration.js
 *
 * 背景：真机报障「校准完成后仍显示校准中」。
 * 根因是校准的"静止判定"设计有问题（详见 squat-detector.js 注释）。
 * 这个脚本把各种微抖幅度下的校准耗时固定下来，防止回归。
 */

'use strict'

const SquatDetector = require('../utils/squat-detector.js')

const DT = 20
const G = 9.81

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log(' FAIL  ' + name + (extra !== undefined ? '  →  ' + extra : '')) }
}

/** 合成手腕微抖：多频正弦叠加 + 噪声，更接近真人戴手环的生理性晃动 */
function jitter(amp, t) {
  return amp * (0.5 * Math.sin(2 * Math.PI * 3.1 * t)
              + 0.6 * Math.sin(2 * Math.PI * 0.8 * t + 1.1)
              + 0.4 * Math.sin(2 * Math.PI * 7.3 * t + 2.3))
    + (Math.random() - 0.5) * amp * 0.5
}

/**
 * @param amp     微抖幅度
 * @param moveAt  第几秒开始运动（null=全程不动）
 */
function calibTime(amp, moveAt, mode) {
  const det = new SquatDetector({ mode: mode, sensitivity: 'medium' })
  let ts = 1000
  for (let i = 0; i < 1500; i++) {
    const t = i * DT / 1000
    const moving = moveAt !== null && t >= moveAt
    const j = jitter(amp, t)
    const a = moving ? { x: 2.5, y: 1, z: G - 1.5 }
                     : { x: j, y: j * 0.5, z: G + j * 0.3 }
    const r = det.push(a, ts)
    if (r.ready) return (ts - 1000) / 1000
    ts += DT
  }
  return null
}

console.log('=== 校准必须能完成（各种微抖幅度）===')
// 手环戴手腕上站着不动，实测线加速度约 0.2~0.6 m/s²
// 阈值设计：抖幅 0.8（比实测上限还高）仍须在 2 秒内完成
for (const amp of [0, 0.3, 0.5, 0.8]) {
  for (const mode of ['tilt', 'lift']) {
    const t = calibTime(amp, 3, mode)
    ok(`微抖 ${amp} / ${mode} → 3s 后开始运动，2s 内完成校准`,
       t !== null && t <= 2, t === null ? '永不完成' : t + 's')
  }
}

console.log('')
console.log('=== 校准必须在静止时完成（开始运动则不算校准）===')
const tMove = calibTime(0.5, 0.2, 'lift')
ok('点开始 0.2s 后就动 → 应无法完成校准（而不是锁到错误基准）',
   tMove === null, tMove === null ? '正确：拒绝校准' : tMove + 's 锁到了运动中的基准')

console.log('')
console.log('=== 校准进度必须单调回传（供 UI 画进度条）===')
{
  const det = new SquatDetector({ mode: 'lift', sensitivity: 'medium' })
  let ts = 1000
  const progress = []
  let last = -1
  for (let i = 0; i < 60; i++) {
    const t = i * DT / 1000
    const j = jitter(0.4, t)
    const r = det.push({ x: j, y: j * 0.5, z: G + j * 0.3 }, ts)
    if (r.calibProgress < last) { progress.push('回退:' + r.calibProgress) }
    last = r.calibProgress
    progress.push(r.calibProgress)
    ts += DT
  }
  const monotonic = progress.every(p => typeof p === 'number')
  ok('calibProgress 始终为数字', monotonic)
  ok('校准完成后 calibProgress = 1', last === 1, last)
}

console.log('')
console.log('=== 校准完成后基准方向必须正确 ===')
{
  // 站着时设备竖直（重力沿 +z），校准后基准应与 +z 一致
  const det = new SquatDetector({ mode: 'tilt', sensitivity: 'medium' })
  let ts = 1000
  for (let i = 0; i < 200; i++) { det.push({ x: 0.1, y: 0, z: G }, ts); ts += DT }
  ok('基准方向已锁定', det.baseline !== null)
  if (det.baseline) {
    const dot = det.baseline.z
    ok('基准接近 (0,0,1) → dot=' + dot.toFixed(3), dot > 0.99)
  }
  // 校准后静止，倾角应接近 0
  let ts2 = ts
  let r = det.push({ x: 0.1, y: 0, z: G }, ts2)
  ok('校准后静止倾角 < 1° → ' + r.tilt.toFixed(2) + '°', r.tilt < 1)
}

console.log('')
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)