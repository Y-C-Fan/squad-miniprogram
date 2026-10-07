/**
 * 生成手环用的远端阈值配置
 *   node tools/make-band-config.js
 *
 * 输出：web/band-config.json（随网页版一起部署）
 *
 * 为什么需要这个文件：手环侧载一次很麻烦，改阈值不该每次都重装 rpk。
 * 所以阈值从网上拉：这个 JSON 就是那个"旋钮"。
 *
 * 两处改法：
 *   · 想改算法默认值 → 改 utils/squat-detector.js，然后跑本脚本重新生成
 *   · 只想针对真机手感微调 → 直接改 web/band-config.json（它会覆盖内置值）
 *
 * 手环端收到非法内容会整体回滚到内置默认并保持可用（见 applyRemote）。
 */

'use strict'

const fs = require('fs')
const path = require('path')
const SquatDetector = require('../utils/squat-detector.js')

const OUT = path.join(__dirname, '..', 'web', 'band-config.json')

const KEYS = ['enter', 'exit', 'minDownMs', 'maxDownMs', 'minMotion', 'minGapMs']
const LEVELS = ['low', 'medium', 'high']
const MODES = ['tilt', 'lift']

const cfg = { tilt: {}, lift: {} }

MODES.forEach((mode) => {
  LEVELS.forEach((lv) => {
    const d = new SquatDetector({ mode, sensitivity: lv })
    const c = d.getConfig()
    const row = {}
    KEYS.forEach((k) => { row[k] = c[k] })
    cfg[mode][lv] = row
  })
})

cfg.calibStill = new SquatDetector({ mode: 'tilt' }).calibStill

const payload = {
  _note: '本文件由 tools/make-band-config.js 从 utils/squat-detector.js 导出。手环启动时拉取并覆盖内置阈值 —— 改这里就不用重装 rpk。字段含义见 utils/squat-detector.js 注释。',
  _updated: new Date().toISOString().slice(0, 10),
  defaults: {
    // 手环戴在手腕上，倾角会被手臂摆动污染，默认走垂直位移检测
    mode: 'lift',
    sensitivity: 'medium'
  },
  calibStill: cfg.calibStill,
  tilt: cfg.tilt,
  lift: cfg.lift
}

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n')
console.log('OK  web/band-config.json  ' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB')
LEVELS.forEach((lv) => {
  console.log('    tilt/' + lv.padEnd(6) + ' enter=' + cfg.tilt[lv].enter + '  exit=' + cfg.tilt[lv].exit)
})
LEVELS.forEach((lv) => {
  console.log('    lift/' + lv.padEnd(6) + ' enter=' + cfg.lift[lv].enter + '  exit=' + cfg.lift[lv].exit)
})