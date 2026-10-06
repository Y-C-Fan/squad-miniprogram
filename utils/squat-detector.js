/**
 * squat-detector.js —— 深蹲自动计数核心算法
 *
 * 设计约束：
 *  - 纯 JS，不引用任何小程序 API、DOM 或第三方库
 *  - 因此可以直接搬到 Vela 快应用（小米手环）/ H5 / React Native 上复用
 *
 * 输入：含重力的三轴加速度（单位 m/s²，静止时模长≈9.8），采样间隔 5~100ms 均可自适应
 * 输出：{count, counted, tilt, signal, state, ready, progress}
 *
 * ── 为什么不用简单的"波峰计数" ──────────────────────────────
 * 直接对加速度模长做波峰检测，走路、抬手、上下楼梯都会误计，而且站桩式 jitter 会抖出一堆假峰。
 * 这里用两级处理：
 *   1) 低通把原始加速度拆出"重力方向"和"线加速度"两路信号
 *   2) 主信号进施密特触发器（双阈 hysteresis 状态机），只有完整走完
 *      top → bottom → top 且满足时长/运动量双门槛，才算一次有效深蹲
 *
 * ── 两种主信号 ────────────────────────────────────────────
 *  tilt 模式（默认，适合手机放口袋 / 绑腿）：
 *    下蹲时大腿带着手机一起转动 → 重力方向相对设备发生明显偏转。
 *    signal = 当前重力方向 与 校准基准 的夹角（度）。
 *
 *  lift 模式（适合手机拿在手上）：
 *    手持时设备基本不转，只有垂直位移 → 倾角几乎不变，必须改用位移。
 *    把线加速度投影到重力方向，减去慢速漂移偏置后做"泄漏式二次积分"，
 *    再减去自身慢均值去趋势，得到近似垂直位移（米）。
 *    signal = -位移（向下为正）。
 *
 * 两种模式共用同一套状态机，所以切换模式不需要重写逻辑。
 */

'use strict'

var RAD_TO_DEG = 180 / Math.PI
var G = 9.81

var TILT_PRESET = {
  low:    { enter: 26,   exit: 19,   minDownMs: 260, maxDownMs: 4500, minMotion: 0.8, minGapMs: 1000 },
  medium: { enter: 18,   exit: 12,   minDownMs: 200, maxDownMs: 4500, minMotion: 0.6, minGapMs: 800 },
  high:   { enter: 11,   exit: 7,    minDownMs: 150, maxDownMs: 4500, minMotion: 0.5, minGapMs: 550 }
}

/**
 * 垂直位移模式的阈值（单位：米）。
 * 注意这里的 enter/exit 是"绝对位移"而非增量，所以深蹲幅度小于阈值时不会被算出来 ——
 * 这是有意为之：它保证"只晃了一下"不会被误计成一次深蹲。
 */
var LIFT_PRESET = {
  low:    { enter: 0.18, exit: 0.11, minDownMs: 260, maxDownMs: 4500, minMotion: 0.8, minGapMs: 1000 },
  medium: { enter: 0.12, exit: 0.07, minDownMs: 200, maxDownMs: 4500, minMotion: 0.6, minGapMs: 800 },
  high:   { enter: 0.08, exit: 0.045, minDownMs: 150, maxDownMs: 4500, minMotion: 0.5, minGapMs: 550 }
}

/**
 * 校准参数。
 *
 * calibStill 用的是「滑动窗口平均线加速度」而不是单帧值 —— 这是关键。
 * 手环戴在手腕上，站着不动也有生理性微抖（实测线加速度单帧峰值 0.3~0.5，
 * 抖幅 0.35 时单帧超阈概率 15%）。若按单帧判静止，只要有一帧超限就把计时归零，
 * 结果永远是"在校准中"（真机实测现象）。
 * 换成 0.5 秒滑动均值后：抖幅 0.5 误判率 0%，而真实深蹲运动量 2~5 m/s²
 * 远高于阈值，安全余量充足。
 */
var CALIB_MS = 500        // 需要"连续静止"这么久才算校准完成
var CALIB_STILL = 0.5     // 滑动平均线加速度低于此值算静止
var CALIB_WINDOW = 25     // 滑动窗口帧数（25 × 20ms = 0.5 秒）

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

/** 时间常数 τ(秒) → 每步滤波系数 α，使算法对变采样率免疫 */
function alphaFor(dt, tau) { return 1 - Math.exp(-dt / tau) }

function unit(v) {
  var m = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1
  return { x: v.x / m, y: v.y / m, z: v.z / m }
}

function lerpVec(prev, next, a) {
  return {
    x: prev.x + a * (next.x - prev.x),
    y: prev.y + a * (next.y - prev.y),
    z: prev.z + a * (next.z - prev.z)
  }
}

function SquatDetector(options) {
  options = options || {}
  this.setMode(options.mode || 'tilt')
  this.setSensitivity(options.sensitivity || 'medium')
  this.calibMs = options.calibMs || CALIB_MS     // 需要"连续静止"这么久才算校准完成
  this.calibStill = options.calibStill || CALIB_STILL
  this.calibWindow = options.calibWindow || CALIB_WINDOW
  this.reset()
}

SquatDetector.prototype.setMode = function (mode) {
  this.mode = mode === 'lift' ? 'lift' : 'tilt'
  this.presets = this.mode === 'lift' ? LIFT_PRESET : TILT_PRESET
  this.cfg = this.presets[this.level || 'medium']
  if (this.vz !== undefined) this._resetSignalState()
  return this
}

SquatDetector.prototype.setSensitivity = function (level) {
  this.level = (level === 'low' || level === 'medium' || level === 'high') ? level : 'medium'
  this.presets = this.mode === 'lift' ? LIFT_PRESET : TILT_PRESET
  this.cfg = this.presets[this.level]
  return this
}

SquatDetector.prototype.getConfig = function () { return this.cfg }

SquatDetector.prototype.reset = function () {
  this.gravity = null       // 低通后的重力方向（设备坐标系）
  this.baseline = null      // 校准期锁定的基准重力方向
  this.lastTs = 0
  this.calibrating = true
  this.calibSince = 0       // 本段"连续静止"的起始时刻，0 表示当前正在动
  this.calibBuf = []        // 线加速度滑动窗口，用来算平均运动量
  this.motionAvg = 0

  this.state = 'top'        // top | bottom
  this.downSince = 0
  this.motionPeak = 0
  this.lastCountAt = 0
  this.count = 0

  this.tilt = 0
  this.signal = 0
  this.linear = 0
  this.absoluteTilt = 0
  this._resetSignalState()
  return this
}

/** 根据模式算出当前主信号：tilt → 倾角(度)，lift → 向下位移(米) */
SquatDetector.prototype._computeSignal = function (g, lx, ly, lz, dt) {
  if (this.mode === 'tilt') {
    if (!this.baseline) { this.displacement = 0; return 0 }
    var d = clamp(g.x * this.baseline.x + g.y * this.baseline.y + g.z * this.baseline.z, -1, 1)
    this.tilt = Math.acos(d) * RAD_TO_DEG
    this.displacement = 0
    return this.tilt
  }
  var along = lx * g.x + ly * g.y + lz * g.z            // 沿重力方向投影（正 = 向上）
  this.vzBias += alphaFor(dt, 0.6) * (along - this.vzBias)
  var hp = along - this.vzBias
  this.vz = (this.vz + hp * dt) * Math.exp(-dt / 0.9)   // 泄漏积分：速度
  this.sz = (this.sz + this.vz * dt) * Math.exp(-dt / 2.5)
  this.szBias += alphaFor(dt, 3.0) * (this.sz - this.szBias)
  this.displacement = this.sz - this.szBias
  this.tilt = 0
  return -this.displacement                             // 往下蹲为正
}

SquatDetector.prototype._resetSignalState = function () {
  // lift 模式专用的积分器状态
  this.vzBias = 0           // 加速度慢漂移偏置
  this.vz = 0               // 泄漏积分得到的速度
  this.sz = 0               // 泄漏积分得到的位移
  this.szBias = 0           // 位移自身的慢均值（去趋势用）
  this.displacement = 0
}

/**
 * 喂入一次采样。
 * @param {{x:number,y:number,z:number}} a  含重力的加速度
 * @param {number} ts 时间戳（ms）
 * @returns {{count:number,counted:boolean,tilt:number,signal:number,state:string,ready:boolean,progress:number,motion:number}}
 */
SquatDetector.prototype.push = function (a, ts) {
  var firstSample = this.lastTs === 0
  var dt = firstSample ? 0.02 : clamp((ts - this.lastTs) / 1000, 0.004, 0.1)
  this.lastTs = ts

  var out = {
    count: this.count, counted: false, tilt: this.tilt, signal: this.signal,
    state: this.calibrating ? 'calibrating' : this.state,
    ready: !this.calibrating, progress: 0, motion: this.linear, repMs: 0,
    calibProgress: this.calibrating ? 0 : 1
  }

  // ── 1) 低通估计重力方向。
  //    τ=0.10s 是权衡点：实测真实 30/45/60° 的倾斜，低通后仍能保留 95%/94%/95% 的幅度；
  //    τ 放到 0.16s 就只剩 87%，放到 0.05s 又压不住噪。
  var raw = unit(a)
  if (!this.gravity) this.gravity = raw
  else this.gravity = unit(lerpVec(this.gravity, raw, alphaFor(dt, 0.10)))
  var g = this.gravity

  // ── 2) 线加速度 = 原始 - 重力（用于"是否在真的发力"的门槛判断）
  var lx = a.x - g.x * G
  var ly = a.y - g.y * G
  var lz = a.z - g.z * G
  this.linear = Math.sqrt(lx * lx + ly * ly + lz * lz)
  out.motion = this.linear

  // ── 3) 主信号（校准期也照算，让 lift 模式的积分器先预热起来，
  //       否则第一次深蹲会因为积分器冷启动而被判成异常波形丢掉）
  var sig = this._computeSignal(g, lx, ly, lz, dt)
  out.signal = sig
  out.tilt = this.tilt

  var cfg = this.cfg

  // 绝对倾角 = 当前重力方向与"世界竖直方向（+z）"的夹角。
  // 用于判断"人到底是站直了还是在蹲着"，是零点漂移补偿的安全前提：
  // 只有人真的站直（绝对倾角也小）时，才允许基准跟着重力慢慢走。
  this.absoluteTilt = Math.acos(clamp(g.z, -1, 1)) * RAD_TO_DEG

  // ── 4) 校准：要求"连续静止"达标才锁定基准方向。
  //
  //    为什么必须这么设计（真机踩过的坑）：
  //    · 如果在下蹲中途锁定基准，基准会被带着歪，之后每一蹲的相对角度被压扁，
  //      实测 45° 的动作只能测到 24°，准确率直接砍半。
  //    · 所以不能"到点就锁"，必须"人真的没在动"才锁。
  //
  //    三个历史 bug 叠在一起造成的"一直显示校准中"：
  //    1) 早期用"整个校准期线加速度峰值"（只增不减）判静止 —— 手腕微抖让峰值永远超阈值
  //    2) 靠 5 秒超时兜底解锁，但解锁时锁定的已经是蹲姿，等于第二个 bug
  //    3) 改单帧判静止后仍然错：单帧超阈概率 15%，归零重来依然没完
  //    最终方案：滑动窗口平均 + 500ms 连续静止。抖幅 0.5 实测 0% 误判。
  if (this.calibrating) {
    // 维护 0.5 秒滑动窗口
    this.calibBuf.push(this.linear)
    if (this.calibBuf.length > this.calibWindow) this.calibBuf.shift()

    var sum = 0
    for (var i = 0; i < this.calibBuf.length; i++) sum += this.calibBuf[i]
    var avg = this.calibBuf.length ? sum / this.calibBuf.length : 0
    this.motionAvg = avg

    // 窗口还没攒满就先不动，避免一开始用一两个样本误判
    var windowFull = this.calibBuf.length >= this.calibWindow

    if (windowFull && avg > this.calibStill) {
      this.calibSince = 0            // 在动 → 静止计时清零
    } else if (windowFull && !this.calibSince) {
      this.calibSince = ts
    }

    if (this.calibSince && ts - this.calibSince >= this.calibMs) {
      this.baseline = { x: g.x, y: g.y, z: g.z }
      this.calibrating = false
      out.ready = true
      out.state = 'top'
      out.calibProgress = 1
    } else {
      // 把进度回传给上层，UI 才能画校准进度条 / 显示剩余时间
      out.calibProgress = this.calibSince ? Math.min(1, (ts - this.calibSince) / this.calibMs) : 0
    }
    return out
  }

  // ── 5) 施密特触发状态机
  if (this.state === 'top') {
    // 零点漂移补偿：抵消手机在口袋里慢慢滑动造成的基准偏移。
    //
    // 三个必要约束，缺一不可（第二个是真机/Linux 仿真各暴露一次 bug）：
    //  1) 相对基准的倾角要小   —— 否则正在深蹲时会被当成漂移
    //  2) 相对重力方向的倾角也要小 —— ★ 这是关键。
    //     只看条件 1 时，基准会一路跟着重力跑到"深蹲底部"，把整个幅度吸收掉；
    //     下次倾角回落时相对基准瞬间变 0 → 立刻触发退出 → 同一个深蹲被数两次。
    //     实测干净波形 3 蹲数出 5 个，根因就是这里。
    //  3) 线加速度要小           —— 传感器在抖的时候不该更新基准
    if (sig < cfg.exit && this.linear < 0.4 && this.absoluteTilt < cfg.exit) {
      this.baseline = unit(lerpVec(this.baseline, g, alphaFor(dt, 15)))
    }

    if (sig >= cfg.enter) {
      this.state = 'bottom'
      this.downSince = ts
      this.motionPeak = 0
    }
  } else {
    if (this.linear > this.motionPeak) this.motionPeak = this.linear

    if (ts - this.downSince > cfg.maxDownMs) {
      // 蹲下去迟迟不起来（比如坐下/捡东西）→ 作废，不计数
      this.state = 'top'
    } else if (sig <= cfg.exit) {
      var dur = ts - this.downSince
      var farEnough = ts - this.lastCountAt >= cfg.minGapMs
      if (dur >= cfg.minDownMs && this.motionPeak >= cfg.minMotion && farEnough) {
        this.count += 1
        this.lastCountAt = ts
        out.counted = true
        out.repMs = dur
      }
      this.state = 'top'
    }
  }

  out.count = this.count
  out.state = this.state
  out.progress = clamp(sig / cfg.enter, 0, 1)
  return out
}

/** 供调试面板使用 */
SquatDetector.prototype.debug = function () {
  return {
    mode: this.mode,
    level: this.level,
    tilt: this.tilt,
    signal: this.signal,
    displacement: this.displacement,
    motion: this.linear,
    state: this.state,
    count: this.count
  }
}

module.exports = SquatDetector
