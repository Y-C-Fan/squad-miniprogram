/**
 * 远端阈值覆盖专项自检
 *   node tools/test-remote.js
 *
 * 背景：自用场景下要靠远端配置调阈值（改 JSON 代替重装 rpk），
 * 而这份 JSON 是网络输入。这里把 applyRemote 的接受/拒绝/回滚行为钉死。
 *
 * 重点：坏配置必须被整体回滚，且不能污染模块级 PRESET。
 *
 * ⚠️ 每个用例都重新 load 一遍模块：applyRemote 改的是模块级预设对象，
 *    不隔离的话用例之间会互相污染，测出来的结论不可信。
 */

'use strict'

const MODULE_PATH = require.resolve('../utils/squat-detector.js')

function loadFresh() {
  delete require.cache[MODULE_PATH]
  return require(MODULE_PATH)
}

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log(' FAIL  ' + name + (extra !== undefined ? '  →  ' + extra : '')) }
}

function near(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps) }

// 取一份干净模块的 medium tilt / medium lift 作为「内置默认」基准
const BASE = (function () {
  const S = loadFresh()
  return {
    tilt: new S({ mode: 'tilt', sensitivity: 'medium' }).getConfig().enter,
    lift: new S({ mode: 'lift', sensitivity: 'medium' }).getConfig().enter,
    calibStill: new S({ mode: 'tilt' }).calibStill
  }
})()

console.log('\n远端阈值覆盖')

{
  const S = loadFresh()
  const d = new S({ mode: 'tilt', sensitivity: 'medium' })
  ok('合法 patch 返回 true', d.applyRemote({ tilt: { medium: { enter: 25.0, exit: 19.0 } } }) === true)
  ok('  → enter 已覆盖', near(d.getConfig().enter, 25.0), d.getConfig().enter)
  ok('  → exit 已覆盖', near(d.getConfig().exit, 19.0), d.getConfig().exit)
  ok('  → 未给出的字段保持原值', near(d.getConfig().minMotion, 0.2), d.getConfig().minMotion)
}

{
  // 只给 enter，且新 enter 比原 exit 还小 → 合并后滞回带反了，必须拒绝
  const S = loadFresh()
  const d = new S({ mode: 'tilt', sensitivity: 'medium' })
  ok('只改 enter 导致 exit>=enter → 拒绝', d.applyRemote({ tilt: { medium: { enter: 10.0 } } }) === false)
  ok('  → 内置默认没被动过', near(d.getConfig().enter, BASE.tilt), d.getConfig().enter)
}

{
  const S = loadFresh()
  const d = new S({ mode: 'tilt', sensitivity: 'medium' })
  ok('未知字段被拒', d.applyRemote({ tilt: { medium: { enter: 25, exit: 19, hack: 1 } } }) === false)
  ok('  → 无副作用', near(d.getConfig().enter, BASE.tilt))
}

{
  const S = loadFresh()
  const d = new S({ mode: 'tilt', sensitivity: 'medium' })
  ok('字符串数值被拒', d.applyRemote({ tilt: { medium: { enter: '25' } } }) === false)
  ok('NaN 被拒', d.applyRemote({ tilt: { medium: { enter: NaN } } }) === false)
  ok('Infinity 被拒', d.applyRemote({ tilt: { medium: { enter: Infinity } } }) === false)
  ok('负数被拒', d.applyRemote({ tilt: { medium: { exit: -1 } } }) === false)
  ok('零被拒', d.applyRemote({ tilt: { medium: { minMotion: 0 } } }) === false)
  ok('  → 全程无副作用', near(d.getConfig().enter, BASE.tilt), d.getConfig().enter)
}

{
  const S = loadFresh()
  const d = new S({ mode: 'tilt', sensitivity: 'medium' })
  ok('空对象被拒', d.applyRemote({}) === false)
  ok('null 被拒', d.applyRemote(null) === false)
  ok('字符串被拒', d.applyRemote('nope') === false)
  ok('模式名拼错被拒（不静默新建）', d.applyRemote({ tlit: { medium: { enter: 25, exit: 19 } } }) === false)
  ok('档位名拼错被拒', d.applyRemote({ tilt: { midum: { enter: 25, exit: 19 } } }) === false)
  ok('空 patch 被拒', d.applyRemote({ tilt: { medium: {} } }) === false)
}

{
  // 一个模式合法、一个模式非法 → 必须整体回滚，不能只回滚一半
  const S = loadFresh()
  const d = new S({ mode: 'tilt', sensitivity: 'medium' })
  const r = d.applyRemote({
    tilt: { medium: { enter: 30, exit: 23 } },      // 合法
    lift: { medium: { enter: 0.08, exit: 0.9 } }     // exit > enter，非法
  })
  ok('一半非法 → 整体拒绝', r === false)
  ok('  → tilt 已写入的部分被回滚', near(d.getConfig().enter, BASE.tilt), d.getConfig().enter)
  const l = new S({ mode: 'lift', sensitivity: 'medium' })
  ok('  → lift 未被污染', near(l.getConfig().enter, BASE.lift), l.getConfig().enter)
}

{
  const S = loadFresh()
  const d = new S({ mode: 'tilt', sensitivity: 'medium' })
  ok('多档位同时覆盖可行', d.applyRemote({
    tilt: {
      low: { enter: 30, exit: 23 },
      medium: { enter: 23, exit: 17 },
      high: { enter: 16, exit: 12 }
    }
  }) === true)
  ok('  → 当前档（medium）生效', near(d.getConfig().enter, 23), d.getConfig().enter)
  d.setSensitivity('high')
  ok('  → 切到 high 用 high 的值', near(d.getConfig().enter, 16), d.getConfig().enter)
  d.setSensitivity('low')
  ok('  → 切到 low 用 low 的值', near(d.getConfig().enter, 30), d.getConfig().enter)
}

{
  const S = loadFresh()
  const d = new S({ mode: 'tilt', sensitivity: 'medium' })
  ok('合法 calibStill 被接受', d.applyRemote({ tilt: { medium: { enter: 25, exit: 19 } }, calibStill: 0.42 }) === true)
  ok('  → calibStill 已更新', near(d.calibStill, 0.42), d.calibStill)
  ok('非法 calibStill 不影响整体接受', d.applyRemote({ tilt: { medium: { enter: 24, exit: 18 } }, calibStill: -1 }) === true)
  ok('  → calibStill 保持上一次的好值', near(d.calibStill, 0.42), d.calibStill)
}

{
  const S = loadFresh()
  const d = new S({ mode: 'tilt', sensitivity: 'medium' })
  d.applyRemote({
    tilt: { medium: { enter: 25, exit: 19 } },
    lift: { medium: { enter: 0.15, exit: 0.09 } }
  })
  d.setMode('lift')
  ok('切到 lift 用远端 lift 值', near(d.getConfig().enter, 0.15), d.getConfig().enter)
  d.setMode('tilt')
  ok('切回 tilt 用远端 tilt 值', near(d.getConfig().enter, 25), d.getConfig().enter)
}

{
  const S = loadFresh()
  const d = new S({ mode: 'tilt', sensitivity: 'medium' })
  d.applyRemote({ tilt: { medium: { enter: 26, exit: 20 } } })
  const d2 = new S({ mode: 'tilt', sensitivity: 'medium' })
  ok('同进程内新实例继承覆盖后的阈值', near(d2.getConfig().enter, 26), d2.getConfig().enter)
}

{
  // 隔离验证：新模块的预设必须还是内置值（证明上一个用例没漏到下一个）
  const S = loadFresh()
  const d = new S({ mode: 'lift', sensitivity: 'medium' })
  ok('模块重载后 lift 预设回到内置值', near(d.getConfig().enter, BASE.lift), d.getConfig().enter)
}

{
  // 远程配置绝不能破坏 build-web.js 的跨端约束
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'utils', 'squat-detector.js'), 'utf8')
  ok('算法文件未混入 DOM / 小程序 API', !/require\(|\bwx\.|document\./.test(src))
  ok('module.exports 仍在（build-web 依赖它）', /module\.exports\s*=\s*SquatDetector/.test(src))
}

console.log('\n通过 ' + pass + ' / 失败 ' + fail + '\n')
process.exit(fail ? 1 : 0)