/**
 * Service Worker：让网页版能装到桌面 + 断网也能用
 *
 * 为什么要它：一个链接就能用，比"下载 App / 装 rpk"门槛低得多。
 * 装到桌面后是全屏独立窗口，和原生 App 观感几乎一样；训练时不联网也能跑。
 *
 * 策略：
 *   - 页面导航：网络优先，失败回落到缓存（这样在线永远拿到最新版，离线也能开）
 *   - 静态资源：缓存优先
 *   - 改完 web/index.html 想强制刷新缓存，把 VERSION 加一即可
 */

'use strict'

const VERSION = 'v2'
const CACHE = `squad-${VERSION}`

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // 页面导航：网络优先
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('./index.html', copy))
          return res
        })
        .catch(() =>
          caches.match('./index.html').then((r) => r || caches.match('./'))
        )
    )
    return
  }

  // 静态资源：缓存优先
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        })
    )
  )
})
