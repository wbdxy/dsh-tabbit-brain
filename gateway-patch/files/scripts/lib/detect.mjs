// lib/detect.mjs — 自动定位 Tabbit 的安装位置与用户 profile
//
// 为什么需要这个：把 exe 路径写死在配置里，只在写它那台机器上成立。开源分发时
// 每个用户的安装路径都不同，而且目录名可能是本地化的（中文系统的「下载」）。
//
// 做法：查 Windows 卸载注册表。关键是**不依赖 DisplayName 的字面值** ——
// Tabbit 的注册表项名是本地化的（中文系统上叫「Tabbit浏览器」），任何按英文名做
// 白名单的实现都会漏掉它。这里只要求名字里含 “tabbit”（大小写不敏感），然后从
// DisplayIcon / InstallLocation 里取可执行文件。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 名字里含 tabbit 即算候选（不依赖语言）。 */
function looksLikeTabbit(name) {
  return typeof name === 'string' && /tabbit/i.test(name);
}

/**
 * 扫 Windows 卸载注册表。
 * @returns `{ name, version, exe }` 候选列表；非 Windows 或找不到时为空数组。
 */
function detectWindowsInstallations() {
  if (process.platform !== 'win32') return [];

  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];

  const out = [];
  const seen = new Set();

  for (const root of roots) {
    for (const view of ['64', '32']) {
      let text;
      try {
        text = execFileSync('reg.exe', ['query', root, '/s', `/reg:${view}`], {
          encoding: 'utf8', timeout: 60000, windowsHide: true,
        });
      } catch {
        continue;   // 该根/视图不存在或无权访问
      }

      let rec = {};
      const commit = () => {
        if (!looksLikeTabbit(rec.DisplayName)) return;
        // DisplayIcon 常见形态：`"C:\path\app.exe,0"` —— 去掉图标索引与引号
        const icon = (rec.DisplayIcon || '')
          .replace(/,\s*-?\d+\s*$/, '')
          .replace(/^"(.*)"$/, '$1')
          .trim();
        const exe = /\.exe$/i.test(icon) ? icon : '';
        const candidate = exe || rec.InstallLocation || '';
        if (!candidate) return;
        const key = `${rec.DisplayVersion || ''}\0${candidate}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ name: rec.DisplayName, version: rec.DisplayVersion || '', exe: candidate });
      };

      for (const line of text.split(/\r?\n/)) {
        if (/^HKEY_/i.test(line.trim())) { commit(); rec = {}; continue; }
        const m = line.match(/^\s+(DisplayName|DisplayVersion|DisplayIcon|InstallLocation)\s+REG_\w+\s+(.*)$/i);
        if (m) rec[m[1]] = m[2].trim();
      }
      commit();
    }
  }
  return out;
}

/** macOS：扫 /Applications。 */
function detectMacInstallations() {
  if (process.platform !== 'darwin') return [];
  const candidates = [
    '/Applications/Tabbit Browser.app/Contents/MacOS/Tabbit Browser',
    '/Applications/Tabbit.app/Contents/MacOS/Tabbit',
  ];
  return candidates.filter(existsSync).map((exe) => ({ name: 'Tabbit', version: '', exe }));
}

/** 标准位置兜底（注册表缺失时的最后手段）。 */
function detectFallback() {
  if (process.platform !== 'win32') return [];
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [
    local && join(local, 'Programs', 'Tabbit Browser', 'Application', 'Tabbit Browser.exe'),
    join(pf, 'Tabbit Browser', 'Application', 'Tabbit Browser.exe'),
  ].filter(Boolean);
  return candidates.filter(existsSync).map((exe) => ({ name: 'Tabbit', version: '', exe }));
}

/** 全部探测方式合并去重（按可信度排序）。 */
export function detectInstallations() {
  const all = [...detectWindowsInstallations(), ...detectMacInstallations(), ...detectFallback()];
  const seen = new Set();
  return all.filter((x) => {
    if (!x.exe || seen.has(x.exe)) return false;
    seen.add(x.exe);
    return true;
  });
}

/**
 * 推断用户 profile 目录（cookie 所在的 user-data-dir）。
 *
 * 短命 headless 实例**必须**显式带这个参数：直接 spawn 浏览器可执行文件时它不会
 * 自己加（只有它自己的启动器会加），不指定就会落到空 profile、拿不到登录态。
 *
 * @returns 存在的 profile 目录；找不到返回空串。
 */
export function detectUserDataDir() {
  const local = process.env.LOCALAPPDATA || '';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    process.env.TABBIT_USER_DATA_DIR,
    local && join(local, 'Tabbit Browser', 'User Data'),
    home && join(home, 'Library', 'Application Support', 'Tabbit Browser'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return '';
}
