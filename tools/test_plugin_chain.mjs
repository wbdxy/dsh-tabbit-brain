// test_plugin_chain.mjs — 验证插件的网关托管链路
//
// 从全停状态出发（网关没跑、浏览器没开），验证：
//   1. ensureGateway 能把网关拉起来
//   2. 网关启动时用短命 headless 实例取到 cookie
//   3. 全程不留常驻浏览器进程
//
// 用法:
//   cd <插件目录>
//   node tools/test_plugin_chain.mjs [网关目录]
//
// 网关目录默认取 ~/.tabbit-gateway/tabbit-toy，可用参数或环境变量覆盖。
// 刻意不写死路径 —— 写死只在一台机器上成立。

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureGateway, pingGateway } from '../lib/index.js';

const gatewayDir = process.argv[2]
  || process.env.TABBIT_GATEWAY_DIR
  || join(homedir(), '.tabbit-gateway', 'tabbit-toy');

const gatewayUrl = process.env.TABBIT_GATEWAY_URL || 'http://127.0.0.1:8787';
const apiKey = process.env.TABBIT_API_KEY || 'sk-tabbit-local';

const opts = {
  gatewayUrl,
  gatewayAutoStart: true,
  gatewayWarmup: false,
  gatewayStartCommand: 'node "src\\server.mjs"',
  gatewayStartCwd: gatewayDir,
  gatewayStartTimeoutMs: 60000,
};

const hr = (t) => console.log(`\n${'─'.repeat(60)}\n${t}\n${'─'.repeat(60)}`);

hr('0. 环境');
console.log('   网关目录:', gatewayDir);
console.log('   存在    :', existsSync(gatewayDir) ? '✓' : '✗（用参数或 TABBIT_GATEWAY_DIR 指定）');

if (!existsSync(gatewayDir)) {
  console.log('\n   网关目录不存在，无法继续。先按 gateway-patch/README.md 安装网关。\n');
  process.exit(1);
}

hr('1. 起始状态');
console.log('   网关可达:', await pingGateway(gatewayUrl));

hr('2. ensureGateway —— 拉起网关');
const t = Date.now();
const gw = await ensureGateway(opts, { force: true });
console.log(`   -> ok=${gw.ok}  action=${gw.action}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
console.log('   网关复核:', await pingGateway(gatewayUrl));

hr('3. 端到端：模型能否调用');
let chatOk = false;
try {
  const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.TABBIT_TEST_MODEL || 'DeepSeek-V4.1-Flash',
      messages: [{ role: 'user', content: '只回答两个字：收到' }],
      stream: false,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const d = await res.json();
  const txt = d?.choices?.[0]?.message?.content ?? '';
  console.log(`   HTTP ${res.status}，模型回复: ${JSON.stringify(txt.slice(0, 40))}`);
  chatOk = res.ok && txt.length > 0;
} catch (e) {
  console.log(`   ✗ 失败: ${e.message}`);
}

hr('结论');
const pass = gw.ok === true && chatOk;
console.log(pass ? '   ✅ 通过' : '   ❌ 失败');
console.log('   提示：cookie 是否走短命 headless，看网关日志里的 [headless] / [ephemeral] 行');
process.exit(pass ? 0 : 1);
