/**
 * 节点跑的离线自检脚本（不属于运行时代码，也不用打包进小程序）
 *   node tools/simulate.js
 *
 * 用合成加速度数据喂给 SquatDetector，验证两种模式能不能数对。
 * 真实使用时开头有一段站立静止（用于校准），仿真必须照做，
 * 否则会在下蹲中途锁定基准，测出来的准确率是假的。
 */

'use strict'

const SquatDetector = require('../utils/squat-detector.js')

const DT = 20 // ms
const G = 9.81
const LEAD_MS = 1500 // 开头的静止校准段

function rand() { return (Math.random() - 0.5) }

function still(n, noise) {
  const out = []
  for (let t = 0; t < n; t += DT) {
    const nz = noise === undefined ? 0.02 : noise
    out.push({ x: G * rand() * nz, y: G * rand() * nz, z: G + G * rand() * nz })
  }
  return out
}

/** 倾斜模式：设备绕 X 轴在 0 ↔ peakDeg 之间往复，模拟放裤袋时大腿带动的转动 */
function simTilt(reps, peakDeg, periodMs, opts = {}) {
  const out = still(LEAD_MS, opts.noise)
  const per = periodMs
  for (let r = 0; r < reps; r++) {
    for (let t = 0; t < per; t += DT) {
      const ph = t / per
      const k = ph < 0.5 ? ph / 0.5 : 1 - (ph - 0.5) / 0.5
      const theta = (peakDeg * (1 - Math.cos(Math.PI * k)) / 2) * Math.PI / 180
      const noise = opts.noise || 0.02
      out.push({
        x: G * (Math.sin(theta) + rand() * noise),
        y: G * rand() * noise,
        z: G * (Math.cos(theta) + rand() * noise)
      })
    }
  }
  return out
}

/** 垂直位移模式：设备姿态不变，整体上下往复，模拟拿在手上 */
function simLift(reps, ampMeters, periodMs, opts = {}) {
  const out = still(LEAD_MS, opts.noise)
  const w = 2 * Math.PI / (periodMs / 1000)
  for (let r = 0; r < reps; r++) {
    for (let t = 0; t < periodMs; t += DT) {
      const acc = -ampMeters * w * w * Math.cos(w * (t / 1000))
      const noise = opts.noise || 0.02
      out.push({
        x: G * rand() * noise,
        y: G * rand() * noise,
        z: G + acc + rand() * noise * 3
      })
    }
  }
  return out
}

let pass = 0
let fail = 0

function run(name, samples, mode, sensitivity, expect) {
  const det = new SquatDetector({ mode, sensitivity })
  let ts = 1000
  for (let i = 0; i < samples.length; i++) {
    det.push(samples[i], ts)
    ts += DT
  }
  const target = expect === null ? 0 : expect
  const ok = Math.abs(det.count - target) <= 1
  if (ok) pass++; else fail++
  const mark = ok ? '  ok  ' : ' FAIL '
  console.log(`${mark}${name.padEnd(30)} ${mode.padEnd(5)}/${sensitivity.padEnd(6)} → ${String(det.count).padStart(3)} (期望 ${target})`)
  return det.count
}

console.log('=== 倾斜模式（口袋 / 绑腿）===')
// 注意：低灵敏度档的语义就是"幅度不够大就不计数"，
// 所以小幅度 + 低灵敏度 期望值本来就是 0，这不是 bug。
for (const peak of [25, 35, 45, 60]) {
  for (const sens of ['low', 'medium', 'high']) {
    // low 档要求真实 ≥30°（低通缩水后 26° 触发），低于这个幅度本就不该计数
    const expect = (sens === 'low' && peak < 30) ? null : 10
    run(`峰值 ${peak}° 2.0s ×10`, simTilt(10, peak, 2000), 'tilt', sens, expect)
  }
}
run('慢速 3.0s / 45° ×10', simTilt(10, 45, 3000), 'tilt', 'medium', 10)
run('快速 1.2s / 45° ×10', simTilt(10, 45, 1200), 'tilt', 'medium', 10)
run('干扰 站立纯噪声 ×0', simTilt(0, 0, 2000, { noise: 0.08 }), 'tilt', 'medium', null)
run('干扰 小幅晃动6° ×0', simTilt(10, 6, 1500), 'tilt', 'low', null)

console.log('')
console.log('=== 垂直位移模式（手持）===')
for (const amp of [0.2, 0.3, 0.45, 0.6]) {
  for (const sens of ['low', 'medium', 'high']) {
    const expect = (sens === 'low' && amp < 0.25) ? null : 10
    run(`幅度 ${amp}m 2.0s ×10`, simLift(10, amp, 2000), 'lift', sens, expect)
  }
}
run('慢速 3.0s / 0.45m ×10', simLift(10, 0.45, 3000), 'lift', 'medium', 10)
run('快速 1.2s / 0.45m ×10', simLift(10, 0.45, 1200), 'lift', 'medium', 10)
run('干扰 手持纯噪声 ×0', simLift(0, 0, 2000, { noise: 0.08 }), 'lift', 'medium', null)
run('干扰 手持微晃5cm ×0', simLift(12, 0.05, 1200), 'lift', 'medium', null)

console.log('')
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)