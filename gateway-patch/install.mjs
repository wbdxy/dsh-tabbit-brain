#!/usr/bin/env node
// install.mjs — 一条命令把网关装好
//
// 为什么是「安装器 + 覆盖文件」而不是「完整 fork」：
//
//   上游 `goehou/tabbit-toy` **没有任何 LICENSE 文件**。未声明许可 = 默认保留所有
//   权利，所以我们不转发它的代码。安装器在**你的机器上**从官方仓库 clone 一份，
//   再把我们改动的文件覆盖上去 —— 我们只分发自己写的那部分。
//
//   顺带的好处：上游更新能自然流入。重跑本脚本即拿到上游最新代码 + 我们的改动。
//
// 用法：
//   node gateway-patch/install.mjs --help
//   node gateway-patch/install.mjs --dir ~/.tabbit-gateway/tabbit-toy --dry-run
//   node gateway-patch/install.mjs --dir ~/.tabbit-gateway/tabbit-toy

import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPSTREAM = 'https://github.com/goehou/tabbit-toy';

const SPEC = {
  '--dir': { arg: '<path>', desc: '网关安装目录。', default: join(homedir(), '.tabbit-gateway', 'tabbit-toy') },
  '--repo': { arg: '<url>', desc: '上游仓库地址（想用镜像时改这里）。', default: UPSTREAM },
  '--ref': { arg: '<branch>', desc: '上游分支/tag。', default: '' },
  '--api-key': { arg: '<key>', desc: '★ 网关的 API key。自己定，后面 DSH 那侧要一致。', default: 'sk-tabbit-local' },
  '--port': { arg: '<n>', desc: '网关监听端口。', default: '8787' },
  '--base-url': { arg: '<url>', desc: '★ Tabbit 后端地址。国内版 web.tabbit.com，国际版 web.tabbit.ai。', default: 'https://web.tabbit.com' },
  '--skip-clone': { arg: '', desc: '不 clone，只覆盖补丁（目录已存在时用）。', default: false },
  '--dry-run': { arg: '', desc: '只显示会做什么，不写任何文件。', default: false },
  '--help': { arg: '', desc: '显示本帮助。', default: false },
};

const norm = (f) => f.replace(/^--/, '').replace(/-/g, '_');

function parseArgs(argv) {
  const out = {};
  for (const [k, v] of Object.entries(SPEC)) out[norm(k)] = v.default;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = norm(a);
    if (!(k in out)) { console.error(`未知参数: ${a}（用 --help 看可用参数）`); process.exit(2); }
    out[k] = SPEC[a].arg ? argv[++i] : true;
  }
  return out;
}

function help() {
  console.log(`
install.mjs — 一条命令装好 Tabbit 网关

用法:
  node gateway-patch/install.mjs [选项]

选项（★ = 必须你自己填）:
${Object.entries(SPEC).map(([f, s]) =>
  `  ${(s.arg ? '★ ' : '  ')}${f}${s.arg ? ' ' + s.arg : ''}`.padEnd(30) + s.desc
  + (s.default !== '' && s.default !== false ? `\n${' '.repeat(30)}默认: ${s.default}` : '')
).join('\n')}

它做四件事:
  1. 从上游 clone 网关（不 clone 就加 --skip-clone）
  2. 覆盖我们改动的文件（scripts/lib/detect.mjs、cdp.mjs、src/config.mjs、src/server.mjs）
  3. 写 .env（API key 与 Tabbit 地址由你指定）
  4. 验证：启动一次，确认能自动取到 cookie

做完之后仍需你手动做:
  - 在 DSH 的 settings.yaml 里注册 provider（见 SETUP.md）
  - 确保 Tabbit 已登录（cookie 要从那里读）
`);
}

const log = (...a) => console.log(...a);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const err = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const step = (n, m) => console.log(`\n${'─'.repeat(64)}\n${n}. ${m}\n${'─'.repeat(64)}`);

const args = parseArgs(process.argv.slice(2));
if (args.help) { help(); process.exit(0); }
const DRY = Boolean(args.dry_run);
const DIR = resolve(args.dir);

log(`\n  Tabbit 网关安装器${DRY ? '  [DRY-RUN，不会写任何文件]' : ''}`);
log(`  安装目录: ${DIR}`);

// ── 1. clone ─────────────────────────────────────────────────────────────────
step(1, '获取上游代码');
log(`    上游: ${args.repo}`);
log('    说明: 上游没有 LICENSE 文件（默认保留所有权利），所以我们不转发它的代码，');
log('          而是在你机器上直接从官方仓库取一份。');

const gitDir = join(DIR, '.git');
if (args.skip_clone) {
  warn('--skip-clone：跳过 clone');
} else if (existsSync(gitDir)) {
  ok('目录已是 git 仓库，执行 git pull 更新');
  if (!DRY) {
    try {
      execFileSync('git', ['-C', DIR, 'pull', '--ff-only'], { stdio: 'inherit', timeout: 120000 });
    } catch { warn('git pull 失败（可能已是最新或有本地改动），继续'); }
  }
} else if (existsSync(DIR) && readdirSync(DIR).length > 0) {
  warn(`${DIR} 已存在且非空，但不是 git 仓库。`);
  warn('  要么删掉它重来，要么加 --skip-clone 只覆盖补丁。');
  process.exit(1);
} else {
  if (DRY) { log(`    [dry-run] git clone ${args.repo} ${DIR}`); }
  else {
    mkdirSync(dirname(DIR), { recursive: true });
    const argv = ['clone', '--depth', '1'];
    if (args.ref) argv.push('--branch', args.ref);
    argv.push(args.repo, DIR);
    execFileSync('git', argv, { stdio: 'inherit', timeout: 300000 });
    ok('clone 完成');
  }
}

// ── 2. 覆盖我们的改动 ────────────────────────────────────────────────────────
step(2, '应用我们的改动');
log('    分为两类：原创新增文件、修改过的上游文件。');

const OVERLAY = join(HERE, 'files');
const MANIFEST = [
  ['scripts/lib/detect.mjs', '原创新增：浏览器安装位置与 profile 自动探测'],
  ['scripts/lib/cdp.mjs', '修改：新增 withEphemeralBrowser（短命 headless 取 cookie）'],
  ['src/config.mjs', '修改：browserExe / browserUserDataDir 走自动探测'],
  ['src/server.mjs', '修改：cookie 刷新失败时回退到短命 headless'],
];

let copied = 0;
for (const [rel, why] of MANIFEST) {
  const src = join(OVERLAY, rel);
  const dst = join(DIR, rel);
  if (!existsSync(src)) { warn(`源文件缺失: ${src}`); continue; }
  log(`    ${rel}`);
  log(`      ${why}`);
  if (DRY) { log(`      [dry-run] 会覆盖 → ${dst}`); continue; }
  if (existsSync(dst)) copyFileSync(dst, `${dst}.upstream-bak`);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  copied++;
}
if (!DRY) ok(`已覆盖 ${copied} 个文件（原文件备份为 *.upstream-bak）`);

// ── 3. 写 .env ───────────────────────────────────────────────────────────────
step(3, '写 .env');
const envPath = join(DIR, '.env');
const envContent = `# Tabbit 网关配置 —— 由 dsh-tabbit-brain 的安装器生成
#
# ⚠ 本文件含登录凭证，**不要提交到任何仓库**。
#    TABBIT_COOKIE 会在服务启动时自动写入，无需手工填。

# Tabbit 后端地址：国内版 web.tabbit.com，国际版 web.tabbit.ai
TABBIT_BASE_URL=${args.base_url}

# 服务端口与鉴权 key（DSH 那侧的 TABBIT_API_KEY 必须与此一致）
PORT=${args.port}
API_KEY=${args.api_key}

# CDP 调试端口（自动取 cookie 时用）
CDP_PORT=9222

# cookie 自动刷新间隔（分钟）
COOKIE_REFRESH_MINUTES=360

# ── 自动取 cookie（短命 headless 实例，无窗口、不留常驻进程）──────────
TABBIT_AUTO_LAUNCH_BROWSER=1
# 下面两项留空即自动探测（注册表 → 标准位置）。探测失败时手工填。
# TABBIT_EXE=
# TABBIT_USER_DATA_DIR=
TABBIT_BROWSER_LAUNCH_TIMEOUT_MS=45000

# 不要自动关闭你自己开着的浏览器（短命实例不占 profile，无需这一项）
TABBIT_KILL_EXISTING_BROWSER=0

# TABBIT_COOKIE 由服务启动时自动写入，不要手工填
TABBIT_COOKIE=
`;

if (DRY) {
  log('    [dry-run] 会写入 .env：');
  log(envContent.split('\n').map((l) => '      ' + l).join('\n'));
} else if (existsSync(envPath)) {
  warn('.env 已存在，保留原文件（只补缺失项）');
  const cur = readFileSync(envPath, 'utf8');
  const have = new Set(cur.split('\n').map((l) => (l.split('=')[0] || '').trim()));
  const add = envContent.split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l) && !have.has(l.split('=')[0]))
    .join('\n');
  if (add) { writeFileSync(envPath, cur.trimEnd() + '\n\n' + add + '\n'); ok('已补缺失项'); }
  else ok('无需改动');
} else {
  writeFileSync(envPath, envContent);
  ok('已写入 .env');
}

// ── 4. 提醒 ──────────────────────────────────────────────────────────────────
step(4, '下一步');

// 顺便查一下依赖是否装了
const hasModules = existsSync(join(DIR, 'node_modules'));
if (!hasModules) warn(`依赖未安装 —— 先跑: cd ${DIR} && npm install`);
else ok('node_modules 存在');

log('');
log('    验证（会起一个无窗口实例取 cookie，约 3 秒）:');
log(`      cd ${DIR} && node src/server.mjs`);
log('      日志里看到 [ephemeral] 就成功了。');
log('');
log('    如果日志说「cookie 里没有 token」→ 你的 Tabbit 没登录，先打开它登录一次。');
log('');
log('    然后回到 SETUP.md 步骤 3，在 DSH 里注册 provider。');
log('');

if (DRY) log('  [DRY-RUN 结束] 去掉 --dry-run 才会真正写入。\n');
log(`  上游许可提示: ${UPSTREAM} 未附带 LICENSE 文件。本安装器不转发其代码，`);
log('  仅在你的机器上从官方仓库获取，并覆盖我们自己的改动。\n');
