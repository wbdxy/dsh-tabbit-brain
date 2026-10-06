#!/usr/bin/env node
// scan-secrets.mjs — 发布前敏感信息扫描
//
// 覆盖业界 checklist 的六类 + 本项目特有的几类（个人路径、真实 cookie、本机用户名）。
// 用法：
//   node tools/scan-secrets.mjs            # 扫插件目录
//   node tools/scan-secrets.mjs <dir>      # 扫指定目录
//
// 退出码：0 = 干净，1 = 有命中

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] || join(HERE, '..');

// 跳过的目录
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);

// 只扫这些后缀
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.yml', '.yaml',
  '.txt', '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.py',
  '.rb', '.go', '.rs', '.toml', '.ini', '.cfg', '.conf',
  '.env', '.gitignore', '.example', '',
]);

/**
 * 规则表。每条 = { id, re, why, level }
 *   level: 'block' = 绝不能发布；'review' = 需要人工判断；'ok' = 已知安全的占位符
 */
const RULES = [
  // ── 1. 密钥 / token ──────────────────────────────────────────────────────
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    why: 'JWT（Tabbit cookie 里的 token 就长这样）', level: 'block' },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9]{20,}\b/g,
    why: 'OpenAI 风格 API key', level: 'block' },
  { id: 'api-key-assign', re: /(?:api[_-]?key|apikey|secret|passwd|password|token)\s*[:=]\s*["']?(?!\s*$|['"]?\s*[)}\]])[^\s"',;]{12,}/gi,
    why: '疑似硬编码的密钥赋值（12 字符以上）', level: 'review' },
  // 第三方内置常量（上游网关的 DEFAULT_SIGN_KEY）。它属于 Tabbit、不属于我们，
  // 而且随版本可能变化——写进文档只会制造会过期的事实。规则留着防止回潮。
  { id: 'upstream-sign-key', re: /f8d0e6a7[0-9a-f]{24}/g,
    why: '上游项目内置的签名 key 字面值（应改为指向代码位置，不写值）', level: 'block' },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    why: '私钥文件内容', level: 'block' },
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g, why: 'AWS Access Key', level: 'block' },
  { id: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, why: 'GitHub token', level: 'block' },

  // ── 2. 个人路径 / 主机 / IP ───────────────────────────────────────────────
  // 正斜杠和反斜杠都要覆盖 —— 配置里两种写法都常见
  // （YAML 里习惯用正斜杠，Windows 原生路径用反斜杠）
  { id: 'win-user-path', re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9_.-]+/g,
    why: 'Windows 个人目录路径（含用户名）', level: 'block' },
  { id: 'posix-home', re: /\/home\/[a-z][a-z0-9_-]{2,}/g, why: 'Linux 个人目录路径', level: 'block' },
  { id: 'mac-home', re: /\/Users\/[A-Za-z][A-Za-z0-9_.-]{2,}/g, why: 'macOS 个人目录路径', level: 'block' },
  { id: 'private-ip', re: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g,
    why: '内网 IP 地址', level: 'review' },
  { id: 'public-ip', re: /\b(?!10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|255\.)(?:\d{1,3}\.){3}\d{1,3}\b/g,
    why: '公网 IP 地址', level: 'review' },
  { id: 'hostname', re: /\b[a-z0-9][a-z0-9-]{2,}\.(?:internal|corp|local|lan)\b/gi,
    why: '内部主机名', level: 'review' },

  // ── 3. 身份信息 ──────────────────────────────────────────────────────────
  { id: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    why: '邮箱地址', level: 'review' },
  { id: 'cn-mobile', re: /\b1[3-9]\d{9}\b/g, why: '中国大陆手机号', level: 'block' },
  { id: 'cn-id', re: /\b\d{17}[\dXx]\b/g, why: '身份证号', level: 'block' },

  // ── 4. 内部系统 / URL ────────────────────────────────────────────────────
  { id: 'internal-url', re: /https?:\/\/[a-z0-9.-]*(?:intranet|internal|corp|jenkins|gitlab|jira|confluence)[a-z0-9.-]*/gi,
    why: '内部系统 URL', level: 'review' },
  { id: 'localhost', re: /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/g,
    why: '本地地址（本项目的默认配置，通常可接受）', level: 'ok' },

  // ── 5. 本项目特有的占位符（已知安全，提醒别忘了替换）──────────────────────
  { id: 'owner-placeholder', re: /\bOWNER\b/g,
    why: 'GitHub 用户名占位符 —— **发布前必须替换**', level: 'block' },
  { id: 'your-placeholder', re: /<你的[^>]*>|<your[- ][^>]*>|<YOUR_[A-Z_]+>/g,
    why: '文档占位符（文档里是有意的，代码里不是）', level: 'review' },

  // ── 6. 明显不该出现的东西 ────────────────────────────────────────────────
  { id: 'todo-secret', re: /\b(?:TODO|FIXME|XXX)\b.*(?:secret|key|token|password)/gi,
    why: '带密钥字样的 TODO', level: 'review' },
  { id: 'cookie-blob', re: /TABBIT_COOKIE\s*=\s*[^\s#]{40,}/g,
    why: '真实 cookie 值（非空）', level: 'block' },
  { id: 'sign-key', re: /TABBIT_SIGN_KEY\s*=\s*[^\s#]{8,}/g,
    why: '真实签名 key', level: 'block' },
];

// ─── 扫描 ────────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      if (!TEXT_EXT.has(ext) && e.name !== '.gitignore' && e.name !== '.env.example') continue;
      try { if (statSync(p).size > 5 * 1024 * 1024) continue; } catch { continue; }
      out.push(p);
    }
  }
  return out;
}

const files = walk(ROOT);
const hits = [];

for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        hits.push({
          rule: rule.id,
          level: rule.level,
          why: rule.why,
          file: relative(ROOT, f).replace(/\\/g, '/'),
          line: i + 1,
          sample: m[0].slice(0, 80),
        });
        if (m[0].length === 0) break;
        if (!rule.re.global) break;
      }
    }
  }
}

// ─── 报表 ────────────────────────────────────────────────────────────────────

const byLevel = (lv) => hits.filter((h) => h.level === lv);
const block = byLevel('block');
const review = byLevel('review');
const okHits = byLevel('ok');

console.log(`\n  扫描范围: ${ROOT}`);
console.log(`  文件数  : ${files.length}`);
console.log(`  命中    : ${hits.length}（block ${block.length} / review ${review.length} / ok ${okHits.length}）`);

if (block.length) {
  console.log(`\n${'═'.repeat(70)}\n  🚫 阻断级 —— 发布前必须处理\n${'═'.repeat(70)}`);
  const byRule = {};
  for (const h of block) (byRule[h.rule] ||= []).push(h);
  for (const [rule, list] of Object.entries(byRule)) {
    console.log(`\n  [${rule}] ${list[0].why}  —— ${list.length} 处`);
    for (const h of list.slice(0, 12)) {
      console.log(`    ${h.file}:${h.line}`);
      console.log(`      → ${h.sample}`);
    }
    if (list.length > 12) console.log(`    …（还有 ${list.length - 12} 处）`);
  }
}

if (review.length) {
  console.log(`\n${'═'.repeat(70)}\n  ⚠️  需人工判断\n${'═'.repeat(70)}`);
  const byRule = {};
  for (const h of review) (byRule[h.rule] ||= []).push(h);
  for (const [rule, list] of Object.entries(byRule)) {
    console.log(`\n  [${rule}] ${list[0].why}  —— ${list.length} 处`);
    for (const h of list.slice(0, 6)) {
      console.log(`    ${h.file}:${h.line}  → ${h.sample}`);
    }
    if (list.length > 6) console.log(`    …（还有 ${list.length - 6} 处）`);
  }
}

if (okHits.length) {
  console.log(`\n  ℹ 已知安全（${okHits.length} 处）: ${[...new Set(okHits.map((h) => h.rule))].join(', ')}`);
}

console.log('');
if (block.length === 0) {
  console.log('  ✅ 无阻断级命中\n');
  process.exit(0);
} else {
  console.log(`  ❌ 有 ${block.length} 处阻断级命中，处理后再发布\n`);
  process.exit(1);
}
