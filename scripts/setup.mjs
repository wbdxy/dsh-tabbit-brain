#!/usr/bin/env node
// setup.mjs — 把「手工编辑文件」变成一条命令
//
// 这个脚本做三件用户本来要手工做的事：
//   1. 创建子代理预设（~/.dsh/.agent-presets/<presetId>/）
//   2. 在 settings.yaml 里注册 provider
//   3. 在你的主预设里挂载委派工具
//
// 它**只做加法和备份**：改动前一律先备份，已存在的条目会跳过而不是覆盖，
// 找不到的地方会明确告诉你还差什么，而不是猜。
//
// 用法：
//   node scripts/setup.mjs --help          # 看全部参数与占位符说明
//   node scripts/setup.mjs --dry-run       # 只显示会改什么，不动任何文件
//   node scripts/setup.mjs                 # 交互式，缺什么问什么
//
// 设计取向：所有「你必须自己填」的值都是显式参数，并且 --help 里逐条解释了
// 它们的含义和从哪来。脚本自己不发明任何默认值去猜你的环境。

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

// ─── 参数 ────────────────────────────────────────────────────────────────────

const SPEC = {
  '--profile': {
    arg: '<name>',
    desc: 'DSH profile 名（如 desktop / web）。插件要装进哪个 profile。',
    hint: '看 ~/.dsh/profiles/ 下的目录名',
    default: 'desktop',
  },
  '--preset-id': {
    arg: '<id>',
    desc: 'Legacy option; ignored by the internal Brain service.',
    hint: '',
    default: 'tabbit-brain',
  },
  '--provider': {
    arg: '<name>',
    desc: 'DSH 里的 provider 注册名，必须与插件配置的 providerName 一致。',
    hint: '',
    default: 'tabbit-local',
  },
  '--api-key': {
    star: true,
    arg: '<key>',
    desc: '网关的 API key。**必须与网关 .env 里的 API_KEY 完全一致。**',
    hint: '你自己在网关 .env 里设的那个值',
    default: 'sk-tabbit-local',
  },
  '--base-url': {
    arg: '<url>',
    desc: '网关的 OpenAI 兼容地址。',
    hint: '默认 http://127.0.0.1:8787/v1',
    default: 'http://127.0.0.1:8787/v1',
  },
  '--models': {
    star: true,
    arg: '<a,b,c>',
    desc: '要注册的模型 id，逗号分隔。**必须是你账号里实际有的。**',
    hint: '跑 curl <网关>/v1/models -H "Authorization: Bearer <你的key>" 看列表',
    default: '',   // 留空则尝试从网关自动读
  },
  '--mount-preset': {
    star: true,
    arg: '<name>',
    desc: 'Legacy option; no preset mounting is needed.',
    hint: '默认读 settings.yaml 的 agent-presets.default',
    default: '',
  },
  '--write-settings': {
    arg: '',
    desc: '允许脚本修改 settings.yaml。不加则只打印要加的内容，不改文件。',
    hint: '',
    default: false,
  },
  '--force': { arg: '', desc: '允许覆盖已存在的条目（默认跳过）。', hint: '', default: false },
  '--dry-run': { arg: '', desc: '只显示会做什么，不写任何文件。', hint: '', default: false },
  '--yes': { arg: '', desc: '不交互，全部用参数值/默认值。', hint: '', default: false },
  '--help': { arg: '', desc: '显示本帮助。', hint: '', default: false },
};

// 参数名统一转成下划线形式：--base-url -> base_url，
// 这样 JS 里读 a.base_url 不会因为连字符而变成 undefined。
const norm = (flag) => flag.replace(/^--/, '').replace(/-/g, '_');

function parseArgs(argv) {
  const out = {};
  for (const [k, v] of Object.entries(SPEC)) out[norm(k)] = v.default;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = norm(a);
    if (!(key in out)) { console.error(`未知参数: ${a}（用 --help 看可用参数）`); process.exit(2); }
    const spec = SPEC[a];
    if (spec.arg && (!argv[i + 1] || argv[i + 1].startsWith('--'))) {
      console.error('Missing value for ' + a); process.exit(2);
    }
    out[key] = spec.arg ? argv[++i] : true;
  }
  return out;
}

function help() {
  console.log(`
setup.mjs — 把「手工编辑文件」变成一条命令

用法:
  node scripts/setup.mjs [选项]

选项：
  ★ = 必须你自己填，脚本猜不出来（其余有合理默认值，可先用默认跑一遍）
`);
  for (const [flag, s] of Object.entries(SPEC)) {
    const left = `${s.star ? '★ ' : '  '}${flag}${s.arg ? ' ' + s.arg : ''}`;
    console.log(`  ${left.padEnd(29)} ${s.desc}`);
    if (s.hint) console.log(`  ${''.padEnd(29)} → ${s.hint}`);
    if (s.default !== '' && s.default !== false) console.log(`  ${''.padEnd(29)} 默认: ${s.default}`);
  }
  console.log(`
例子:
  # 先看会改什么（强烈建议第一次这么跑）
  node scripts/setup.mjs --dry-run

  # 真正执行
  node scripts/setup.mjs --api-key sk-tabbit-local --write-settings

  # 指定模型（你账号里实际有的）
  node scripts/setup.mjs --models DeepSeek-V4.1-Flash,GLM-5.3 --write-settings

做完之后仍需你手动做的一步: 重启 DSH。
`);
}

// ─── 小工具 ──────────────────────────────────────────────────────────────────

const log = (...a) => console.log(...a);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const skip = (m) => console.log(`  \x1b[90m-\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const err = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const step = (n, m) => console.log(`\n${'─'.repeat(64)}\n${n}. ${m}\n${'─'.repeat(64)}`);

let DRY = false;
const changes = [];

function backup(p) {
  if (!existsSync(p)) return;
  const b = `${p}.bak-setup-${Date.now()}`;
  if (!DRY) copyFileSync(p, b);
  log(`    已备份 → ${b}`);
}

function write(p, content) {
  changes.push(p);
  if (DRY) { log(`    [dry-run] 会写入 ${p}`); return; }
  backup(p);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

// ─── 步骤 ────────────────────────────────────────────────────────────────────

function checkEnv(a) {
  step(1, '环境检查');
  const major = Number(process.versions.node.split('.')[0]);
  major >= 22 ? ok(`Node ${process.version}`) : warn(`Node ${process.version} —— 建议 22+`);

  const profiles = existsSync(join(DSH_HOME, 'profiles'))
    ? readdirSync(join(DSH_HOME, 'profiles')) : [];
  if (profiles.includes(a.profile)) ok(`profile "${a.profile}" 存在`);
  else warn(`profile "${a.profile}" 不在 ${join(DSH_HOME, 'profiles')}（现有: ${profiles.join(', ') || '无'}）`);

  const settings = join(DSH_HOME, 'settings.yaml');
  existsSync(settings) ? ok(`settings.yaml 存在`) : warn(`settings.yaml 不存在，将新建`);

  // 网关可达性 —— 顺便读模型列表
  return fetch(a.base_url.replace(/\/v1\/?$/, '') + '/healthz', {
    headers: { Authorization: `Bearer ${a.api_key}` },
    signal: AbortSignal.timeout(3000),
  }).then((r) => r.ok).catch(() => false);
}

function loadYaml(file, fallback, kind) {
  const document = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : fallback);
  if (document.errors.length) throw new Error(kind + ': ' + document.errors[0].message);
  return document;
}

function requireMap(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a YAML mapping');
  }
}

function preflight(a) {
  const settings = join(DSH_HOME, 'settings.yaml');
  const document = loadYaml(settings, '{}\n', 'settings.yaml');
  const data = document.toJS() || {};
  requireMap(data, 'settings');
  if (data['llm-pi-ai'] !== undefined) {
    requireMap(data['llm-pi-ai'], 'llm-pi-ai');
    if (data['llm-pi-ai'].providers != null) requireMap(data['llm-pi-ai'].providers, 'providers');
  }
  return { document, data };
}

function registerProvider(a, prepared) {
  step(3, `在 settings.yaml 注册 provider "${a.provider}"`);
  if (!(a.models || '').trim()) throw new Error('Specify --models with ids returned by /v1/models');
  const data = prepared.data;
  data['llm-pi-ai'] ||= {};
  data['llm-pi-ai'].providers ||= {};
  if (data['llm-pi-ai'].providers[a.provider] && !a.force) {
    skip('Provider already exists; preserved');
    return;
  }
  data['llm-pi-ai'].providers[a.provider] = {
    displayName: 'Tabbit local gateway', apiKeyEnv: 'TABBIT_API_KEY', baseURL: a.base_url,
    models: a.models.split(',').map(id => ({ id: id.trim(), inputModalities: ['text', 'image'] })),
  };
  if (a.write_settings) write(join(DSH_HOME, 'settings.yaml'), stringify(data));
  else warn('Settings not written; use --write-settings to enable this step');
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.help) { help(); process.exit(0); }
DRY = Boolean(args.dry_run);

log(`\n  dsh-tabbit-brain 安装助手${DRY ? '  [DRY-RUN，不会写任何文件]' : ''}`);

// Validate every input before the first write.
let prepared;
try {
  if (!args.models.trim()) throw new Error('Specify --models');
  for (const value of [args.provider].filter(Boolean)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid identifier: ' + value);
  }
  prepared = preflight(args);
} catch (e) { console.error('Setup stopped: ' + e.message); process.exit(1); }
const gatewayUp = await checkEnv(args);

step('0', '你要自己填的值');
log(`    profile      : ${args.profile}          (--profile)`);
log('    api-key      : [redacted] (--api-key)');
log(`    base-url     : ${args.base_url}         (--base-url)`);
log(`    models       : ${args.models || '(未提供，将要从网关读取)'}   (--models)`);
log(`    mount-preset : ${args.mount_preset || '(未指定)'}   (--mount-preset)`);
if (!gatewayUp) {
  warn('网关当前不可达。先启动网关再跑本脚本，否则读不到模型列表。');
  warn(`  healthz: ${args.base_url.replace(/\/v1\/?$/, '')}/healthz`);
}

registerProvider(args, prepared);


step(5, '还需要你手动做的事');
log('    1. 设置 API key 环境变量：');
log("       [Environment]::SetEnvironmentVariable('TABBIT_API_KEY', '<YOUR_KEY>', 'User')");
log('    2. 启动网关（如果还没跑）：');
log('       cd <你的 tabbit-toy 目录> && node src/server.mjs');
log('    3. **重启 DSH** —— 插件源码/预设改动只有重启才生效。');
log('');

if (DRY) log('  [DRY-RUN 结束] 加 --write-settings 并去掉 --dry-run 才会真正写入。\n');
else if (changes.length) log(`  共改动 ${changes.length} 个文件（都有 .bak-setup-* 备份）\n`);
else log('  没有文件被改动。\n');
