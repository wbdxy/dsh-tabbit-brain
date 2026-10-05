// test_gateway_autostart.mjs — 验证插件的网关托管逻辑真的能把网关拉起来
//
// 用法（网关必须处于停止状态）:
//   node tools/test_gateway_autostart.mjs
//
// 它导入的是插件本体导出的 ensureGateway —— 测的是真代码，不是复制品。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureGateway, pingGateway } from '../lib/index.js'

const opts = {
  gatewayUrl: process.env.TABBIT_GATEWAY_URL || 'http://127.0.0.1:8787',
  gatewayAutoStart: true,
  gatewayStartCommand: 'node src/server.mjs',
  // 网关目录从参数 / 环境变量推导，不写死 —— 写死只在一台机器上成立
  gatewayStartCwd: process.argv[2]
    || process.env.TABBIT_GATEWAY_DIR
    || join(homedir(), '.tabbit-gateway', 'tabbit-toy'),
  gatewayStartTimeoutMs: 30000,
}

console.log('1) 探测当前状态…')
const before = await pingGateway(opts.gatewayUrl)
console.log('   网关可达:', before)
if (before) {
  console.log('   （网关已在运行。要验证"拉起"路径，请先停掉它再跑本测试）')
  process.exit(0)
}

console.log('2) 调用 ensureGateway（应执行启动命令并等待健康检查）…')
const t0 = Date.now()
const r = await ensureGateway(opts, { force: true })
const dt = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`   -> ok=${r.ok}  action=${r.action}  (${dt}s)`)

console.log('3) 复核健康…')
const after = await pingGateway(opts.gatewayUrl)
console.log('   网关可达:', after)

const pass = r.ok === true && after === true
console.log(pass ? '\n✅ 通过：插件能把网关拉起来' : '\n❌ 失败')
process.exit(pass ? 0 : 1)
