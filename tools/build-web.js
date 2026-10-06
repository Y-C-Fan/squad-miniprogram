/**
 * 构建网页版：把 utils/squat-detector.js 内联进 web/index.template.html
 *
 *   node tools/build-web.js
 *
 * 为什么要有这步：网页版和微信版必须跑同一份算法。
 * 如果各自维护一份，改了一边忘了另一边，两端结果就会不一致。
 * 所以 web/index.html 是「构建产物」，不要手改，要改就改 utils/squat-detector.js。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DETECTOR = path.join(ROOT, 'utils', 'squat-detector.js')
const TPL = path.join(ROOT, 'web', 'index.template.html')
const OUT = path.join(ROOT, 'web', 'index.html')

let src = fs.readFileSync(DETECTOR, 'utf8')

// CommonJS → 浏览器全局
if (!/module\.exports\s*=\s*SquatDetector/.test(src)) {
  console.error('FAIL: utils/squat-detector.js 里找不到 module.exports = SquatDetector，算法文件结构变了？')
  process.exit(1)
}
src = src.replace(/module\.exports\s*=\s*SquatDetector/, 'window.SquatDetector = SquatDetector')
src = src.replace(/^'use strict'\s*$/m, '')

if (/require\(|wx\.|document\./.test(src)) {
  console.error('FAIL: 算法文件里混入了小程序 API 或 DOM 依赖，这会破坏它跨端复用的前提')
  process.exit(1)
}

const tpl = fs.readFileSync(TPL, 'utf8')
if (!tpl.includes('/* __DETECTOR__ */')) {
  console.error('FAIL: 模板里找不到 /* __DETECTOR__ */ 占位符')
  process.exit(1)
}

const out = tpl.replace('/* __DETECTOR__ */', src)
fs.writeFileSync(OUT, out)

const kb = (Buffer.byteLength(out) / 1024).toFixed(1)
console.log(`OK  web/index.html  ${kb} KB`)
console.log(`    内联算法 ${(Buffer.byteLength(src) / 1024).toFixed(1)} KB，与微信版同一份源码`)
