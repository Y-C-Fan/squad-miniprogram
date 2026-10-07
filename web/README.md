# 网页版 / PWA（H5）

微信小程序的**同算法网页版**，同时是一个 PWA：**免安装、可装到桌面、可离线使用**。页面本身单文件 33.7KB，零依赖，零构建。

**为什么会有这个版本**：微信小程序的发布链路必须账号主体本人完成（实名认证 + 管理员扫码），AI 代劳不了。手环上官方市场又要软著 + APP 备案。而「手机浏览器打开就能用」这条路不需要任何注册和审核，可以立刻验证算法在真人身上准不准 —— 也最适合分享给别人。

**线上地址**：<https://squat-counter-82622.app.workbuddy.host/>

---

## PWA：装到桌面 + 离线可用

| 文件 | 作用 |
|---|---|
| `manifest.webmanifest` | 应用名 / 图标 / 独立窗口显示模式 |
| `sw.js` | Service Worker，预缓存页面，断网也能打开 |
| `icon-*.png` | 由 `python tools/make-icons.py` 生成（纯标准库，不依赖 Pillow） |

**安装方式**

- **安卓 Chrome**：页面底部会出现「装到桌面」按钮（接管 `beforeinstallprompt`），点一下即完成
- **iPhone Safari**：没有 `beforeinstallprompt`，需手动「分享 → 添加到主屏幕」
- 装完后是全屏独立窗口，没有地址栏，观感和原生 App 基本一致；传感器、震动、localStorage 全部照常

**离线策略**（`sw.js`）

- 页面导航：**网络优先** → 在线时永远拿到最新版，离线时回落到缓存
- 静态资源：缓存优先
- 改动页面后想强制刷新缓存：把 `sw.js` 里的 `VERSION` 加一

**注意**：Service Worker 只在 HTTPS 或 localhost 下生效。线上地址是 HTTPS，没问题；本地用 HTTP + 局域网 IP 测的时候 PWA 那部分不生效，但传感器和计数功能本身不受影响。

---

## 关键设计：只有一份算法源码

```
utils/squat-detector.js      ← 唯一真相源
        │
        ├── 微信小程序：require() 直接用
        ├── 网页版：tools/build-web.js 内联进 index.html
        └── 手环版：复制到 band/src/common/
```

`web/index.html` 是**构建产物，不要手改**。要改算法就改 `utils/squat-detector.js`，然后：

```bash
node tools/build-web.js
```

构建脚本带两道守卫：

1. 算法文件里混入 `require(` / `wx.` / `document.` → 直接报错退出（这会破坏跨端复用）
2. 找不到 `module.exports = SquatDetector` → 报错退出（说明算法文件结构变了）

---

## 与微信小程序的差异

| | 微信小程序 | 网页版 |
|---|---|---|
| 传感器 | `wx.onAccelerometerChange` | `devicemotion` 事件（`accelerationIncludingGravity`） |
| 权限 | 敏感接口，需隐私指引审核 | iOS 需点击手势授权（`DeviceMotionEvent.requestPermission`） |
| 震动 | `wx.vibrateShort` | `navigator.vibrate` |
| 存储 | `wx.setStorageSync` | `localStorage` |
| 隐私声明 | 必须提交《用户隐私保护指引》 | 无需 |
| 分发 | 需注册主体 + 备案 + 审核 | 一个链接，可装到桌面（PWA） |
| 分包 | 2MB 限制 | 无 |
| 后台 | 退到后台传感器停摆 | 切后台页面自动暂停（已做兜底） |
| 图表 | 柱状图 + 热力图 + 勋章 | 只有最近记录（小屏不做复杂图表） |
| 分享 | `onShareAppMessage` | 浏览器分享链接 / 装到桌面 |

**两边跑的是同一份算法文件**，所以网页版测出来的阈值手感，对小程序版同样有效。

---

## 本地预览

直接双击 `web/index.html` 就能打开，不需要起服务器。

但**传感器在 `file://` 协议下多数手机浏览器会禁用**，所以要用手机测的话得起个 HTTP 服务：

```bash
cd web
python -m http.server 8000
```

然后手机和电脑连同一个 WiFi，手机浏览器访问 `http://电脑IP:8000`。

> ⚠️ **iOS Safari 只在 HTTPS 或 localhost 下才提供 `DeviceMotionEvent`**。局域网 IP 走 HTTP 的话 iOS 上传感器不可用，Android Chrome 可以。线上链接是 HTTPS，所以直接用线上地址测 iOS 最省事。
>
> Android 还有一个坑：Chrome 需要 HTTPS 才给传感器权限。用线上地址就绕过了。

---

## 功能

- 三种模式：自由 / 目标 N 次 / HIIT
- 圆环进度（30fps 节流 canvas 绘制）
- 每次有效深蹲震动 + 数字弹跳
- 每 10 次震动提示
- 检测方式切换（口袋/绑腿 ↔ 手持）
- 灵敏度三档
- **调试模式**：实时显示倾角、位移、运动量、状态机状态 —— 调阈值必开
- 连续打卡天数、累计次数、累计消耗
- 数据只存 localStorage，无服务器无账号
- **PWA**：可装到桌面（安卓按钮 / iOS 添加到主屏幕），Service Worker 离线可用
