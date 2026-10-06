# 蹲队 Squad · 小米手环 9 Pro 版

微信小程序版的**手环移植版**。计数算法与小程序版**完全一致**（同一份 `squat-detector.js`），换了 UI 层和传感器接入方式。

## 这不是"迁移"，是重写 UI

| | 微信小程序 | Vela 快应用 |
|---|---|---|
| 页面 | WXML / WXSS / JS | `.ux` 单文件（template + style + script 三段合一） |
| 框架 | 微信运行时 | 类 Vue 的 MVVM 运行时 |
| 传感器 | `wx.startAccelerometer` | `sensor.subscribeAccelerometer` |
| 振动 | `wx.vibrateShort` | `vibrator.vibrate` |
| 存储 | `wx.setStorageSync` | `storage.setSync` |

`utils/squat-detector.js` 里没有任何 `wx` API 或 DOM 引用，所以算法文件可以原样搬过来，不用改一行。

## 关键：手环端采样率是够的

查了小米官方支持矩阵，手环 9 Pro 支持 `subscribeAccelerometer`，且 `interval: 'game'` 约 **20ms/次** —— 和微信小程序 `interval: 'game'` 同一个量级。

所以低通滤波的时间常数、施密特触发的阈值**都能直接沿用**，不需要重新调参。这是这个移植能成立的前提。

> ⚠️ 关于「手环戴在手腕上会不会测不准」：手腕姿态随手臂摆动变化，倾角信号会被污染，所以手环版**默认走 `lift`（垂直位移）模式**，点右上角可以切到 `tilt` 对比。手环没法塞进裤袋，位移信号反而更稳。
>
> 真机上的实际准确率还没验证过 —— 小程序版有 32 项离线仿真兜底，手环版需要你戴着真机实测一遍再调 `TILT_PRESET` / `LIFT_PRESET`。

## 目录

```
band/
├── package.json
└── src/
    ├── manifest.json              设备配置（designWidth=168，手环 9 Pro 屏幕 336×480）
    ├── app.ux                     应用入口
    ├── common/
    │   └── squat-detector.js      ★ 与小程序版同一份算法
    └── pages/
        └── index/
            └── index.ux           单页：计数 / 开始结束 / 模式切换
```

## 环境搭建

手环快应用没有应用商店，**只能侧载**。需要：

1. **AIoT IDE**（VS Code 的小米定制版，含 Vela 编译器和模拟器）
   下载入口见官方文档：<https://iot.mi.com/vela/quickapp/zh/content/guide/start/use-ide.html>
2. Node.js ≥ 14
3. 真机安装：手机开 USB 调试 → ADB 连上 → 用 **AstroBox** 或 **表盘自定义工具** 把 `.rpk` 推到手环

```bash
cd band
npm install
npm run build      # 产出 dist/squad-band.rpk
```

小米手环 9 Pro 支持快应用，但小米手环 7 及更早的机型是 RTOS，跑不了 —— 生态分界线就在小米 Vela 系统。

## 手环端暂未实现

小程序版有、手环版还没有的（按优先级）：

- [ ] HIIT 间歇模式（屏幕太小，输入组数/间歇秒数体验很差，建议改成预设 4 个方案）
- [ ] 数据图表与热力图（168dp 宽的屏幕放不下，应该只留数字）
- [ ] 勋章（要配合小程序端看）
- [ ] 训练历史读取（目前只存了今日累计次数）

**理想形态是小程序做统计、手环做采集**：手环把数据同步回手机，统计全在手机端做。但小米手环 9 Pro 的第三方快应用**不支持主动联网推送数据给外部服务器**，所以同步只能靠「打开小程序时手环端导出、手动录入」或者反过来 —— 这块需要实际试过才知道可行性。

## License

MIT