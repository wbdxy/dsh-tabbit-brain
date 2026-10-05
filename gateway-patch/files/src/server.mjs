// src/server.mjs — OpenAI 兼容代理服务（原生 http，零依赖）
//
// 端点：
//   GET  /v1/models            模型列表（OpenAI 格式）
//   POST /v1/chat/completions  聊天补全（支持 stream / 非 stream）
//   GET  /healthz              健康检查
//   POST /admin/refresh-cookie 手动触发 cookie 自动刷新（从本机 Tabbit 浏览器拉取）
//
// 附加功能（可选，env 开关 TABBIT_AUTO_CHECKIN=1 控制）：
//   每日自动签到 —— 随本代理启动，启动即签到一次，之后每日 00:00:30 循环；
//   独立于代理请求链路，不影响 LLM 代理功能。核心逻辑见 scripts/lib/checkin.mjs。
//
// Cookie 自动续期：
//   - 启动时若本机 Tabbit 以 --remote-debugging-port 运行，自动从浏览器拉取最新 cookie
//   - 每 COOKIE_REFRESH_MINUTES（默认 360）分钟后台刷新一次
//   - 请求遇 401/403/492/493 等认证类错误时，立即刷新并重试一次
//   - 刷新成功后同步写回 .env，浏览器关闭时也能用最近一次有效 cookie
//
// 用法：
//   node src/server.mjs
//   curl http://localhost:8787/v1/chat/completions -d '{"model":"Default","messages":[{"role":"user","content":"你好"}],"stream":true}'

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, dirname } from 'node:path';
import { config } from './config.mjs';
import {
  DEFAULT_SIGN_KEY, fetchSignKey, getModels, fetchSessionList, chat, TabbitError,
  uploadImage, imageReference, mentionChip,
} from '../scripts/lib/tabbit.mjs';
import { refreshFromBrowser, withEphemeralBrowser } from '../scripts/lib/cdp.mjs';
import { startAutoCheckin } from '../scripts/lib/checkin.mjs';

// ─── 状态缓存 ─────────────────────────────────────────────
let signKey = config.signKey || DEFAULT_SIGN_KEY;
let signKeyFetchedAt = 0;
let sessionCache = null;
let sessionCacheAt = 0;

// Cookie / 版本号运行时状态（支持自动刷新，不再只读 .env）
let cookie = config.cookie;
let version = config.version;
let lastCookieRefresh = 0;
let cookieRefreshInFlight = null;   // 防止并发刷新

const SIGN_KEY_TTL = 10 * 60 * 1000;  // 10 分钟刷新一次签名 key
const SESSION_TTL = 5 * 60 * 1000;    // 5 分钟刷新一次会话列表
const COOKIE_REFRESH_MS = config.cookieRefreshMinutes * 60 * 1000;

// ─── Cookie 自动刷新 ──────────────────────────────────────
// 从本机 Tabbit 浏览器（CDP）拉取最新 cookie + 版本号，写回内存与 .env
async function refreshCookieFromBrowser(force = false) {
  if (cookieRefreshInFlight) return cookieRefreshInFlight;
  if (!force && cookie && Date.now() - lastCookieRefresh < COOKIE_REFRESH_MS) return cookie;

  cookieRefreshInFlight = (async () => {
    try {
      // 快路径：调试端口上已有实例（用户自己带端口启动的），直接读
      return await pullCookieOnce();
    } catch (e) {
      if (!config.browserAutoLaunch) {
        log(`cookie 自动刷新失败: ${e.message}（设置 TABBIT_EXE + TABBIT_AUTO_LAUNCH_BROWSER=1 `
          + '可让服务用短命 headless 实例自动取 cookie）');
        return cookie;
      }

      // 慢路径：起一个**短命 headless 实例**取 cookie，取完立刻杀掉。
      // 不用常驻实例是有原因的——headless 占着 profile 锁，用户之后双击图标会被
      // 转交给这个无界面实例，屏幕上什么都不会出现（实测可见窗口数 0）。
      // 短命就没这个问题，而且全程无窗口（实测启动/取/退出各阶段窗口数都是 0）。
      log(`cookie 自动刷新失败: ${e.message}；改用短命 headless 实例取 cookie…`);
      const r = await withEphemeralBrowser({
        port: config.cdpPort,
        exe: config.browserExe,
        userDataDir: config.browserUserDataDir,
        baseUrl: config.baseUrl,
        timeoutMs: config.browserLaunchTimeoutMs,
        log: (m) => log(`[headless] ${m}`),
      });
      if (!r.ok) {
        log(`短命 headless 取 cookie 失败 (${r.action})，本次沿用旧 cookie`);
        return cookie;
      }
      // 实例已经被杀，直接采用它取到的值
      cookie = r.cookie;
      if (r.version && r.version !== version) {
        log(`版本号更新: ${version} → ${r.version}`);
        version = r.version;
      }
      lastCookieRefresh = Date.now();
      persistEnv();
      log(`cookie 已自动刷新 (${r.count} 个, 长度 ${cookie.length}, 版本 ${version}) [${r.action}]`);
      return cookie;
    } finally {
      cookieRefreshInFlight = null;
    }
  })();
  return cookieRefreshInFlight;
}

/** 从浏览器拉一次 cookie 并写回内存 + env 文件；失败抛错由调用方兜底。 */
async function pullCookieOnce() {
  const { cookie: fresh, count, version: freshVersion } = await refreshFromBrowser({
    port: config.cdpPort,
    baseUrl: config.baseUrl,
  });
  if (!fresh) throw new Error('浏览器返回空 cookie');
  cookie = fresh;
  if (freshVersion && freshVersion !== version) {
    log(`版本号更新: ${version} → ${freshVersion}`);
    version = freshVersion;
  }
  lastCookieRefresh = Date.now();
  persistEnv();
  log(`cookie 已自动刷新 (${count} 个, 长度 ${cookie.length}, 版本 ${version})`);
  return cookie;
}

// 把最新 cookie / 版本号持久化到当前实例的 env 文件（默认 .env，可用 TABBIT_ENV 指定），
// 浏览器关闭后重启服务仍可用
function persistEnv() {
  try {
    // isAbsolute 兼容 TABBIT_ENV 传入绝对路径(如 /etc/x.env 或 D:\x.env)；
    // 相对路径仍按 server.mjs 所在目录回退到项目根
    const envPath = isAbsolute(config.envFile)
      ? config.envFile
      : fileURLToPath(new URL('../' + config.envFile, import.meta.url));
    let content = readFileSync(envPath, 'utf8');
    // 函数替换:避免 cookie/version 含 $&/$1/$' 时被 String.replace 当作匹配模式
    content = content.replace(/^TABBIT_COOKIE=.*$/m, () => `TABBIT_COOKIE=${cookie}`);
    content = content.replace(/^TABBIT_VERSION=.*$/m, () => `TABBIT_VERSION=${version}`);
    writeFileSync(envPath, content);
  } catch (e) {
    log('写回', config.envFile, '失败:', e.message);
  }
}

// 判断错误是否由 cookie/版本失效引起，需要刷新
function isAuthError(e) {
  if (e instanceof TabbitError) {
    return [401, 403, 492, 493].includes(e.status) || [401, 403, 492, 493].includes(e.code);
  }
  return false;
}

async function ensureSignKey() {
  if (config.signKey) return config.signKey;
  if (!signKey || Date.now() - signKeyFetchedAt > SIGN_KEY_TTL) {
    signKey = await fetchSignKey(cookie, version);
    signKeyFetchedAt = Date.now();
    log(`signKey 刷新: ${signKey.slice(0, 8)}…`);
  }
  return signKey;
}

async function getSessionId() {
  if (sessionCache && Date.now() - sessionCacheAt < SESSION_TTL) return sessionCache;
  const sessions = await fetchSessionList(cookie);
  if (sessions.length === 0) {
    throw new Error('账号下无可用会话，请先在 Tabbit 浏览器里创建一个对话');
  }
  sessionCache = sessions[0];
  sessionCacheAt = Date.now();
  log(`会话缓存: ${sessionCache.slice(0, 8)}… (共 ${sessions.length} 个)`);
  return sessionCache;
}

function invalidateSession() {
  sessionCache = null;
}

// ─── 工具函数 ─────────────────────────────────────────────
function log(...a) { console.log('[server]', ...a); }

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!config.apiKey) return true;
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${config.apiKey}`;
}

// OpenAI messages 数组 → Tabbit content 字符串
// 策略：把完整对话历史拼成带角色标注的文本，作为单条 content 发给 Tabbit
// （Tabbit 是会话制，但无状态代理不维护跨请求上下文，故自带历史进 content）
const MAX_CONTENT_CHARS = 19000;        // Tabbit caps input at ~20500 chars
const MAX_LATEST_USER_CHARS = 12000;    // cap for the latest user message

// 多模态内容归一化：OpenAI 的 content 既可以是字符串，也可以是 parts 数组
//   [{type:'text',text:'...'}, {type:'image_url',image_url:{url:'data:image/png;base64,...'}}]
// 旧实现直接 String(content)，数组会变成 "[object Object]" —— 图片全丢。
function normalizeContent(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (Array.isArray(content)) {
    let text = '';
    const images = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') text += part.text;
      else if (part.type === 'image_url') {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (url) images.push(String(url));
      }
    }
    return { text, images };
  }
  return { text: String(content ?? ''), images: [] };
}

const MAX_IMAGES = 4;                    // 单次请求最多带几张图
const MAX_IMAGE_CHARS = 6000000;         // data URI 超过这个长度就丢弃（约 4.5MB 原图）

// data:image/png;base64,xxxx -> { bytes, contentType, filename }
function decodeImage(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(dataUrl));
  if (!m) throw new Error('不是可识别的 data URI');
  const contentType = m[1] || 'image/png';
  const isB64 = Boolean(m[2]);
  const bytes = isB64
    ? Buffer.from(m[3], 'base64')
    : Buffer.from(decodeURIComponent(m[3]), 'binary');
  const ext = (contentType.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return { bytes, contentType, filename: `image.${ext}` };
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 返回 { content, images }：content 是纯文本，images 是图片 URL 列表
function messagesToContent(messages) {
  const valid = messages
    .filter((m) => m && m.content != null)
    .map((m) => ({ role: m.role, ...normalizeContent(m.content) }));
  if (valid.length === 0) throw new Error('messages is empty');

  // 图片只取最后一条 user 消息里的（历史图重传代价高、收益低）
  let images = [];
  for (let i = valid.length - 1; i >= 0; i--) {
    if (valid[i].role === 'user') {
      images = valid[i].images.slice(0, MAX_IMAGES).filter((u) => u.length <= MAX_IMAGE_CHARS);
      const dropped = valid[i].images.length - images.length;
      if (dropped > 0) log(`[media] 丢弃 ${dropped} 张超限/超量的图片`);
      break;
    }
  }

  const rebuild = (list) => {
    if (list.length === 1) return list[0].text;
    const lbl = { assistant: 'Assistant', system: 'System', user: 'User' };
    return list.map((m) => `[${lbl[m.role] || 'User'}]\n${m.text}`).join('\n\n');
  };

  const joined = rebuild(valid);
  if (joined.length <= MAX_CONTENT_CHARS) return { content: joined, images };

  // Over budget: Tabbit returns 492 (browser-gate text) beyond ~20500 chars.
  // Priority: latest user message > system head > recent history.
  let lastUserIdx = valid.length - 1;
  for (let i = valid.length - 1; i >= 0; i--) {
    if (valid[i].role === 'user') { lastUserIdx = i; break; }
  }

  const lastUser = String(valid[lastUserIdx].text).slice(0, MAX_LATEST_USER_CHARS);
  const systemText = valid
    .filter((m) => m.role === 'system')
    .map((m) => String(m.text))
    .join('\n\n');
  const history = valid.filter((m, i) => i !== lastUserIdx && m.role !== 'system');

  let budget = MAX_CONTENT_CHARS - lastUser.length - 120;
  const sysPart = systemText
    ? systemText.slice(0, Math.min(systemText.length, Math.max(0, Math.floor(budget * (history.length > 0 ? 0.8 : 1)))))
    : '';
  budget -= sysPart.length;

  const keptHistory = [];
  for (let i = history.length - 1; i >= 0 && budget > 0; i--) {
    const text = String(history[i].text);
    if (text.length > budget) break;
    keptHistory.unshift(history[i]);
    budget -= text.length + 12;
  }

  const lbl = { assistant: 'Assistant', system: 'System', user: 'User' };
  const parts = [];
  if (sysPart) parts.push('[System]\n' + sysPart);
  for (const m of keptHistory) parts.push(`[${lbl[m.role] || 'User'}]\n${m.text}`);
  parts.push('[User]\n' + lastUser);

  let out = parts.join('\n\n');
  if (out.length > MAX_CONTENT_CHARS) out = out.slice(0, MAX_CONTENT_CHARS);
  log('[prompt-budget] trimmed ' + joined.length + ' -> ' + out.length + ' chars (Tabbit limit ~20500)');
  return { content: out, images };
}

// ─── 路由处理 ─────────────────────────────────────────────

// GET /v1/models
// 白名单：只暴露用户指定的模型（其余模型 Tabbit 侧仍存在，但不对外列出）
// 每个模型额外暴露一个 `-task` 变体，用于切换到 Tabbit 的「任务」工作模式。
const ALLOWED_MODEL_NAMES = new Set(['DeepSeek-V4.1-Flash', 'MiniMax-M3', 'GLM-5.3']);
const TASK_SUFFIX = '-task';

// 模型名后缀 -task → agent_mode: true（Tabbit 任务模式）
function parseModelId(modelId) {
  const raw = String(modelId || '');
  if (raw.endsWith(TASK_SUFFIX)) {
    return { baseModel: raw.slice(0, -TASK_SUFFIX.length), agentMode: true };
  }
  return { baseModel: raw, agentMode: false };
}

async function handleModels(res) {
  const key = await ensureSignKey();
  const models = await getModels(cookie, version, key);
  const data = [];
  for (const m of models) {
    if (!ALLOWED_MODEL_NAMES.has(m.display_name)) continue;
    // 只暴露问答模式。任务模式（-task）实测与问答无差别，且其唯一差异
    // （browser_task_tool）在本桥下返回空结果，故不再对外列出。
    // parseModelId 仍保留：日后想启用，把下面这行加回来即可。
    // data.push({ id: m.display_name + TASK_SUFFIX, object: 'model', owned_by: 'tabbit' });
    data.push({ id: m.display_name, object: 'model', owned_by: 'tabbit' });
  }
  sendJson(res, 200, { object: 'list', data });
}

// GET /healthz
async function handleHealth(res) {
  try {
    const key = await ensureSignKey();
    const sessions = await fetchSessionList(cookie);
    sendJson(res, 200, {
      ok: true,
      version,
      signKey: key.slice(0, 8) + '…',
      sessions: sessions.length,
      cookieAutoRefresh: config.cdpPort ? 'on' : 'off',
      lastCookieRefresh: lastCookieRefresh ? new Date(lastCookieRefresh).toISOString() : null,
    });
  } catch (e) {
    sendJson(res, 503, { ok: false, error: e.message });
  }
}

// POST /admin/refresh-cookie — 手动触发 cookie 刷新（幂等）
async function handleRefreshCookie(res) {
  await refreshCookieFromBrowser(true);
  sendJson(res, 200, {
    ok: true,
    cookieLength: cookie.length,
    version,
    lastCookieRefresh: lastCookieRefresh ? new Date(lastCookieRefresh).toISOString() : null,
  });
}

// ─── 生成物落盘 ───────────────────────────────────────────
// Tabbit 的 `show_widget` 工具把产物放在 tool_call 的 widget_code 参数里，
// 而不是 message_chunk 文本里。DASH/DSH 这类纯文本客户端因此看不到任何东西。
// 这里把 widget_code 落盘成 .svg / .html，并把路径追加进回复文本，
// 让生成物真正交付到客户端手上。
const WIDGETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'widgets');

function slugifyName(text, maxLen = 40) {
  const cleaned = String(text || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (cleaned || 'widget').slice(0, maxLen);
}

function saveWidget(widgetCode, title) {
  const code = String(widgetCode || '');
  if (!code.trim()) return null;
  try {
    mkdirSync(WIDGETS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const ext = /^\s*<svg[\s>]/i.test(code) ? 'svg' : 'html';
    const label = title || (ext === 'svg' ? 'svg-widget' : 'widget');
    const file = join(WIDGETS_DIR, `${stamp}-${slugifyName(label)}.${ext}`);
    const body = ext === 'svg'
      ? code
      : `<!doctype html>\n<meta charset="utf-8">\n<title>${label}</title>\n${code}\n`;
    writeFileSync(file, body, 'utf8');
    log(`[widget] 已保存 ${ext.toUpperCase()} -> ${file}`);
    return { file, title: label };
  } catch (e) {
    log('[widget] 落盘失败:', e.message);
    return null;
  }
}

// 把已保存的生成物写进回复文本（客户端拿不到侧信道，只能走文本）
function widgetFooter(saved) {
  if (!saved || !saved.length) return '';
  const lines = saved.map((w) => `  - ${w.title}  ->  ${w.file}`);
  return `\n\n---\n[Tabbit 生成了 ${saved.length} 个可视化组件，已保存为本机文件]\n${lines.join('\n')}\n`;
}

// POST /v1/chat/completions
async function handleChat(req, res, rawBody) {
  let body;
  try { body = JSON.parse(rawBody); }
  catch { return sendJson(res, 400, { error: { message: 'invalid JSON body' } }); }

  const { model = 'Default', messages, stream = false } = body;
  if (!Array.isArray(messages) || !messages.length) {
    return sendJson(res, 400, { error: { message: 'messages is required and must be non-empty array' } });
  }

  // 模型名带 -task 后缀 → 走 Tabbit「任务」模式（agent_mode: true）
  const { baseModel, agentMode } = parseModelId(model);
  log(`[mode] requested=${model} base=${baseModel} agentMode=${agentMode} stream=${stream}`);

  let key, sessionId, content, images = [], references = [], htmlContent;
  try {
    [key, sessionId] = await Promise.all([ensureSignKey(), getSessionId()]);
    ({ content, images } = messagesToContent(messages));
  } catch (e) {
    return sendJson(res, 502, { error: { message: 'prepare failed: ' + e.message } });
  }

  // 图片：上传到 Tabbit 的 COS，再以 @提及引用（references + mention chip）带给模型。
  // 实测把 <img> 塞进 html_content 是无效的——模型收不到像素。
  if (images.length) {
    const chips = [];
    for (const dataUrl of images) {
      try {
        const { bytes, contentType, filename } = decodeImage(dataUrl);
        const up = await uploadImage({
          cookie, version, signKey: key, bytes, filename, contentType, sessionId,
        });
        const ref = imageReference({ fileId: up.fileId, downloadUrl: up.downloadUrl, filename });
        references.push(ref);
        chips.push(mentionChip(ref, filename));
        log(`[media] 已上传 ${filename} (${bytes.length}B) -> file_id=${up.fileId}`);
      } catch (e) {
        log(`[media] 图片上传失败: ${e.message}`);
      }
    }
    if (references.length) {
      htmlContent = `<p>${escapeHtml(content)}</p>${chips.join('')}`;
    }
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // 生成物采集：包一层，拦截 tool_finish 里的 show_widget 产出并落盘。
  // 所有 chat() 调用都改走 tapped()，四处调用点共用同一套采集逻辑。
  const savedWidgets = [];
  async function* tapped(opts) {
    for await (const ev of chat(opts)) {
      if (ev.event === 'tool_finish') {
        const d = ev.data;
        const first = Array.isArray(d?.results) ? d.results[0] : null;
        if (d?.tool_call_name === 'show_widget' && first?.widget_code) {
          const saved = saveWidget(first.widget_code, first.title);
          if (saved && !savedWidgets.some((w) => w.file === saved.file)) savedWidgets.push(saved);
        }
      }
      yield ev;
    }
  }

  // ─── 非流式：聚合所有 chunk ───
  if (!stream) {
    let full = '';
    try {
      for await (const ev of tapped({ cookie, version, signKey: key, sessionId, model: baseModel, agentMode, content, references, htmlContent })) {
        if (ev.event === 'message_chunk' && ev.data?.content) {
          full += ev.data.content;
        } else if (ev.event === 'error') {
          invalidateSession();
          // 认证类错误 → 自动刷新 cookie 后重试一次
          if (isAuthError(new TabbitError(ev.data?.code || 0, ev.data?.message || ''))) {
            log('检测到认证错误，刷新 cookie 后重试…');
            await refreshCookieFromBrowser(true);
            key = await ensureSignKey();
            sessionId = await getSessionId();
            full = '';
            for await (const ev2 of tapped({ cookie, version, signKey: key, sessionId, model: baseModel, agentMode, content, references, htmlContent })) {
              if (ev2.event === 'message_chunk' && ev2.data?.content) full += ev2.data.content;
              else if (ev2.event === 'error') {
                invalidateSession();
                return sendJson(res, 502, { error: { message: ev2.data?.message || 'Tabbit error', code: ev2.data?.code } });
              }
            }
          } else {
            return sendJson(res, 502, { error: { message: ev.data?.message || 'Tabbit error', code: ev.data?.code } });
          }
        }
      }
    } catch (e) {
      if (e instanceof TabbitError) invalidateSession();
      // fetch 级认证错误同样触发刷新重试
      if (isAuthError(e)) {
        log('检测到认证错误（fetch），刷新 cookie 后重试…');
        await refreshCookieFromBrowser(true);
        try {
          key = await ensureSignKey();
          sessionId = await getSessionId();
          full = '';
          for await (const ev of tapped({ cookie, version, signKey: key, sessionId, model: baseModel, agentMode, content, references, htmlContent })) {
            if (ev.event === 'message_chunk' && ev.data?.content) full += ev.data.content;
            else if (ev.event === 'error') { invalidateSession(); return sendJson(res, 502, { error: { message: ev.data?.message || 'Tabbit error', code: ev.data?.code } }); }
          }
        } catch (e2) {
          return sendJson(res, 502, { error: { message: e2.message } });
        }
      } else {
        return sendJson(res, 502, { error: { message: e.message } });
      }
    }
    const footer = widgetFooter(savedWidgets);
    if (footer) full += footer;

    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: full },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // ─── 流式：SSE 转 OpenAI chunk ───
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // 客户端断开时中止上游请求
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const sendChunk = (delta, finishReason = null) =>
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);

  // 首块：role
  sendChunk({ role: 'assistant' });

  try {
    for await (const ev of tapped({ cookie, version, signKey: key, sessionId, model: baseModel, agentMode, content, references, htmlContent, signal: ac.signal })) {
      if (ev.event === 'message_chunk' && ev.data?.content) {
        sendChunk({ content: ev.data.content });
      } else if (ev.event === 'error') {
        invalidateSession();
        if (isAuthError(new TabbitError(ev.data?.code || 0, ev.data?.message || ''))) {
          log('检测到认证错误，后台刷新 cookie…（下一次请求生效）');
          await refreshCookieFromBrowser(true);
        }
        res.write(`data: ${JSON.stringify({ error: { message: ev.data?.message || 'Tabbit error', code: ev.data?.code } })}\n\n`);
        break;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      if (e instanceof TabbitError) invalidateSession();
      if (isAuthError(e)) {
        log('检测到认证错误（fetch），后台刷新 cookie…');
        await refreshCookieFromBrowser(true);
      }
      res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
    }
  }
  const footer = widgetFooter(savedWidgets);
  if (footer) sendChunk({ content: footer });
  sendChunk({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}

// ─── HTTP 服务 ────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (!checkAuth(req)) {
    return sendJson(res, 401, { error: { message: 'invalid API key', type: 'invalid_request_error' } });
  }

  try {
    if (path === '/v1/models' && req.method === 'GET') return await handleModels(res);
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const raw = await readBody(req);
      return await handleChat(req, res, raw);
    }
    if (path === '/healthz' && req.method === 'GET') return await handleHealth(res);
    if (path === '/admin/refresh-cookie' && req.method === 'POST') return await handleRefreshCookie(res);
    sendJson(res, 404, { error: { message: `not found: ${req.method} ${path}` } });
  } catch (e) {
    log('error:', e);
    if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
    else res.end();
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Tabbit2API · OpenAI 兼容代理');
  console.log(`  端口: ${config.port}`);
  console.log(`  鉴权: ${config.apiKey ? '已开启 (Bearer ' + config.apiKey.slice(0, 4) + '…)' : '未开启'}`);
  console.log(`  版本: ${version}`);
  console.log(`  Cookie自动刷新: ${cookie ? '开' : '开（启动时从浏览器拉取）'} (CDP :${config.cdpPort}, 每 ${config.cookieRefreshMinutes} 分钟)`);
  console.log(`  每日自动签到: ${config.autoCheckin ? '开（启动即签，每日 00:00:30 循环）' : '关（env 设 TABBIT_AUTO_CHECKIN=1 开启）'}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log('  GET  /v1/models             模型列表');
  console.log('  POST /v1/chat/completions   聊天补全 (stream / 非 stream)');
  console.log('  GET  /healthz               健康检查');
  console.log('  POST /admin/refresh-cookie  手动刷新 cookie');
  console.log('═══════════════════════════════════════════════════════════\n');
});

// ─── 启动与定时刷新 ────────────────────────────────────────
// 启动时从浏览器拉一次最新 cookie（幂等：失败则用 .env 中的值）
refreshCookieFromBrowser(true);
// 定时后台刷新（COOKIE_REFRESH_MINUTES，默认 6 小时）
setInterval(() => refreshCookieFromBrowser(), COOKIE_REFRESH_MS).unref();

// 附加功能：每日自动签到（env 开关 TABBIT_AUTO_CHECKIN=1 控制；独立于代理请求链路）
// 只签本实例的 profile（env 文件对应的版本），启动即签，之后每日 00:00:30 循环。
if (config.autoCheckin) {
  const envFile = config.envFile; // 当前实例的 env 文件（.env 或 .env.domestic）
  const profileName = envFile === '.env' ? 'intl' : envFile.replace(/^\.env\.?/, '') || 'default';
  startAutoCheckin({
    name: profileName,
    envFile,
    base: config.baseUrl,
    cdpPort: config.cdpPort,
  });
}
