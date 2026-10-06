// lib/cdp.mjs — 零依赖 CDP (Chrome DevTools Protocol) 客户端
//
// 用途：从运行中的 Tabbit 浏览器（--remote-debugging-port=9222）实时拉取
// 最新 cookie 和真实版本号，实现 tabbit2api 的 cookie 自动续期。
//
// 前提：Tabbit 需以调试模式启动：
//   open -a Tabbit --args --remote-debugging-port=9222
//
// 若浏览器没开或没带调试端口，`ensureBrowser` 可以按需把它拉起来 ——
// 见本文件末尾。
//
// 零依赖：使用 Node 22+ 内置 WebSocket 与全局 fetch。

import { spawn, execFileSync } from 'node:child_process';
import { config } from '../../src/config.mjs';
import { cookieDomains } from './tabbit.mjs';

const DEFAULT_PORT = 9222;
const DEFAULT_BASE = config.baseUrl || 'https://web.tabbit.ai';

// ─── 基础 CDP 工具 ─────────────────────────────────────────

// GET http://localhost:9222/json/list，返回 page target 列表
async function listTargets(port = DEFAULT_PORT) {
  const res = await fetch(`http://localhost:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list HTTP ${res.status}`);
  return res.json();
}

// 对某个 target 执行一条 CDP 命令（JSON-RPC over WebSocket）
function cdpCall(wsUrl, method, params = {}, timeoutMs = 8000) {
  if (typeof globalThis.WebSocket === 'undefined') {
    throw new Error('CDP 自动刷新需要 Node 22+（内置 WebSocket）。请在 Node 22+ 下运行，或在 .env 手动配置 TABBIT_COOKIE 关闭自动刷新');
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`CDP ${method} 超时`));
    }, timeoutMs);

    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket 连接失败: ${wsUrl}`));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(`CDP ${method} 错误: ${msg.error.message}`));
      else resolve(msg.result);
    };
  });
}

// 找到目标域的页面 target（优先 session 页，其次任意该域页面）
function findTabbitPage(targets, baseUrl = DEFAULT_BASE) {
  const host = new URL(baseUrl).hostname;
  const pages = targets.filter(t => t.type === 'page' && t.url.includes(host));
  if (pages.length === 0) return null;
  return pages.find(t => t.url.includes('/session/')) || pages[0];
}

// ─── 对外 API ──────────────────────────────────────────────

// 拉取目标域全部 cookie，返回拼接字符串；浏览器未开/未登录返回 null
export async function fetchTabbitCookies(port = DEFAULT_PORT, baseUrl = DEFAULT_BASE) {
  const targets = await listTargets(port);
  const page = findTabbitPage(targets, baseUrl);
  if (!page) {
    throw new Error(`浏览器未打开 ${baseUrl} 页面`);
  }
  const { cookies } = await cdpCall(page.webSocketDebuggerUrl, 'Network.getAllCookies');
  const domains = cookieDomains(baseUrl);
  const web = (cookies || []).filter(c => domains.includes(c.domain));
  if (web.length === 0) {
    throw new Error(`${baseUrl} 下无 cookie（可能未登录）`);
  }
  return {
    cookie: web.map(c => `${c.name}=${c.value}`).join('; '),
    count: web.length,
    token: (web.find(c => c.name === 'token') || {}).value || '',
  };
}

// 通过 chrome.tabInstance.getDeviceInfo() 获取真实版本号（如 1.9.22(10109022)）
export async function fetchTabbitVersion(port = DEFAULT_PORT, baseUrl = DEFAULT_BASE) {
  const targets = await listTargets(port);
  const page = findTabbitPage(targets, baseUrl);
  if (!page) throw new Error(`浏览器未打开 ${baseUrl} 页面`);

  const expr = `(async () => {
    try {
      const d = await chrome.tabInstance.getDeviceInfo();
      return d.tabbitVersion || '';
    } catch (e) { return ''; }
  })()`;
  const result = await cdpCall(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  return result?.result?.value || '';
}

// 一键刷新：拉 cookie + 版本号，浏览器不可用时抛错由调用方兜底
export async function refreshFromBrowser({ port = DEFAULT_PORT, baseUrl = DEFAULT_BASE } = {}) {
  const [cookieInfo, version] = await Promise.all([
    fetchTabbitCookies(port, baseUrl),
    fetchTabbitVersion(port, baseUrl).catch(() => ''),
  ]);
  return { cookie: cookieInfo.cookie, count: cookieInfo.count, version };
}

// ─── 浏览器按需拉起 ────────────────────────────────────────
//
// 背景：cookie 续期依赖 CDP，而 CDP 只在 Tabbit 以 --remote-debugging-port
// 启动时才存在。平时手动开的浏览器没有这个端口，于是续期永远失败
// （日志里的 "cookie 自动刷新失败: fetch failed" 就是这个）。
//
// 这里补上缺的那一环：cookie 失效时按需把浏览器带调试端口拉起来。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 探测 CDP 端点是否就绪。 */
async function probeCdp(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 找正在运行的 Tabbit 进程（Windows）。
 *
 * 用 `tasklist` 而不是 PowerShell：`execFileSync('powershell', ['-Command', '...'])`
 * 传参时 PowerShell 会吞掉内层引号，`Get-Process -Name 'Tabbit Browser'` 直接失败
 * （实测：同样的命令在 shell 里能跑，走 execFileSync 就报错）。tasklist 是纯可执行
 * 程序、参数逐项传递、输出 CSV —— 没有引号解析这层坑。
 *
 * @param imageNames - 候选映像名（含 .exe）。
 * @returns 进程 id 数组（去重）。
 */
function tabbitProcessIds(imageNames = ['Tabbit Browser.exe', 'Tabbit.exe']) {
  if (process.platform !== 'win32') return [];
  const ids = new Set();
  for (const image of imageNames) {
    try {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 15000, windowsHide: true,
      });
      // CSV 行形如: "Tabbit Browser.exe","5424","Console","1","123,456 K"
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"[^"]+","(\d+)"/);
        if (m) ids.add(Number(m[1]));
      }
    } catch {
      /* 该映像名没有匹配的进程时 tasklist 会输出提示文本并返回非零，忽略即可 */
    }
  }
  return [...ids];
}

/** 结束进程树（Tabbit 是多进程：主进程 + 渲染进程）。 */
function killProcessTree(ids, log) {
  for (const id of ids) {
    try {
      execFileSync('taskkill', ['/PID', String(id), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
      log(`已结束进程 ${id}`);
    } catch (e) {
      log(`结束进程 ${id} 失败: ${e.message}`);
    }
  }
}

/**
 * 确保调试端口上有一个 Tabbit 页面。
 *
 * 新启动的 Chromium 可能只开一个空白页，而 `fetchTabbitCookies` 需要目标域的
 * page target 才能执行 `Network.getAllCookies` —— 少这一步，浏览器起来了
 * 却仍然拉不到 cookie。
 *
 * @returns 是否已有可用页面。
 */
async function ensureTabbitTab(port, baseUrl, log) {
  try {
    if (findTabbitPage(await listTargets(port), baseUrl)) return true;
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    await cdpCall(version.webSocketDebuggerUrl, 'Target.createTarget', { url: baseUrl });
    log(`已打开页面 ${baseUrl}`);
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      if (findTabbitPage(await listTargets(port), baseUrl)) return true;
    }
    return false;
  } catch (e) {
    log(`打开 ${baseUrl} 页面失败: ${e.message}`);
    return false;
  }
}

/**
 * 用**短命 headless 实例**取一次 cookie，取完立刻杀掉。
 *
 * 为什么是这个形态（三条都实测过）：
 *
 *   1. **必须带 `--user-data-dir`**。直接 spawn Tabbit 可执行文件时它**不会**自己
 *      加这个参数（只有它自己的启动器会加）。不指定，headless 会落到一个空
 *      profile —— 页面能开，但 tabbit 域下 0 个 cookie（实测）。
 *
 *   2. **不能常驻**。headless 实例占着 profile 锁，用户之后双击图标会被转交给
 *      这个无界面实例，**屏幕上什么都不会出现**（实测可见窗口数 0）。用完即杀
 *      就没有这个问题（实测杀掉后用户打开 → 进程 15 / 窗口 1）。
 *
 *   3. **全程无窗口**。启动、取 cookie、退出整个过程可见窗口数都是 0，
 *      任务管理器里能看到进程。
 *
 * 顺带消掉了与其它浏览器插件（比如提供 `tabbit_browser` 的那个）的启动竞争：
 * 我们不长期占用 profile，谁先启动都无所谓。
 *
 * @param options.port - CDP 端口。
 * @param options.exe - Tabbit 可执行文件路径。
 * @param options.userDataDir - 真实用户 profile 目录。
 * @param options.baseUrl - 需要打开的站点。
 * @param options.timeoutMs - 启动后等待 CDP 就绪的最长时间。
 * @param options.log - 日志函数。
 * @returns `{ ok, cookie, count, version, action }`。
 */
export async function withEphemeralBrowser({
  port = DEFAULT_PORT,
  exe = '',
  userDataDir = '',
  baseUrl = DEFAULT_BASE,
  timeoutMs = 45000,
  log = () => {},
} = {}) {
  if (!exe) {
    log('未配置 Tabbit 可执行文件路径，无法用 headless 取 cookie');
    return { ok: false, action: 'no-exe' };
  }
  if (!userDataDir) {
    log('未配置 user-data-dir：headless 实例会落到空 profile，拿不到登录态');
    return { ok: false, action: 'no-user-data-dir' };
  }

  // 若已有实例在调试端口上（用户自己带端口启动的），直接用，不必再起一个
  if (await probeCdp(port)) {
    try {
      const { cookie, count, version } = await refreshFromBrowser({ port, baseUrl });
      if (cookie && cookie.includes('token=')) {
        return { ok: true, action: 'reused-existing', cookie, count, version };
      }
    } catch { /* 落到 headless */ }
  }

  const args = [
    '--headless=new',                 // 无窗口（实测可见窗口数 0）
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`, // 不带这个就拿不到登录态
  ];

  // ── 记账：spawn 之前已经存在的 Tabbit 进程 ──────────────────────────────
  //
  // ⚠️ 这里曾经是个会**杀掉用户浏览器**的 bug：清理时按映像名杀掉了所有
  // `Tabbit Browser.exe`，包括用户自己正开着的那一份。
  //
  // 触发路径：用户开着浏览器 → 我们 spawn 的 headless 实例因 Chromium 单实例
  // 被转交给用户实例、CDP 永远不会就绪 → 超时 → finally 里"清理" →
  // 把用户浏览器一起杀了。
  //
  // 修法：只杀**我们启动之后新出现**的进程。用户实例的 PID 在 spawn 前就记下了，
  // 永远不在击杀名单里。
  const preexisting = new Set(tabbitProcessIds(['Tabbit Browser.exe', 'Tabbit.exe']));
  if (preexisting.size > 0) {
    // 用户已经开着浏览器，而且 CDP 不可达（上面已探测过）——**别再试了**。
    //
    // Chromium 是单实例的：我们再 spawn 一个带 --headless 和同一个 profile 的进程，
    // 它会被转交给用户那个实例，调试端口永远不会出现。实测要白等满 45 秒才超时，
    // 期间用户什么也得不到。
    //
    // 直接如实返回，让调用方沿用旧 cookie——旧 cookie 通常还有效，模型照样能调。
    log(`Tabbit 已在运行（${preexisting.size} 个进程）但没有调试端口，无法从中读取 cookie；`
      + '不尝试新建实例（单实例会转交给已有实例，端口不会出现）。'
      + '如需续期，请先完全退出 Tabbit，或在网关 .env 里设 TABBIT_KILL_EXISTING_BROWSER=1 允许重启它。');
    return { ok: false, action: 'browser-running-without-cdp' };
  }

  log(`启动短命 headless 实例取 cookie（端口 ${port}）`);
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {
    log(`启动失败: ${e.message}`);
    return { ok: false, action: 'spawn-failed' };
  }

  const killIt = () => {
    try {
      const now = tabbitProcessIds(['Tabbit Browser.exe', 'Tabbit.exe']);
      const ours = now.filter((id) => !preexisting.has(id));
      if (ours.length === 0) {
        log('没有需要清理的实例（本次 spawn 未产生新进程）');
        return;
      }
      killProcessTree(ours, () => {});
      log(`已结束短命 headless 实例（${ours.length} 个进程）`);
    } catch { /* 尽力而为 */ }
  };

  try {
    const deadline = Date.now() + timeoutMs;
    let up = false;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (await probeCdp(port)) { up = true; break; }
    }
    if (!up) {
      log(`等待 CDP 就绪超时（${timeoutMs}ms）`);
      return { ok: false, action: 'launch-timeout' };
    }

    await ensureTabbitTab(port, baseUrl, log);

    // 页面刚建好时 cookie 未必已经挂上，重试几次
    let lastErr;
    for (let i = 0; i < 8; i++) {
      try {
        const { cookie, count, version } = await refreshFromBrowser({ port, baseUrl });
        if (cookie && cookie.includes('token=')) {
          return { ok: true, action: 'ephemeral', cookie, count, version };
        }
        lastErr = new Error('cookie 里没有 token');
      } catch (e) { lastErr = e; }
      await sleep(1500);
    }
    log(`短命实例取 cookie 失败: ${lastErr?.message ?? '未知'}`);
    return { ok: false, action: 'no-cookie' };
  } finally {
    killIt();   // 无论成功失败都杀，绝不留常驻实例
  }
}

/**
 * 确保 Tabbit 以调试端口运行；没开就把它拉起来。
 *
 * 三种情形：
 *   1. CDP 已就绪            → 直接返回
 *   2. 浏览器没开            → 以 --remote-debugging-port 启动
 *   3. 浏览器开着但没调试端口 → Chromium 单实例，新进程会复用旧实例、端口仍不通，
 *                              所以必须**先关掉**再启动（破坏性，需显式授权）
 *
 * @param options.port - CDP 端口。
 * @param options.exe - Tabbit 可执行文件路径。
 * @param options.baseUrl - 需要打开的站点。
 * @param options.timeoutMs - 启动后等待 CDP 就绪的最长时间。
 * @param options.killExisting - 是否允许关闭已在运行（无调试端口）的浏览器。
 * @param options.log - 日志函数。
 * @returns `{ ok, action }`。
 */
export async function ensureBrowser({
  port = DEFAULT_PORT,
  exe = '',
  baseUrl = DEFAULT_BASE,
  timeoutMs = 45000,
  killExisting = false,
  log = () => {},
} = {}) {
  if (await probeCdp(port)) return { ok: true, action: 'already-running' };
  if (!exe) {
    log('未配置 Tabbit 可执行文件路径，无法自动启动');
    return { ok: false, action: 'no-exe' };
  }

  const running = tabbitProcessIds();
  if (running.length > 0) {
    if (!killExisting) {
      log(`Tabbit 已在运行 (PID ${running.join(', ')}) 但未开启调试端口 ${port}；`
        + '需先关闭它才能以调试模式重启（browserKillExisting=false，跳过）');
      return { ok: false, action: 'running-without-cdp' };
    }
    log(`Tabbit 已在运行但未开启调试端口 ${port}，先关闭以便重启（PID ${running.join(', ')}）`);
    killProcessTree(running, log);
    await sleep(4000);
  }

  log(`以调试端口 ${port} 启动 Tabbit: ${exe}`);
  try {
    const child = spawn(exe, [`--remote-debugging-port=${port}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
  } catch (e) {
    log(`启动失败: ${e.message}`);
    return { ok: false, action: 'spawn-failed' };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (await probeCdp(port)) {
      const hasTab = await ensureTabbitTab(port, baseUrl, log);
      log(`CDP 就绪（页面${hasTab ? '可用' : '未就绪'}）`);
      return { ok: hasTab, action: hasTab ? 'launched' : 'launched-no-tab' };
    }
  }
  log(`等待 CDP 就绪超时（${timeoutMs}ms）`);
  return { ok: false, action: 'launch-timeout' };
}
