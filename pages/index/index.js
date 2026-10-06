/**
 * 训练页
 *
 * 页面职责：
 *   1. 配置模式（自由 / 目标 / HIIT）
 *   2. 驱动加速度计 + 探测器计数
 *   3. 每完成一次 → 震动 + 数字弹跳；每 N 次 → Toast 报数
 *   4. 结束时落地一条本地训练记录
 *
 * 已知平台限制（已做兜底，但必须让用户知道）：
 *   小程序切到后台 / 锁屏后，加速度计回调会停。
 *   所以训练过程中离开页面会自动暂停，不会静默丢秩序数。
 */

'use strict'

var SquatDetector = require('../../utils/squat-detector.js')
var store = require('../../utils/storage.js')
var fit = require('../../utils/fitness.js')
var audio = require('../../utils/audio.js')
var fmt = require('../../utils/format.js')

var SENSITIVITY_KEYS = ['low', 'medium', 'high']
var SENSITIVITY_ACTIONS = ['低（幅度要够大）', '中（推荐）', '高（易误计）']
var SENSITIVITY_LABEL = { low: '低', medium: '中', high: '高' }
var DETECT_KEYS = ['tilt', 'lift']
var DETECT_ACTIONS = ['口袋 / 绑腿（倾角检测）', '手持（垂直位移检测）']
var DETECT_LABEL = { tilt: '口袋', lift: '手持' }

function toNum(v, def, lo, hi) {
  var n = parseInt(v, 10)
  if (isNaN(n)) n = def
  if (lo !== undefined && n < lo) n = lo
  if (hi !== undefined && n > hi) n = hi
  return n
}

Page({
  data: {
    // 训练模式
    modes: [
      { key: 'free', label: '自由' },
      { key: 'target', label: '目标' },
      { key: 'hiit', label: 'HIIT' }
    ],
    mode: 'free',

    // 目标 / HIIT 参数（输入框直接绑到这里）
    target: 50,
    sets: 4,
    repsPerSet: 15,
    restSec: 30,

    // 运行状态
    running: false,
    paused: false,
    resting: false,
    phase: 'idle',              // idle | calibrating | training | rest
    calibPct: 0,               // 校准进度 0~100
    count: 0,
    seconds: 0,
    timeText: '00:00',
    calories: 0,

    tip: '把手机放口袋里或拿在手上，点开始',
    planText: '',
    restLeft: 0,
    curSet: 0,
    anim: {},

    // 配置项展示
    sensitivityLabel: '中',
    detectLabel: '口袋',
    streak: 0,
    debugText: '',
    canStart: true
  },

  onLoad: function () {
    this.settings = store.getSettings()
    this.syncSettingsUI()
    this.refreshStreak()
    this.detector = null
    this._accHandler = null
    this._timer = null
    this.lastRing = -1
    this.lastDebugAt = 0
  },

  onReady: function () {
    this.initRing()
  },

  onShow: function () {
    // 从设置页回来时同步配置
    var fresh = store.getSettings()
    this.settings = fresh
    this.syncSettingsUI()
    this.refreshStreak()
    if (!this.ctx) this.initRing()
  },

  onHide: function () {
    // 系统层面：小程序退到后台后传感器回调会停，这里主动暂停并告知用户
    if (this.data.running && !this.data.paused) {
      this.pause(true)
    }
  },

  onUnload: function () {
    if (this.data.running && this.data.count > 0) this.saveSession(true)
    this.stopTimer()
    this.stopSensor()
    if (this._drawTimer) clearTimeout(this._drawTimer)
    try { wx.setKeepScreenOn({ keepScreenOn: false }) } catch (e) {}
  },

  /* ────────────────── 分享（工具类小程序唯一的自然增长入口） ────────────────── */

  onShareAppMessage: function () {
    var s = fit.summary(store.getSessions())
    var title
    if (s.totalCount > 0) {
      title = '我蹲了 ' + s.totalCount + ' 个深蹲，来比比谁多'
    } else {
      title = '深蹲还在手动数？这个小程序帮你自动数'
    }
    return {
      title: title,
      path: '/pages/index/index?from=share',
      imageUrl: '/assets/share.png'
    }
  },

  onShareTimeline: function () {
    var s = fit.summary(store.getSessions())
    return {
      title: s.streak > 0
        ? '连续深蹲 ' + s.streak + ' 天，累计 ' + s.totalCount + ' 个'
        : '深蹲自动计数，扔口袋里就能用',
      query: 'from=timeline',
      imageUrl: '/assets/share.png'
    }
  },

  /* ────────────────── 配置 ────────────────── */

  syncSettingsUI: function () {
    this.setData({
      sensitivityLabel: SENSITIVITY_LABEL[this.settings.sensitivity] || '中',
      detectLabel: DETECT_LABEL[this.settings.detectMode] || '口袋',
      debugText: this.settings.debug ? '开启' : ''
    })
  },

  refreshStreak: function () {
    var s = fit.summary(store.getSessions())
    this.setData({ streak: s.streak })
  },

  onModeChange: function (e) {
    if (this.data.running) return
    var key = e.currentTarget.dataset.key
    this.setData({ mode: key })
    this.updatePlanText()
  },

  onInput: function (e) {
    var patch = {}
    patch[e.currentTarget.dataset.key] = e.detail.value
    this.setData(patch)
    this.updatePlanText()
  },

  blurTarget: function () { this.setData({ target: toNum(this.data.target, 50, 1, 9999) }) },
  blurSets: function () { this.setData({ sets: toNum(this.data.sets, 4, 1, 50) }) },
  blurReps: function () { this.setData({ repsPerSet: toNum(this.data.repsPerSet, 15, 1, 500) }) },
  blurRest: function () { this.setData({ restSec: toNum(this.data.restSec, 30, 0, 600) }) },

  updatePlanText: function () {
    var d = this.data
    if (d.mode === 'target') this.setData({ planText: '目标 ' + toNum(d.target, 50, 1, 9999) + ' 次' })
    else if (d.mode === 'hiit') {
      this.setData({
        planText: toNum(d.sets, 4, 1, 50) + ' 组 × ' + toNum(d.repsPerSet, 15, 1, 500) +
          ' 次，组间歇 ' + toNum(d.restSec, 30, 0, 600) + ' 秒'
      })
    } else this.setData({ planText: '不设上限，随时结束' })
  },

  pickSensitivity: function () {
    var self = this
    wx.showActionSheet({
      itemList: SENSITIVITY_ACTIONS,
      success: function (res) {
        self.settings.sensitivity = SENSITIVITY_KEYS[res.tapIndex]
        store.saveSettings(self.settings)
        self.syncSettingsUI()
        if (self.detector) self.detector.setSensitivity(self.settings.sensitivity)
      },
      fail: function () {}
    })
  },

  pickDetectMode: function () {
    var self = this
    wx.showActionSheet({
      itemList: DETECT_ACTIONS,
      success: function (res) {
        self.settings.detectMode = DETECT_KEYS[res.tapIndex]
        store.saveSettings(self.settings)
        self.syncSettingsUI()
      },
      fail: function () {}
    })
  },

  /* ────────────────── 训练控制 ────────────────── */

  onStart: function () {
    // 首次使用先教一遍怎么放 —— 深蹲计数最大的失败原因是用户把手机拿在手里却选了"口袋"模式，
    // 或者点了开始就急着蹲，来不及完成校准。
    if (!store.getSettings().onboarded) {
      this.showOnboarding()
      return
    }
    this.beginTraining()
  },

  showOnboarding: function () {
    var self = this
    wx.showModal({
      title: '三步开始',
      content: '1. 手机放裤袋或绑腿上 → 选「口袋」\n2. 站着别动 1 秒完成校准\n3. 开始深蹲，次数自动跳',
      confirmText: '知道了',
      cancelText: '看设置',
      success: function (res) {
        var s = store.getSettings()
        s.onboarded = true
        store.saveSettings(s)
        if (res.cancel) { self.goSettings(); return }
        self.beginTraining()
      }
    })
  },

  beginTraining: function () {
    var d = this.data
    // 参数落地
    this.setData({
      target: toNum(d.target, 50, 1, 9999),
      sets: toNum(d.sets, 4, 1, 50),
      repsPerSet: toNum(d.repsPerSet, 15, 1, 500),
      restSec: toNum(d.restSec, 30, 0, 600)
    })
    this.updatePlanText()

    this.detector = new SquatDetector({
      mode: this.settings.detectMode,
      sensitivity: this.settings.sensitivity
    })
    this.startedAt = Date.now()
    this.lastRing = -1

    this.setData({
      running: true, paused: false, resting: false,
      phase: 'calibrating', calibPct: 0,
      count: 0, seconds: 0, timeText: '00:00', calories: 0,
      restLeft: 0, curSet: 0,
      tip: '校准中，请站立不动…'
    })
    this.ringValue = 0; this.scheduleDraw()

    audio.setEnabled(!!this.settings.voice)
    try { wx.setKeepScreenOn({ keepScreenOn: true }) } catch (e) {}
    audio.tick('heavy')
    this.startSensor()
    this.startTimer()
  },

  pause: function (silent) {
    if (!this.data.running) return
    this.setData({ paused: true, tip: silent ? '已暂停（退到后台会自动暂停）' : '已暂停' })
    this.stopSensor()
  },

  resume: function () {
    if (!this.data.running) return
    this.setData({ paused: false, tip: this.data.resting ? '组间休息' : '开始深蹲' })
    this.startSensor()
  },

  // 手动结束（wxml bindtap 会把 event 当第一个参数进来，所以单独包一层）
  onFinishTap: function () { this.finish(false) },

  finish: function (auto) {
    var saved = this.saveSession(false)
    this.stopTimer()
    this.stopSensor()
    try { wx.setKeepScreenOn({ keepScreenOn: false }) } catch (e) {}

    this.setData({
      running: false, paused: false, resting: false, phase: 'idle',
      count: 0, seconds: 0, timeText: '00:00', calories: 0,
      restLeft: 0, curSet: 0,
      tip: '把手机放口袋里或拿在手上，点开始'
    })
    this.ringValue = 0; this.scheduleDraw()
    this.refreshStreak()

    if (!saved) return
    audio.celebrate({ vibrateLong: this.settings.vibration })
    var self = this
    wx.showModal({
      title: auto ? '目标达成！' : '训练完成',
      content: saved.count + ' 次 · ' + fmt.durationText(saved.durationMs) + ' · ' + saved.calories + ' 千卡',
      confirmText: '看数据',
      cancelText: '完成',
      success: function (res) {
        if (res.confirm) wx.switchTab({ url: '/pages/stats/stats' })
      }
    })
  },

  saveSession: function (silent) {
    if (!this.data.count || this.data.count <= 0) return null
    var d = this.data
    var seconds = d.seconds
    var cal = Math.max(d.calories, fit.caloriesFloor(d.count, this.settings.weight))
    var session = {
      id: 'sq_' + Date.now(),
      start: this.startedAt || Date.now(),
      end: Date.now(),
      mode: d.mode,
      count: d.count,
      durationMs: seconds * 1000,
      calories: Math.round(cal * 10) / 10,
      plan: {
        target: d.mode === 'target' ? d.target : 0,
        sets: d.mode === 'hiit' ? d.sets : 0,
        repsPerSet: d.mode === 'hiit' ? d.repsPerSet : 0,
        restSec: d.mode === 'hiit' ? d.restSec : 0
      },
      detectMode: this.settings.detectMode,
      sensitivity: this.settings.sensitivity
    }
    store.addSession(session)
    if (silent) wx.showToast({ title: '已保存本次训练', icon: 'none' })
    return session
  },

  /* ────────────────── 传感器 ────────────────── */

  startSensor: function () {
    var self = this
    this.stopSensor()

    // 加速度计是微信认定的敏感接口。
    // 关键：用户一旦拒绝授权，微信不允许二次弹窗申请（"首次询问 + 拒绝后不可再申请"），
    // 所以必须走自定义引导 → 跳设置页，不能直接裸调 API。
    wx.getPrivacySetting({
      success: function (res) {
        if (res.needAuthorization) {
          wx.requirePrivacyAuthorize({
            success: function () { self.subscribeAcc() },
            fail: function () { self.showSensorAuthGuide() }
          })
        } else {
          self.subscribeAcc()
        }
      },
      fail: function () { self.subscribeAcc() }
    })
  },

  /** 授权被拒 / 被拒过：引导去设置页手动开启，别让用户对着没反应的界面发呆 */
  showSensorAuthGuide: function () {
    var self = this
    wx.showModal({
      title: '需要传感器权限',
      content: '深蹲计数靠手机加速度计识别动作，需要授权才能使用。可在「设置 → 我的 → 授权管理」中开启。',
      confirmText: '去设置',
      cancelText: '知道了',
      success: function (res) {
        if (res.confirm) {
          wx.openSetting({
            success: function (setting) {
              if (setting.authSetting && setting.authSetting['scope.userSensors']) {
                self.subscribeAcc()
              }
            }
          })
        } else {
          self.pause()
        }
      }
    })
  },

  subscribeAcc: function () {
    var self = this
    try {
      wx.startAccelerometer({ interval: 'game' })
    } catch (e) {
      this.pause()
      return
    }
    this._accHandler = function (res) { self.onAcc(res) }
    wx.onAccelerometerChange(this._accHandler)
  },

  stopSensor: function () {
    try { wx.stopAccelerometer() } catch (e) {}
    if (this._accHandler && wx.offAccelerometerChange) {
      try { wx.offAccelerometerChange(this._accHandler) } catch (e) {}
    }
    this._accHandler = null
  },

  onAcc: function (res) {
    if (!this.data.running || this.data.paused || this.data.resting) return
    if (!this.detector) return

    var now = Date.now()
    var r = this.detector.push({ x: res.x, y: res.y, z: res.z }, now)

    if (r.ready) {
      if (this.data.phase === 'calibrating') {
        this.setData({ phase: 'training', tip: '开始深蹲' })
      }
    } else if (this.data.phase === 'calibrating') {
      // 把校准进度和当前运动量显式画出来。
      // 否则用户只会看到一句"校准中"然后一直等，完全不知道为什么不动。
      var pct = Math.round(r.calibProgress * 100)
      if (pct !== this.data.calibPct) this.setData({ calibPct: pct })
    }
    if (r.counted) this.onRep()

    if (r.ready) {
      // 性能要点：ring 只喂给 canvas，不参与 wxml 渲染，所以绝对不能 setData。
      // 加速度计 interval:'game' 是 20ms/次 ≈ 50Hz，每次都 setData 会直接把
      // JS→Native 桥打满，表现为界面掉帧。这里既不 setData，也把 canvas 重绘节流到 30fps。
      var p = this.ringProgress(r.progress)
      if (Math.abs(p - this.lastRing) > 0.02) {
        this.lastRing = p
        this.ringValue = p
        this.scheduleDraw()
      }
    }

    if (this.settings.debug && now - this.lastDebugAt > 300) {
      this.lastDebugAt = now
      this.setData({
        debugText: '倾角 ' + Math.round(r.tilt) + '° · 运动量 ' +
          r.motion.toFixed(1) + ' · ' + r.state
      })
    }
  },

  /** 圆环含义：目标/HIIT 展示进度；自由模式展示"这一蹲的深度" */
  ringProgress: function (live) {
    var d = this.data
    if (d.mode === 'target') return Math.min(d.count / Math.max(1, d.target), 1)
    if (d.mode === 'hiit') return (d.count % Math.max(1, d.repsPerSet)) / Math.max(1, d.repsPerSet)
    return live
  },

  onRep: function () {
    if (!this.detector) return
    var count = this.detector.count
    this.setData({ count: count })
    this.bump()

    if (this.settings.vibration) audio.tick('medium')

    var every = Math.max(1, toNum(this.settings.voiceEvery, 10, 1, 100))
    if (count > 0 && count % every === 0) {
      audio.announce(count)
      wx.showToast({ title: count + ' 次', icon: 'none', duration: 900 })
    }

    var d = this.data
    if (d.mode === 'target' && count >= d.target) {
      this.finish(true)
      return
    }
    if (d.mode === 'hiit' && (count % Math.max(1, d.repsPerSet)) === 0) {
      this.setData({ curSet: count / Math.max(1, d.repsPerSet) })
      var totalReps = d.sets * d.repsPerSet
      if (count >= totalReps) this.finish(true)
      else this.startRest()
    }
  },

  startRest: function () {
    this.setData({
      resting: true,
      phase: 'rest',
      restLeft: Math.max(1, this.data.restSec),
      tip: '组间休息，第 ' + (this.data.curSet + 1) + ' 组马上开始'
    })
    audio.tick('heavy')
  },

  endRest: function () {
    this.setData({ resting: false, restLeft: 0, phase: 'training', tip: '继续！' })
    audio.tick('heavy')
  },

  /* ────────────────── 计时 ────────────────── */

  startTimer: function () {
    this.stopTimer()
    var self = this
    this._timer = setInterval(function () { self.onTick() }, 1000)
  },

  stopTimer: function () {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  },

  onTick: function () {
    if (this.data.resting) {
      var left = this.data.restLeft - 1
      if (left <= 0) this.endRest()
      else {
        this.setData({ restLeft: left })
        if (this.settings.vibration && left <= 3) audio.countdownTick(left)
      }
      return
    }
    if (!this.data.running || this.data.paused) return
    var seconds = this.data.seconds + 1
    this.setData({
      seconds: seconds,
      timeText: fmt.duration(seconds),
      calories: fit.calories({ seconds: seconds, weight: this.settings.weight })
    })
  },

  /* ────────────────── 视图小组件 ────────────────── */

  bump: function () {
    var anim = wx.createAnimation({ duration: 100, timingFunction: 'ease-out' })
    anim.scale(1.24).step()
    anim.scale(1).step({ duration: 180, timingFunction: 'ease-out' })
    this.setData({ anim: anim.export() })
  },

  initRing: function () {
    var self = this
    if (!wx.createSelectorQuery) return
    wx.createSelectorQuery()
      .select('#ring')
      .fields({ node: true, size: true })
      .exec(function (res) {
        if (!res || !res[0] || !res[0].node) return
        var canvas = res[0].node
        var ctx = canvas.getContext('2d')
        var dpr = 2
        try { dpr = wx.getSystemInfoSync().pixelRatio || 2 } catch (e) {}
        canvas.width = res[0].width * dpr
        canvas.height = res[0].height * dpr
        ctx.scale(dpr, dpr)
        self.canvasSize = res[0].width
        self.ctx = ctx
        self.ringValue = self.ringValue || 0
        self.drawRing(self.ringValue)
      })
  },

  /**
   * canvas 重绘节流。
   * 50Hz 的传感器回调不能直接画 canvas —— canvas 绘制同样在 UI 线程，
   * 每 20ms 画一次会让低端机掉帧。这里攒到 33ms（30fps）再画一次，
   * 人眼完全看不出差别，但绘制压力降了 40%。
   */
  scheduleDraw: function () {
    if (this._drawPending) return
    this._drawPending = true
    var self = this
    this._drawTimer = setTimeout(function () {
      self._drawPending = false
      self.drawRing(self.ringValue || 0)
    }, 33)
  },

  drawRing: function (p) {
    if (!this.ctx || !this.canvasSize) return
    var ctx = this.ctx
    var size = this.canvasSize
    var cx = size / 2
    var cy = size / 2
    var lw = 14
    var r = size / 2 - lw
    ctx.clearRect(0, 0, size, size)

    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()

    p = Math.max(0, Math.min(1, p || 0))
    if (p <= 0.001) return

    var grad = ctx.createLinearGradient(0, 0, size, size)
    grad.addColorStop(0, '#d9ff5c')
    grad.addColorStop(1, '#86d920')
    ctx.strokeStyle = this.data.resting ? '#ff6b35' : grad
    ctx.beginPath()
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p)
    ctx.stroke()
  },

  goSettings: function () {
    wx.switchTab({ url: '/pages/settings/settings' })
  }
})
