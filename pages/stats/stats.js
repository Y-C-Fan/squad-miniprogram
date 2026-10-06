/**
 * 数据页
 * 汇总统计 / 近 7 天柱状图 / 12 周热力图 / 勋章墙 / 训练记录
 */

'use strict'

var store = require('../../utils/storage.js')
var fit = require('../../utils/fitness.js')
var fmt = require('../../utils/format.js')

var MODE_LABEL = { free: '自由', target: '目标', hiit: 'HIIT' }

Page({
  data: {
    empty: true,
    sum: { totalCount: 0, sessions: 0, totalMs: 0, totalCalories: 0, bestSingle: 0, avgCount: 0, streak: 0, bestStreak: 0 },
    sumDurationText: '0分',
    week: [],
    weekMax: 1,
    heat: { cells: [], max: 0 },
    badges: [],
    unlockedCount: 0,
    recent: []
  },

  onShow: function () {
    this.load()
  },

  load: function () {
    var sessions = store.getSessions()
    var sum = fit.summary(sessions)

    // 近 7 天
    var week = fit.weeklySeries(sessions)
    var weekMax = 1
    for (var i = 0; i < week.length; i++) if (week[i].count > weekMax) weekMax = week[i].count
    for (var j = 0; j < week.length; j++) {
      week[j].height = week[j].count > 0 ? Math.max(8, Math.round(week[j].count / weekMax * 180)) : 4
    }

    // 热力图
    var heat = fit.heatmapSeries(sessions, 12)

    // 勋章
    var badges = fit.evaluateBadges(sessions)
    var unlockedCount = 0
    for (var k = 0; k < badges.length; k++) {
      if (badges[k].unlocked) unlockedCount += 1
    }

    // 最近记录
    var recent = sessions.slice(0, 12).map(function (s) {
      return {
        id: s.id,
        dayLabel: fmt.dayLabel(fmt.dayKey(s.start)),
        clock: fmt.clockText(s.start),
        count: s.count,
        mode: MODE_LABEL[s.mode] || s.mode,
        durationText: fmt.durationText(s.durationMs || 0),
        calories: s.calories
      }
    })

    this.setData({
      empty: sessions.length === 0,
      sum: sum,
      sumDurationText: fmt.durationText(sum.totalMs),
      week: week,
      weekMax: weekMax,
      heat: heat,
      badges: badges,
      unlockedCount: unlockedCount,
      recent: recent
    })
  },

  onRemove: function (e) {
    var id = e.currentTarget.dataset.id
    var self = this
    wx.showModal({
      title: '删除这条记录？',
      content: '删除后无法恢复',
      confirmColor: '#ff7a5c',
      success: function (res) {
        if (!res.confirm) return
        store.removeSession(id)
        self.load()
      }
    })
  },

  goTrain: function () {
    wx.switchTab({ url: '/pages/index/index' })
  }
})
