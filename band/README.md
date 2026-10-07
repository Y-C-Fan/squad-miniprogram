# 蹲队 Squad · 小米手环 9 Pro 版

微信小程序的**手环移植版**。计数算法与小程序版、网页版**完全一致**（同一份 `squat-detector.js`），换了 UI 层和传感器接入方式。

## ✅ 已编译完成

```
dist/
├── com.chaowi.squad.debug.1.0.0.rpk     16.4 KB  调试包（推荐先用这个）
└── com.chaowi.squad.release.1.0.0.rpk   12 KB   正式包（已签名，较早版本无远端配置）
```

**不需要装 AIoT IDE**。`aiot-toolkit` 是独立 npm 包，命令行就能编译：

```bash
bash band/build.sh              # → dist/*.debug.rpk（自动装依赖 + 自动同步算法）
bash band/build.sh release      # → dist/*.release.rpk（需先备好 sign/）
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

手环没有开放的应用商店，**只能侧载**。但这不是问题 —— 只自己用的话，侧载装一次就够，后面调参数靠远端配置，不用反复装（见下一节）。

### 1. 手机装 AstroBox

用 AstroBox 最省事：登录小米账号能自动识别已绑定的设备，不用手抄设备密钥。装好小米运动健康并连上手环。

### 2. 推包

- **AstroBox**：连接手环 → 从资源库找应用，或用「本地安装」选 `dist/*.debug.rpk`
- **表盘自定义工具**：需要手动获取设备密钥，麻烦一点

> 装 **debug 包**。release 包是正式签名，调试阶段用不上。
>
> ⚠️ **必须是安卓手机**。iOS 上的小米运动健康没有第三方安装入口。
> ⚠️ 手环**升级固件会清空所有第三方应用**，升完固件要重装一遍。

### 3. 打开

手环上会多出一个叫「**蹲队**」的应用（图标是绿色圆环）。

**戴着手环点开始 → 站着别动 1 秒完成校准 → 开始深蹲。**

---

## 远端调参：改阈值不用重装 rpk

侧载一次要动手机、蓝牙、文件管理器，迭代成本很高。所以阈值改成**从网上拉**：

| | 内容 |
|---|---|
| 配置文件 | [`web/band-config.json`](../web/band-config.json)，随网页版部署在 `/band-config.json` |
| 线上地址 | <https://squat-counter-82622.app.workbuddy.host/band-config.json> |
| 拉取时机 | 应用 `onShow`（每次进入应用拉一次，1.3KB） |
| 拉不到怎么办 | 静默用内置默认值，功能完全不受影响 |

**所以以后调阈值的流程是**：改 JSON → 重新部署 → 手环退出应用再进入。**不用碰手环、不用重装。**

屏幕底部会显示当前生效的 `enter` 值和配置日期，一眼能确认拉到的是哪一版：

```
阈值 0.12 @2026-10-07          ← 已联网，用远端参数
参数：内置（未连手机同步）        ← 没联网，用内置默认值
参数：内置（远端被拒）            ← 拉到但内容非法，已回滚
```

### ⚠️ 手环自己没网，要先同步

手环**没有 Wi-Fi**，网络是靠小米运动健康蓝牙通道借手机的。所以拉配置的前提是：

1. 手机上打开小米运动健康，保持与手环**连接**
2. 在运动健康里点一下**同步**（发一次数据）
3. 再在手环上打开蹲队

没做第 2 步就拉不到配置，会显示「参数：内置」，这不影响计数，只是用内置阈值。

### 配置文件格式

```jsonc
{
  "defaults": { "mode": "lift", "sensitivity": "medium" },  // 手环默认用哪个模式
  "calibStill": 0.5,          // 校准的静止判定阈值
  "tilt": {
    "low":    { "enter": 29.0, "exit": 22.3, "minDownMs": 260, "minGapMs": 1000 },
    "medium": { "enter": 22.8, "exit": 17.6, "minDownMs": 200, "minGapMs": 800 },
    "high":   { "enter": 16.0, "exit": 12.3, "minDownMs": 150, "minGapMs": 550 }
  },
  "lift": { "low": {...}, "medium": { "enter": 0.12, "exit": 0.07 }, "high": {...} }
}
```

字段是**增量覆盖**：只写想改的键，其余保持内置值。

### 安全边界

这份 JSON 是网络输入，所以 `applyRemote` 有三道防线（`tools/test-remote.js` 37 项自检覆盖）：

1. **字段白名单** —— 只认 `enter/exit/minDownMs/maxDownMs/minMotion/minGapMs`，出现别的键直接判定为非法
2. **数值校验** —— 每个值必须是正的有限数（字符串 / `NaN` / 负数 / 0 全拒）
3. **滞回带校验** —— 合并后必须 `exit < enter`，否则说明阈值反了，会不停误触发

任何一条不过 → **整体回滚**到内置默认并继续可用，绝不让一份坏配置把手环搞瘫。

> ⚠️ 改算法默认值（`utils/squat-detector.js`）之后要跑 `node tools/make-band-config.js` 重新生成 JSON，否则两边会不一致。

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
├── build.sh                 一键编译（自动装依赖 + 自动同步算法 + 编译）
├── sign/                    签名证书（.gitignore 掉了，私钥不能进仓库）
├── dist/                    编译产物（.gitignore）
└── src/
    ├── manifest.json          package=com.chaowi.squad，designWidth=168，features 含 system.fetch
    ├── app.ux                 应用入口
    ├── common/
    │   ├── logo.png           192×192 图标
    │   └── squat-detector.js  ★ 与小程序/网页版同一份算法（由 tools/sync-band.js 自动同步，勿手改）
    └── pages/
        └── index/
            └── index.ux       单页：计数 / 开始结束 / 模式切换 / 灵敏度切换 / 远端配置
```

> ⚠️ `src/common/squat-detector.js` 是**自动同步的副本**，不要手改。改算法请改 `utils/squat-detector.js`，`band/build.sh` 编译前会自动同步；也可以手动 `node tools/sync-band.js`。少了这一步，手环会一直跑旧阈值且没人会发现。

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

**理想形态是小程序/网页做统计、手环做采集。** 关于同步：**快应用是可以主动联网的**（`@system.fetch`），本项目的远端配置就是靠它拉通的；社区里已有手环快应用直接调云端大模型 API 的先例。剩下的只是"往回传数据"这一步 —— 把训练记录 POST 回手机端或云端存储完全做得到，但因为只自用、量又小，目前**没有做**，继续在小程序/网页里手工记。

> ⚠️ 更早的版本这里写的是"第三方快应用不支持主动联网"，这是错的，已更正。手环自身没有 Wi-Fi，联网是**借小米运动健康的蓝牙通道走手机网络**，所以前提是手机侧处于连接+同步状态。

## 生态分界线

小米手环 7 及更早的机型是 RTOS，跑不了快应用。Vela 系统的机型（手环 8 Pro / 9 / 9 Pro / 10、Watch S3/S4/S5、红米 Watch 4/5）都支持。

> 例外：红米手环 3 虽有 Vela 系统，但**没搭载快应用引擎**，装不了。

## License

MIT
