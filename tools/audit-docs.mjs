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
