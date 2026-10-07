#!/usr/bin/env node
// audit-docs.mjs — 文档漂移自查
//
// 查这几类：
//   1. 内部链接指向不存在的文件
//   2. 文档里引用的仓库内路径是否存在
//   3. 文档里提到的 npm scripts 是否真在 package.json 里
//   4. 配置表字段 vs 代码 schema
//   5. 版本号一致性（package.json vs CHANGELOG）
//   6. 中文/英文文档结构是否对称
//
// 用法: node tools/audit-docs.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

// 仓库内文件（git 权威）
let files = [];
try {
  files = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch {
  // 非 git 环境退化到遍历
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else files.push(rel(p));
    }
  })(ROOT);
}

const docs = files.filter((f) => f.endsWith('.md'));
const issues = [];
const add = (kind, file, detail) => issues.push({ kind, file, detail });

// ── 1 + 2. 链接与路径引用 ─────────────────────────────────────────────────
const SKIP_PATH_PREFIX = ['scripts/lib/', 'src/', 'tabbit-toy/', 'lib/trace.log'];

// CHANGELOG 是历史记录：它**应该**引用被修掉的旧路径、旧行为、旧名字。
// 对它查"路径是否存在"是范畴错误——那会逼着人把历史改写得不准确。
const SKIP_PATH_CHECK = new Set(['CHANGELOG.md']);

// Only the direct exported config property can declare this runtime ledger.
// This bounded scanner treats templates as opaque, including their interpolations.
function configTokens(source) {
  let i = 0;
  function token() {
    while (i < source.length) {
      if (/\s/.test(source[i])) { i++; continue; }
      if (source.startsWith('//', i)) {
        while (i < source.length && source[i] !== '\n') i++;
        continue;
      }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        if (end < 0) throw new Error('Unclosed comment');
        i = end + 2;
        continue;
      }
      break;
    }
    if (i === source.length) return null;
    const c = source[i++];
    if (c === '"' || c === "'") {
      const start = i;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === c) return { kind: 'string', value: source.slice(start, i - 1) };
      }
      throw new Error('Unclosed string');
    }
    if (c === '`') {
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === '`') return { kind: 'template', value: '' };
        if (source[i - 1] === '$' && source[i] === '{') {
          i++;
          let depth = 1;
          while (depth) {
            const t = token();
            if (!t) throw new Error('Unclosed interpolation');
            if (t.kind === 'code' && t.value === '{') depth++;
            if (t.kind === 'code' && t.value === '}') depth--;
          }
        }
      }
      throw new Error('Unclosed template');
    }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i - 1;
      while (i < source.length && /[\w$]/.test(source[i])) i++;
      return { kind: 'code', value: source.slice(start, i) };
    }
    return { kind: 'code', value: c };
  }
  const tokens = [];
  for (let t; (t = token());) tokens.push(t);
  return tokens;
}

function declaresBrainSessionDefault(source) {
  const tokens = configTokens(source);
  const expected = configTokens("ENV.TABBIT_BRAIN_SESSION_MAP_PATH || process.env.TABBIT_BRAIN_SESSION_MAP_PATH || join(dirname(fileURLToPath(import.meta.url)), '..', 'state', 'brain-session-map.json')");
  const isCode = (t, value) => t?.kind === 'code' && t.value === value;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (depth === 0 && ['export', 'const', 'config', '=', '{'].every((v, n) => isCode(tokens[i + n], v))) {
      let start = i + 5;
      let nested = 0;
      let declared = false;
      let seen = false;
      for (let j = start; j < tokens.length; j++) {
        const t = tokens[j];
        if (nested === 0 && (isCode(t, ',') || isCode(t, '}'))) {
          const property = tokens.slice(start, j);
          if (isCode(property[0], '.') || isCode(property[0], '[')) return false;
          if (property[0]?.value === 'brainSessionStatePath' && property[0].kind !== 'template') {
            if (seen) return false;
            seen = true;
            declared = isCode(property[1], ':') && property.length === expected.length + 2
              && expected.every((v, n) => v.kind === property[n + 2].kind && v.value === property[n + 2].value);
          }
          if (isCode(t, '}')) return declared;
          start = j + 1;
        } else if (t.kind === 'code') {
          if (['{', '(', '['].includes(t.value)) nested++;
          if (['}', ')', ']'].includes(t.value)) nested--;
        }
      }
      return false;
    }
    if (isCode(tokens[i], '{')) depth++;
    if (isCode(tokens[i], '}')) depth--;
  }
  return false;
}

let hasBrainSessionDefault = false;
try {
  hasBrainSessionDefault = declaresBrainSessionDefault(readFileSync(join(ROOT, 'gateway-patch/files/src/config.mjs'), 'utf8'));
} catch {}

for (const f of docs) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  const dir = dirname(f);

  // markdown 链接
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = m[1];
    if (/^https?:/.test(link) || link.startsWith('#')) continue;
    if (SKIP_PATH_CHECK.has(f)) continue;
    const target = link.split('#')[0];
    if (!target) continue;
    const resolved = join(ROOT, dir, target);
    if (!existsSync(resolved)) add('dead-link', f, `${link} → 不存在`);
  }

  // 反引号里的仓库内路径
  for (const m of text.matchAll(/`([a-zA-Z0-9._/-]+\/[a-zA-Z0-9._-]+\.(?:mjs|js|py|md|yml|json))`/g)) {
    const p = m[1];
    if (SKIP_PATH_CHECK.has(f)) continue;
    if (SKIP_PATH_PREFIX.some((s) => p.startsWith(s))) continue;
    if (p === 'state/brain-session-map.json' && hasBrainSessionDefault) continue;
    if (!existsSync(join(ROOT, p))) add('ghost-path', f, `\`${p}\` 在仓库里不存在`);
  }
}

// ── 3. npm scripts ────────────────────────────────────────────────────────
let pkg = {};
try { pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')); } catch {}
const scripts = new Set(Object.keys(pkg.scripts || {}));
for (const f of docs) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
    if (!scripts.has(m[1])) add('ghost-script', f, `npm run ${m[1]} 未定义`);
  }
}

// ── 4. 配置表 vs schema ───────────────────────────────────────────────────
const code = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const schemaBlock = code.match(/z\s*\.object\(\{([\s\S]*?)\n  \}\)/);
const schemaFields = schemaBlock
  ? [...schemaBlock[1].matchAll(/^\s{4}(\w+):\s*z\./gm)].map((m) => m[1])
  : [];
for (const f of docs) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  const table = text.match(/## Configuration[\s\S]*?(?=\n## )|## 配置[\s\S]*?(?=\n## )/);
  if (!table) continue;
  const listed = [...table[0].matchAll(/^\|\s*`(\w+)`\s*\|/gm)].map((m) => m[1]);
  if (listed.length === 0) continue;
  const missing = schemaFields.filter((x) => !listed.includes(x));
  if (missing.length) add('config-drift', f, `配置表缺字段: ${missing.join(', ')}`);
  const extra = listed.filter((x) => !schemaFields.includes(x));
  if (extra.length) add('config-drift', f, `配置表多了不存在的字段: ${extra.join(', ')}`);
}

// ── 5. 版本一致性 ─────────────────────────────────────────────────────────
const cl = docs.find((f) => basename(f) === 'CHANGELOG.md');
if (cl && pkg.version) {
  const text = readFileSync(join(ROOT, cl), 'utf8');
  const m = text.match(/^## \[([0-9.]+)\]/m);
  if (m && m[1] !== pkg.version) {
    add('version-drift', cl, `CHANGELOG 最新 ${m[1]} ≠ package.json ${pkg.version}`);
  }
}

// ── 6. 双语对称 ───────────────────────────────────────────────────────────
const pairs = [['README.md', 'README.zh.md'], ['SETUP.md', 'SETUP.zh.md'],
               ['REVERSE-PROXY.md', 'REVERSE-PROXY.zh.md']];
for (const [en, zh] of pairs) {
  if (!files.includes(en) || !files.includes(zh)) continue;
  const h = (f) => (readFileSync(join(ROOT, f), 'utf8').match(/^#{2,3} /gm) || []).length;
  const a = h(en), b = h(zh);
  if (Math.abs(a - b) > 2) add('bilingual-drift', en, `章节数 EN=${a} vs ZH=${b}，可能不对称`);
}

// ── 报表 ──────────────────────────────────────────────────────────────────
const LABEL = {
  'dead-link': '失效的内部链接',
  'ghost-path': '引用了不存在的路径',
  'ghost-script': '引用了未定义的 npm script',
  'config-drift': '配置表与代码 schema 不一致',
  'version-drift': '版本号不一致',
  'bilingual-drift': '中英文章节数差异较大',
};

console.log(`\n  文档漂移自查`);
console.log(`  文档 ${docs.length} 个 / 仓库文件 ${files.length} 个`);
console.log(`  发现 ${issues.length} 项\n`);

for (const kind of Object.keys(LABEL)) {
  const list = issues.filter((i) => i.kind === kind);
  if (!list.length) continue;
  console.log(`  ── ${LABEL[kind]} (${list.length})`);
  for (const i of list) console.log(`     ${i.file}\n        ${i.detail}`);
  console.log('');
}

console.log(issues.length === 0 ? '  ✅ 无漂移\n' : `  ⚠️  ${issues.length} 项待处理\n`);
process.exit(issues.length === 0 ? 0 : 1);
