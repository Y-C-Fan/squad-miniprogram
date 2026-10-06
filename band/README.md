# 蹲队 Squad · 小米手环 9 Pro 版

微信小程序的**手环移植版**。计数算法与小程序版、网页版**完全一致**（同一份 `squat-detector.js`），换了 UI 层和传感器接入方式。

## ✅ 已编译完成

```
dist/
├── com.chaowi.squad.debug.1.0.0.rpk     14 KB  调试包（推荐先用这个）
└── com.chaowi.squad.release.1.0.0.rpk   12 KB  正式包（已签名）
```

**不需要装 AIoT IDE**。`aiot-toolkit` 是独立 npm 包，命令行就能编译：

```bash
cd band
npm install --legacy-peer-deps
npm run dev        # → dist/*.debug.rpk
npm run release    # → dist/*.release.rpk（需先备好 sign/）
```

> `--legacy-peer-deps` 必须加。`aiot-toolkit@2.0.5` 的依赖树里 `@aiot-toolkit/commander` 嵌套了一整套 `@inquirer/*`，版本号和顶层冲突，不加这个参数会装出一棵解析不了的树，报
> `Cannot find module .../@inquirer/prompts/dist/cjs/index.js`。

生成签名证书：

```bash
mkdir -p sign
openssl req -newkey rsa:2048 -nodes -keyout sign/private.pem -x509 -days 3650 \
  -out sign/certificate.pem -subj "/C=CN/O=chaowi/CN=squad-band"
```

---

## 装到手环上（三步）

手环没有应用商店，**只能侧载**。

### 1. 手机装 AstroBox

用 AstroBox 最省事：登录小米账号能自动识别已绑定的设备，不用手抄设备密钥。装好小米运动健康并连上手环。

### 2. 推包

- **AstroBox**：连接手环 → 从资源库找应用，或用「本地安装」选 `dist/*.debug.rpk`
- **表盘自定义工具**：需要手动获取设备密钥，麻烦一点

> 装 **debug 包**。release 包是正式签名，调试阶段用不上。

### 3. 打开

手环上会多出一个叫「**蹲队**」的应用（图标是绿色圆环）。

**戴着手环点开始 → 站着别动 1 秒完成校准 → 开始深蹲。**

---

## 关键：手环端采样率是够的

查了小米官方支持矩阵，手环 9 Pro 支持 `sensor.subscribeAccelerometer`，且 `interval: 'game'` 约 **20ms/次** —— 和微信小程序同一个量级。

所以低通滤波的时间常数、施密特触发的阈值**都能直接沿用**，`squat-detector.js` 一个字没改。

> ⚠️ **手腕姿态会被手臂摆动污染**，所以手环版**默认走 `lift`（垂直位移）模式**。手环没法塞进裤袋，位移信号反而更稳。点右上角可以切到 `tilt` 对比。
>
> **真机准确率还没验证过** —— 阈值全部来自合成数据仿真。小程序版有 32 项离线仿真兜底，手环版没有（Vela 环境跑不了那套 Node 脚本）。第一次用请两种模式各蹲 20 个对比，哪个准用哪个。

---

## 目录

```
band/
├── package.json
├── sign/                      签名证书（.gitignore 掉了，私钥不能进仓库）
├── dist/                      编译产物（.gitignore）
└── src/
    ├── manifest.json          package=com.chaowi.squad，designWidth=168
    ├── app.ux                 应用入口
    ├── common/
    │   ├── logo.png           192×192 图标
    │   └── squat-detector.js  ★ 与小程序/网页版同一份算法
    └── pages/
        └── index/
            └── index.ux       单页：计数 / 开始结束 / 模式切换
```

## 这不是"迁移"，是重写 UI

| | 微信小程序 | Vela 快应用 |
|---|---|---|
| 页面 | WXML / WXSS / JS | `.ux` 单文件（template + style + script 三段合一） |
| 框架 | 微信运行时 | 类 Vue 的 MVVM 运行时 |
| 传感器 | `wx.startAccelerometer` | `sensor.subscribeAccelerometer` |
| 振动 | `wx.vibrateShort` | `vibrator.vibrate` |
| 存储 | `wx.setStorageSync` | `storage.set` |

`utils/squat-detector.js` 里没有任何 `wx` API 或 DOM 引用，所以算法文件可以原样搬过来。

### 两条必须知道的 Vela 约束

**① `designWidth` 用 168**

手环 9 Pro 屏幕 336×480 像素，dp 宽 = 168。manifest 里写 `designWidth: 168` 之后，写样式直接用 dp，不用换算。

**② onHide 后 30 秒会被强制冻结**

Vela Runtime 的机制：`onHide` 后 30 秒内若没有活动定时器或传感器，应用会被冻结（内存压到 <10KB），JS 暂停执行。所以：

- `onHide` 里**必须**停传感器 + 停定时器
- 训练中被切走会**自动保存**当前进度，不会静默丢数据
- `onDestroy` 里也要再清理一遍

## 手环端暂未实现

- **HIIT 间歇模式** —— 168dp 宽的屏幕输入组数和间歇秒数体验极差。要做的话建议改成 4 个预设方案一键切换
- **数据图表 / 热力图 / 勋章** —— 小屏放不下，应该只留数字，统计全放手机端
- **训练历史** —— 目前只存今日累计次数（跨天自动归零）

**理想形态是小程序/网页做统计、手环做采集。** 但有个硬限制：**第三方快应用不支持主动联网推数据给外部服务器**，所以同步只能靠「手环导出 → 手机录入」这类半自动方案。这块需要真机试过才知道可行性。

## 生态分界线

小米手环 7 及更早的机型是 RTOS，跑不了快应用。Vela 系统的机型（手环 8 Pro / 9 / 9 Pro / 10、Watch S3/S4/S5、红米 Watch 4/5）都支持。

> 例外：红米手环 3 虽有 Vela 系统，但**没搭载快应用引擎**，装不了。

## License

MIT
