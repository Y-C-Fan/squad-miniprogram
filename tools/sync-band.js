/**
 * 把核心算法同步到手环工程
 *   node tools/sync-band.js          复制，并打印是否原本已一致
 *   node tools/sync-band.js --check  只检查不复制（有差异则退出码 1）
 *
 * 为什么需要脚本：band/src/common/squat-detector.js 是 utils/squat-detector.js 的副本
 * （Vela 不支持 require 外部目录，只能自带一份）。手抄必然分叉，
 * 而分叉的后果很隐蔽 —— 手环版和网页版算出不同结果，没人看得出来。
 *
 * build.sh 会在编译前自动跑一次（sync 模式），所以永远不会带着旧算法去编译。
 */

'use strict'

const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', 'utils', 'squat-detector.js')
const DST = path.join(__dirname, '..', 'band', 'src', 'common', 'squat-detector.js')

const checkOnly = process.argv.indexOf('--check') >= 0
const src = fs.readFileSync(SRC, 'utf8')
const old = fs.existsSync(DST) ? fs.readFileSync(DST, 'utf8') : ''

if (src === old) {
  console.log('    手环算法副本已一致')
  process.exit(0)
}

if (checkOnly) {
  console.error('    手环算法副本与 utils/squat-detector.js 不一致，跑 node tools/sync-band.js')
  process.exit(1)
}

fs.writeFileSync(DST, src)
const kb = (Buffer.byteLength(src) / 1024).toFixed(1)
console.log('    已同步 band/src/common/squat-detector.js  ' + kb + ' KB')