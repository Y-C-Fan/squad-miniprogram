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

/**
 * 各灵敏度档位的阈值（单位：度）。
 * 低通会让幅度缩水约 5%，所以阈值要留出余量，不能贴着真实幅度定。
 * 档位语义 = "多大幅度的动作才算一次"：
 *   low    真实 ≥30° 才算，几乎不误计
 *   medium 真实 ≥22° 就算（推荐，常规深蹲）
 *   high   真实 ≥12° 就算，轻微屈膝也会被算进去
 */
var TILT_PRESET = {
  low:    { enter: 26,   exit: 19,   minDownMs: 260, maxDownMs: 4500, minMotion: 0.8, minGapMs: 1000, calibStill: 0.5 },
  medium: { enter: 18,   exit: 12,   minDownMs: 200, maxDownMs: 4500, minMotion: 0.6, minGapMs: 800, calibStill: 0.5 },
  high:   { enter: 11,   exit: 7,    minDownMs: 150, maxDownMs: 4500, minMotion: 0.5, minGapMs: 550, calibStill: 0.5 }
}

/**
 * 垂直位移模式的阈值（单位：米）。
 * 注意这里的 enter/exit 是"绝对位移"而非增量，所以深蹲幅度小于阈值时不会被算出来 ——
 * 这是有意为之：它保证"只晃了一下"不会被误计成一次深蹲。
 */
var LIFT_PRESET = {
  low:    { enter: 0.18, exit: 0.11, minDownMs: 260, maxDownMs: 4500, minMotion: 0.8, minGapMs: 1000, calibStill: 0.5 },
  medium: { enter: 0.12, exit: 0.07, minDownMs: 200, maxDownMs: 4500, minMotion: 0.6, minGapMs: 800, calibStill: 0.5 },
  high:   { enter: 0.08, exit: 0.045, minDownMs: 150, maxDownMs: 4500, minMotion: 0.5, minGapMs: 550, calibStill: 0.5 }
}

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
  this.calibMs = options.calibMs || 700      // 校准窗口最短时长
  this.calibTimeout = options.calibTimeout || 5000  // 一直动就最多等这么久
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
  this.firstTs = 0
  this.lastTs = 0
  this.calibrating = true
  this.calibMotion = 0

  this.state = 'top'        // top | bottom
  this.downSince = 0
  this.motionPeak = 0
  this.lastCountAt = 0
  this.count = 0

  this.tilt = 0
  this.signal = 0
  this.linear = 0
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
    ready: !this.calibrating, progress: 0, motion: this.linear, repMs: 0
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

  // ── 4) 校准：必须"人没在动"才允许锁定基准方向。
  //    如果在下蹲中途锁定，基准会被带着歪掉，之后每一蹲的相对角度都被压扁（实测能砍掉近一半），
  //    所以这里同时要求静止时长达标、且整个校准窗口内线加速度足够小。
  if (this.calibrating) {
    if (!this.firstTs) this.firstTs = ts
    if (this.linear > this.calibMotion) this.calibMotion = this.linear
    var elapsed = ts - this.firstTs
    var settled = this.calibMotion < cfg.calibStill
    if (elapsed >= this.calibMs && (settled || elapsed >= this.calibTimeout)) {
      this.baseline = { x: g.x, y: g.y, z: g.z }
      this.calibrating = false
      out.ready = true
      out.state = 'top'
    }
    return out
  }

  // ── 5) 施密特触发状态机
  if (this.state === 'top') {
    // 只在"站着不动"时让基准极慢地跟随重力，抵消手机在口袋里慢慢滑动造成的零点漂移。
    // 关键是必须同时约束线加速度很小 —— 否则训练过程中基准会被平均掉，信号幅度越蹲越小。
    if (sig < cfg.exit && this.linear < 0.4) {
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
