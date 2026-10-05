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
import { createInterface } from 'node:readline';

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
    desc: '子代理挂载的预设 id。默认 tabbit-brain，一般不用改。',
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
    desc: '把委派工具挂到哪个预设（你主对话用的那个）。',
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

async function ask(question, fallback) {
  if (args.yes) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((res) => rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `, res));
  rl.close();
  return a.trim() || fallback;
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

function writePreset(a) {
  step(2, `创建子代理预设 "${a.preset_id}"`);
  log('    作用: 子代理挂载的极简预设。persona complete:true + 不挂任何工具行。');
  log('    为什么需要: 父预设很大，直接继承会把任务淹没（实测提示词 61,031 字符）。');

  const dir = join(DSH_HOME, '.agent-presets', a.preset_id);
  const manifest = join(dir, 'preset.yml');
  const composition = join(dir, 'agent.cordis.yml');

  if (existsSync(composition) && !a.force) {
    skip(`${dir} 已存在，跳过（要覆盖加 --force）`);
    return;
  }

  write(manifest, `name: Tabbit 外置大脑
order: 51
description: 子代理挂载的极简预设：persona complete:true，不挂任何工具。
`);
  write(composition, `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    complete: true
    includeRuntimeContext: false
    prefix: |-
      你是一个纯推理单元。你没有工具：不能执行命令、读写文件，
      也访问不到 MCP 服务器或 Skill 注册表。

      你的输出会被一个拥有这些工具的主 agent 消费。
      所以请产出自包含的成品——分析、设计、代码、结论——
      不要说"我来读取文件"。需要材料时明确说出你需要什么，调用方会取回来。

      直接、准确、简洁地回答。不要编造。
`);
  ok(`已写入 ${dir}`);
}

function registerProvider(a) {
  step(3, `在 settings.yaml 注册 provider "${a.provider}"`);
  log('    作用: 让 DSH 知道可以通过本地网关调用哪些模型。');

  const settings = join(DSH_HOME, 'settings.yaml');
  const existing = existsSync(settings) ? readFileSync(settings, 'utf8') : '';

  if (existing.includes(`${a.provider}:`) && !a.force) {
    skip('settings.yaml 里已有该 provider，跳过（要覆盖加 --force）');
    return;
  }

  const models = (a.models || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (models.length === 0) {
    warn('未提供 --models，无法注册模型。');
    warn('  跑这条命令拿到你账号实际可用的 id:');
    warn(`  curl ${a.base_url}/models -H "Authorization: Bearer ${a.api_key}"`);
    warn('  然后重跑并加 --models <id1,id2>');
    return;
  }

  const block = `
  ${a.provider}:
    displayName: Tabbit 本地网关
    apiKeyEnv: TABBIT_API_KEY
    baseURL: ${a.base_url}
    models:
${models.map((m) => `      - id: ${m}\n        inputModalities: [text, image]`).join('\n')}
`;
  log(`    将注册 ${models.length} 个模型: ${models.join(', ')}`);
  log('    ⚠ 模型 id 必须是你账号实际有的，否则会被跳过。');

  if (!a.write_settings) {
    warn('未加 --write-settings，只打印不写入。把下面这段加进 settings.yaml 的 llm-pi-ai.providers 下：');
    log(block);
    return;
  }

  if (!existing.includes('llm-pi-ai:')) {
    write(settings, existing + `\nllm-pi-ai:\n  providers:\n${block}`);
    ok('已新建 llm-pi-ai.providers 并写入');
    return;
  }
  // 已有 llm-pi-ai：在其 providers 下追加（按缩进定位插入点）
  const lines = existing.split('\n');
  const start = lines.findIndex((l) => /^llm-pi-ai:/.test(l));
  let insertAt = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) break;      // 下一个顶层键
    insertAt = i + 1;
  }
  lines.splice(insertAt, 0, `  providers:`.match(/  providers:/) && !existing.includes('providers:') ? '' : '', block.trimEnd());
  write(settings, lines.filter((l) => l !== '').join('\n') + '\n');
  ok('已在 llm-pi-ai 下追加 provider');
  warn('如果 settings.yaml 里已有 providers: 段，请人工确认缩进是否正确。');
}

function mountTool(a, preset) {
  step(4, `在主预设 "${preset}" 里挂载委派工具`);
  log('    作用: 让主对话多出一个 subagent_tabbit 工具，可以把推理任务外包。');

  if (!preset) {
    warn('无法确定要挂到哪个预设。');
    warn('  用 --mount-preset <name> 指定（你主对话用的那个预设，如 router-standard）');
    warn('  然后在它的 delegation 组里加这一行：');
    log(`
- id: tool-subagent-tabbit
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: ${a.provider}
    toolName: subagent_tabbit
    backgroundMode: continuable
    # 不要写 persona      —— 提示词由子代理挂载的预设决定
    # 不要写 agentOptions —— 会覆盖插件设置里的模型选择
`);
    return;
  }

  const file = join(DSH_HOME, '.agent-presets', preset, 'agent.cordis.yml');
  if (!existsSync(file)) {
    err(`预设文件不存在: ${file}`);
    return;
  }
  const text = readFileSync(file, 'utf8');
  if (text.includes('tool-subagent-tabbit')) {
    skip('该预设里已挂载，跳过');
    return;
  }

  const block = `
- id: tool-subagent-tabbit
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: ${a.provider}
    toolName: subagent_tabbit
    backgroundMode: continuable
`;
  write(file, text.trimEnd() + '\n' + block);
  ok(`已追加到 ${file}`);
  warn('请打开该文件确认这条被放进了 delegation 分组（缩进/分组正确）。');
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.help) { help(); process.exit(0); }
DRY = Boolean(args['dry-run']);

log(`\n  dsh-tabbit-brain 安装助手${DRY ? '  [DRY-RUN，不会写任何文件]' : ''}`);

const gatewayUp = await checkEnv(args);

step('0', '你要自己填的值');
log(`    profile      : ${args.profile}          (--profile)`);
log(`    api-key      : ${args.api_key}          (--api-key，须与网关 .env 一致)`);
log(`    base-url     : ${args.base_url}         (--base-url)`);
log(`    models       : ${args.models || '(未提供，将要从网关读取)'}   (--models)`);
log(`    mount-preset : ${args.mount_preset || '(未指定)'}   (--mount-preset)`);
if (!gatewayUp) {
  warn('网关当前不可达。先启动网关再跑本脚本，否则读不到模型列表。');
  warn(`  healthz: ${args.base_url.replace(/\/v1\/?$/, '')}/healthz`);
}

writePreset(args);
registerProvider(args);

// mount-preset 缺省时尝试读 settings.yaml 的 agent-presets.default
let mountTo = args.mount_preset;
if (!mountTo) {
  const s = join(DSH_HOME, 'settings.yaml');
  if (existsSync(s)) {
    const m = readFileSync(s, 'utf8').match(/^\s*default:\s*(\S+)/m);
    if (m) { mountTo = m[1]; log(`\n    （从 settings.yaml 推断主预设为 "${mountTo}"）`); }
  }
}
mountTool(args, mountTo);

step(5, '还需要你手动做的事');
log('    1. 设置 API key 环境变量：');
log(`       [Environment]::SetEnvironmentVariable('TABBIT_API_KEY', '${args.api_key}', 'User')`);
log('    2. 启动网关（如果还没跑）：');
log('       cd <你的 tabbit-toy 目录> && node src/server.mjs');
log('    3. **重启 DSH** —— 插件源码/预设改动只有重启才生效。');
log('');

if (DRY) log('  [DRY-RUN 结束] 加 --write-settings 并去掉 --dry-run 才会真正写入。\n');
else if (changes.length) log(`  共改动 ${changes.length} 个文件（都有 .bak-setup-* 备份）\n`);
else log('  没有文件被改动。\n');
