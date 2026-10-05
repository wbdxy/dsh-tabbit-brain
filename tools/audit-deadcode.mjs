#!/usr/bin/env node
// audit-deadcode.mjs — 死代码自查
//
// 查这些：
//   1. 导出了但没人用的符号
//   2. 文件存在但没人引用的孤儿文件
//   3. 库里残留的 console.log / debugger（应走 ctx.logger）
//   4. 未使用的 import
//   5. TODO / FIXME / XXX / HACK 遗留
//   6. 被注释掉的代码块（连续多行注释且像代码）
//   7. 空的或只含注释的函数
//
// 用法: node tools/audit-deadcode.mjs [目录]

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] || join(HERE, '..');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.py']);
const DOC_EXT = new Set(['.md', '.yml', '.yaml', '.json']);

function walk(dir, out = []) {
  let es;
  try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const all = walk(ROOT);
const codeFiles = all.filter((f) => CODE_EXT.has(extname(f).toLowerCase()));
const allText = new Map();
for (const f of all) {
  const ext = extname(f).toLowerCase();
  if (!CODE_EXT.has(ext) && !DOC_EXT.has(ext)) continue;
  try { allText.set(f, readFileSync(f, 'utf8')); } catch { /* 跳过 */ }
}

const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');
const findings = [];
const add = (kind, file, line, detail, level = 'warn') =>
  findings.push({ kind, file: rel(file), line, detail, level });

// ── 1. 导出了但没人用的符号 ──────────────────────────────────────────────────
const exportsFound = [];
for (const f of codeFiles) {
  const text = allText.get(f);
  if (!text) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) {
      exportsFound.push({ name: m[1], file: f, line: i + 1 });
    }
  }
}

// 入口文件（被 package.json main 或 scripts 引用的）不算孤儿
let pkg = {};
try { pkg = JSON.parse(allText.get(join(ROOT, 'package.json')) || '{}'); } catch { /* 忽略 */ }
const entryPoints = new Set([
  pkg.main && join(ROOT, pkg.main),
  ...(pkg.files || []).map((x) => join(ROOT, x)),
].filter(Boolean));

for (const ex of exportsFound) {
  const isEntry = entryPoints.has(ex.file) || basename(ex.file) === 'index.js';
  let used = 0;
  // 同文件内被引用也算已使用：导出给本文件另一个函数用是常见形态
  // （比如 cdp.mjs 导出 fetchTabbitCookies，被同文件的 refreshFromBrowser 调用）
  const own = allText.get(ex.file) || '';
  const ownHits = (own.match(new RegExp(`\\b${ex.name.replace(/\$/g, '\\$')}\\b`, 'g')) || []).length;
  if (ownHits > 1) used++;
  for (const [f, text] of allText) {
    if (f === ex.file) continue;
    if (new RegExp(`\\b${ex.name.replace(/\$/g, '\\$')}\\b`).test(text)) used++;
  }
  if (used === 0) {
    add('unused-export', ex.file, ex.line,
      `导出 \`${ex.name}\` 在项目其它地方没有被引用`,
      isEntry ? 'info' : 'warn');
  }
}

// ── 2. 孤儿文件 ──────────────────────────────────────────────────────────────
for (const f of all) {
  const r = rel(f);
  const base = basename(f);
  if (['package.json', 'LICENSE', 'CHANGELOG.md', '.gitignore'].includes(base)) continue;
  if (r.startsWith('gateway-patch/files/')) continue;   // 给别人覆盖用的，本来就没人 import
  if (r.startsWith('tools/') || r.startsWith('scripts/')) continue;  // 手动执行的 CLI，不是被 import 的
  if (!CODE_EXT.has(extname(f).toLowerCase())) continue;

  let referenced = false;
  for (const [g, text] of allText) {
    if (g === f) continue;
    if (text.includes(base) || text.includes(base.replace(/\.(mjs|js|cjs)$/, ''))) { referenced = true; break; }
  }
  if (!referenced) add('orphan-file', f, 1, `没有任何文件引用 ${r}`);
}

// ── 3. 库里残留的 console.* / debugger ───────────────────────────────────────
for (const f of codeFiles) {
  const text = allText.get(f);
  if (!text) continue;
  if (rel(f).startsWith('tools/') || rel(f).startsWith('scripts/')) continue;  // CLI 允许
  if (rel(f).startsWith('gateway-patch/')) continue;
  text.split('\n').forEach((l, i) => {
    if (/^\s*(console\.(log|debug|info|warn|error)|debugger)\b/.test(l)) {
      add('debug-output', f, i + 1, `库代码里的 ${l.trim().split('(')[0]}（应走 ctx.logger）`);
    }
  });
}

// ── 4. 未使用的 import ───────────────────────────────────────────────────────
for (const f of codeFiles) {
  const text = allText.get(f);
  if (!text) continue;
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const m = l.match(/^import\s+(?:([A-Za-z_$][\w$]*)|{([^}]+)})\s+from/);
    if (!m) return;
    const names = m[1] ? [m[1]] : m[2].split(',').map((x) => x.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
    for (const n of names) {
      const body = lines.filter((_, j) => j !== i).join('\n');
      if (!new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`).test(body)) {
        add('unused-import', f, i + 1, `import \`${n}\` 未被使用`);
      }
    }
  });
}

// ── 5. TODO / FIXME 遗留 ─────────────────────────────────────────────────────
for (const [f, text] of allText) {
  text.split('\n').forEach((l, i) => {
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(l) && !rel(f).startsWith('tools/')) {
      add('todo-leftover', f, i + 1, l.trim().slice(0, 90));
    }
  });
}

// ── 6. 注释掉的代码块 ────────────────────────────────────────────────────────
for (const f of codeFiles) {
  const text = allText.get(f);
  if (!text) continue;
  const lines = text.split('\n');
  let run = [];
  const flush = () => {
    if (run.length >= 3 && run.filter((l) => /[;{}()=]/.test(l)).length >= 3) {
      add('commented-code', f, run[0].n + 1, `${run.length} 行疑似注释掉的代码`);
    }
    run = [];
  };
  lines.forEach((l, i) => {
    if (/^\s*\/\/\s*\S/.test(l) && /[;{}()=]/.test(l)) run.push({ n: i, t: l });
    else flush();
  });
  flush();
}

// ── 7. 空函数体 ──────────────────────────────────────────────────────────────
for (const f of codeFiles) {
  const text = allText.get(f);
  if (!text) continue;
  text.split('\n').forEach((l, i) => {
    if (/\bfunction\s+\w+\s*\([^)]*\)\s*{\s*}\s*$/.test(l) || /=>\s*{\s*}\s*;?\s*$/.test(l)) {
      add('empty-function', f, i + 1, l.trim().slice(0, 80));
    }
  });
}

// ── 报表 ─────────────────────────────────────────────────────────────────────
const ORDER = ['unused-export', 'orphan-file', 'unused-import', 'debug-output',
               'todo-leftover', 'commented-code', 'empty-function'];
const LABEL = {
  'unused-export': '导出了但没人用',
  'orphan-file': '孤儿文件',
  'unused-import': '未使用的 import',
  'debug-output': '库里的 console/debugger',
  'todo-leftover': 'TODO/FIXME 遗留',
  'commented-code': '注释掉的代码',
  'empty-function': '空函数',
};

console.log(`\n  死代码自查: ${ROOT}`);
console.log(`  代码文件 ${codeFiles.length} 个 / 全部文本文件 ${allText.size} 个`);
console.log(`  发现 ${findings.length} 项\n`);

for (const kind of ORDER) {
  const list = findings.filter((x) => x.kind === kind);
  if (!list.length) continue;
  console.log(`${'─'.repeat(70)}\n  ${LABEL[kind]}  (${list.length})\n${'─'.repeat(70)}`);
  for (const x of list.slice(0, 15)) {
    console.log(`    ${x.level === 'info' ? 'ℹ' : '•'} ${x.file}:${x.line}`);
    console.log(`        ${x.detail}`);
  }
  if (list.length > 15) console.log(`    …（还有 ${list.length - 15} 项）`);
  console.log('');
}

const real = findings.filter((x) => x.level !== 'info');
console.log(`  ${real.length === 0 ? '✅ 无需要处理的项' : `⚠️  ${real.length} 项待确认（info 级可忽略）`}\n`);
