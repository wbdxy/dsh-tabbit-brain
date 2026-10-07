// Plugin-owned private reasoning conversations; no DSH child agents are created.
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import z from 'schemastery'
import { BrainService, BRAIN_PROMPT } from './brain-service.js'
import { installBrainTools } from './brain-tool.js'

export const name = 'dsh-tabbit-brain'
export const inject = ['systemPrompt', 'agents']
export const SETTINGS_NAMESPACE = 'tabbit-brain'

const DELEGATION_GUIDANCE = `Use \`tabbit_brain\` as an external thinking partner for the main agent.
Purpose: obtain an independent perspective, delegate bounded reasoning work, and advance independent analysis while you gather evidence or verify behavior. Bring back conclusions and evidence rather than the full intermediate process, keeping the main conversation focused. Briefing and verification have a cost; delegation does not guarantee better accuracy or faster completion.
Proactively consider a useful, self-contained reasoning subtask without waiting for the user to name this tool:
- Code and multi-file reviews: inspect supplied code for contract mismatches, overlooked dependencies and missing requirements.
- Bug investigation: compare candidate causes and alternative explanations, find counterexamples, and propose checks that distinguish them.
- Design: compare feasible approaches, trade-offs, assumptions and edge cases.
- Derivation: independently calculate or reason through a difficult problem for cross-checking.
- Writing: produce a draft or review logic, terminology and whether the reader can complete the task.
- Before finishing, request a completion review of the goal, changes and verification evidence for unmet requirements.
Complete simple facts and short edits yourself when preparing the brief costs more than the likely benefit.
Workflow: provide the question, necessary material, constraints and expected output. Run independent parts in the background while continuing local work; collect their results before finishing. Use \`run_in_background: false\` when the next step depends on the answer. Verify the returned analysis and integrate useful findings; the main agent remains responsible for decisions, evidence and final delivery.
Capabilities: process supplied text and use available upstream Tabbit search, webpage fetching and Tabbit-owned Skill/妙招 retrieval, subject to site limits. Verify sources and factual claims. It sees its own Brain history, not the main conversation, workspace, DSH skills, attachments or browser page; extract needed material first. Local file operations, code execution and user-browser control stay with you. Upstream browser-task events and agent_mode are not proof of user-browser execution; returned browser_control text is not executed here. Gateway widget capture does not establish DSH embedded rendering. This tool accepts text only even when the gateway model supports images.
Routing: when the user names a gateway model, pass its exact id in \`model\`; otherwise omit it to use configured \`agentModel\`. Do not invent model specialties. Reuse \`conversation\` for follow-ups; choose a new label for independent context. Reset clears local messages only and retains remote memory. Collect/cancel with DSH \`jobId\`; inspect persistent status with \`brainJobId\`.`

/**
 * 指引风格。委派是有代价的（往返 + 写简报 + 校验），容忍度因人而异，
 * 所以不单方面替用户决定。
 */
const GUIDANCE_STYLES = {
  off: '',
  standard: DELEGATION_GUIDANCE,
  // 更倾向委派：降低"最小任务"门槛，并明确要求宁可多派也不要自己啃
  aggressive: `${DELEGATION_GUIDANCE}

Prefer delegation for smaller reasoning subtasks when useful; retain the independence, material and verification rules above.`,
}



// Background tools return job IDs, not DSH child-session IDs.
export const Config = z.object({
    agentModel: z.string().default('DeepSeek-V4.1-Flash'),
    apiKeyEnv: z.string().default('TABBIT_API_KEY'),
    brainPrompt: z.string().default(BRAIN_PROMPT),
    contextBudgetChars: z.number().min(1000).max(19000).default(16000),
    requestTimeoutMs: z.number().min(1000).max(300000).default(120000),
    gatewayUrl: z.string().default('http://127.0.0.1:8787'),
    gatewayAutoStart: z.boolean().default(false),
    gatewayWarmup: z.boolean().default(false),
    gatewayStartCommand: z.string().default(''),
    gatewayStartCwd: z.string().default(''),
    gatewayStartTimeoutMs: z.number().default(20000),
    delegationStyle: z.union([z.const('off'),z.const('standard'),z.const('aggressive')]).default('standard'),
    diagnostics: z.boolean().default(false),
    diagnosticsPath: z.string().default(''),
  }).description({ zh: "插件内部静默推理会话，通过本地网关调用 Tabbit 模型。", en: "Private plugin-owned reasoning conversations via a local Tabbit gateway." })

let diagnosticsEnabled = false
let diagnosticsPath = ''
function logTrace(msg) {
  if (!diagnosticsEnabled || !diagnosticsPath) return
  try { appendFileSync(diagnosticsPath, `${new Date().toISOString()} ${msg}\n`, 'utf8') } catch {}
}
/** 最近一次确认健康的时间戳（毫秒）。 */
let lastHealthyAt = 0
const HEALTHY_TTL_MS = 15000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 探测网关是否在跑。
 *
 * 只判断**进程是否活着**：任何 HTTP 响应（含 401 / 404）都算可达。
 * 网关通常在路由匹配之前做鉴权，所以不带 key 的探测会拿到 401 —— 那依然
 * 证明它在跑。（早期版本用 `res.ok` 判断，于是永远认为网关是死的。）
 *
 * @param url - 网关基地址。
 * @param timeoutMs - 单次探测超时。
 * @returns 是否可达。
 */
export async function pingGateway(url, timeoutMs = 1500) {
  const base = String(url || '').replace(/\/+$/, '')
  if (!base) return false
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    await fetch(`${base}/healthz`, { signal: ctrl.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 确保网关在跑。已健康则直接返回；否则执行启动命令并等待健康检查通过。
 *
 * 不会抛错——失败以返回值表达，由调用方决定是继续还是中断本次委派。
 *
 * @param opts - 解析后的插件配置。
 * @param options.force - 跳过健康缓存，强制重新探测。
 * @returns `{ ok, action }`；`ok` 为 `null` 表示未启用托管。
 */
export async function ensureGateway(opts, { force = false } = {}) {
  if (!opts.gatewayAutoStart) return { ok: null, action: 'disabled' }
  if (!force && Date.now() - lastHealthyAt < HEALTHY_TTL_MS) return { ok: true, action: 'cached' }

  if (await pingGateway(opts.gatewayUrl)) {
    lastHealthyAt = Date.now()
    return { ok: true, action: 'already-running' }
  }

  if (!opts.gatewayStartCommand) {
    logTrace('gateway unreachable and gatewayStartCommand is empty')
    return { ok: false, action: 'no-command' }
  }

  logTrace(`gateway unreachable; starting: ${opts.gatewayStartCommand}`)
  try {
    const child = spawn(opts.gatewayStartCommand, {
      // 展开 ~ —— Node 的 spawn 不做这件事，而用户在配置里写 ~ 是很自然的事。
      // 不展开的话路径会静默失效，报出来的还是"网关起不来"，很难查。
      cwd: expandHome(opts.gatewayStartCwd) || undefined,
      shell: true,
      detached: true,      // 网关独立于 DSH 进程存活
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch (e) {
    logTrace(`gateway spawn failed: ${e?.message ?? e}`)
    return { ok: false, action: 'spawn-failed' }
  }

  const deadline = Date.now() + (opts.gatewayStartTimeoutMs || 20000)
  while (Date.now() < deadline) {
    await sleep(1000)
    if (await pingGateway(opts.gatewayUrl)) {
      lastHealthyAt = Date.now()
      logTrace('gateway started and healthy')
      return { ok: true, action: 'started' }
    }
  }
  logTrace('gateway did not become healthy before the timeout')
  return { ok: false, action: 'timeout' }
}

// ─── 路径工具 ────────────────────────────────────────────────────────────────

/**
 * 展开路径开头的 `~`。
 *
 * Node 的 `spawn({ cwd })` **不会**展开 `~` —— 传进去就是一个字面量目录名，然后
 * 静默失败。而用户在配置里写 `~/.tabbit-gateway/tabbit-toy` 是很自然的事，
 * 所以这里替他们展开。
 *
 * @param p - 路径；空值原样返回。
 * @returns 展开后的路径。
 */
function expandHome(p) {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

export function apply(ctx, config) {
  const base = {
    agentModel: config.agentModel,
    apiKeyEnv: config.apiKeyEnv,
    brainPrompt: config.brainPrompt,
    contextBudgetChars: config.contextBudgetChars,
    requestTimeoutMs: config.requestTimeoutMs,
    gatewayUrl: config.gatewayUrl,
    gatewayAutoStart: config.gatewayAutoStart,
    gatewayWarmup: config.gatewayWarmup,
    gatewayStartCommand: config.gatewayStartCommand,
    gatewayStartCwd: config.gatewayStartCwd,
    gatewayStartTimeoutMs: config.gatewayStartTimeoutMs,
    delegationStyle: config.delegationStyle,
    diagnostics: config.diagnostics,
    diagnosticsPath: config.diagnosticsPath,
  }
  if (!base.agentModel.trim()) throw new Error("agentModel is required")

  let source = () => base
  const current = () => {
    try {
      const live = source()
      return live && typeof live === 'object' ? { ...base, ...live } : { ...base }
    } catch (e) {
      logTrace(`read settings failed, falling back to deployment base: ${e?.message ?? e}`)
      return { ...base }
    }
  }

  // 诊断开关随配置走（默认关闭）。
  // 路径基准注意：本模块在 lib/ 下，`./trace.log` 会落到 lib/trace.log；
  // 插件根目录才是用户容易找到的位置，所以往上退一级。
  diagnosticsPath = base.diagnosticsPath || fileURLToPath(new URL('../trace.log', import.meta.url))
  diagnosticsEnabled = Boolean(base.diagnostics)

  // ── 设置段 ──────────────────────────────────────────────────────────────
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, base, {
        setSource: (next) => { source = next },
        validate: value => { if (!value.agentModel?.trim()) throw new Error('agentModel is required') },
        onChange: () => {
          const c = current()
          diagnosticsEnabled = Boolean(c.diagnostics)
          if (c.diagnosticsPath) diagnosticsPath = c.diagnosticsPath
          logTrace(`settings changed -> model=${c.agentModel}`)
        },
      })
    } catch (e) {
      ctx.logger?.warn?.('[tabbit-brain] failed to install settings section: %s', e?.message ?? e)
    }
  })

  const service = new BrainService()
  installBrainTools(ctx, service, current, ensureGateway)

  // ── 委派指引段（随插件分发，对每个用户自动生效）─────────────────────────
  // 这是本插件与「用户自己写 AGENTS.md」的关键差别：指引跟着插件走，安装即生效。
  // 用 waterfall 之外的正规注册点；scope 是宿主，因此对所有会话可见。
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'plugin:tabbit-brain-guidance',
      order: 2810,   // 紧接内置的 TOOL_SUBAGENT (2800)
      text: () => GUIDANCE_STYLES[current().delegationStyle] ?? GUIDANCE_STYLES.standard,
    }),
    'dsh-tabbit-brain: delegation guidance section',
  )

  // ── 网关托管 ────────────────────────────────────────────────────────────
  // 默认**懒启动**：插件加载时什么都不做，等第一次委派时再探测并拉起。
  // 不想让一个网关进程常驻的人，要的就是这个形态。
  //
  // `gatewayWarmup` 打开则改为加载时预热——代价是哪怕一整天不委派，
  // 网关也会一直占着。
  if (base.gatewayAutoStart && base.gatewayWarmup) {
    // 不 await：插件加载不该被一个可能几十秒的启动过程拖住。
    void ensureGateway(current()).then((r) => {
      ctx.logger?.info?.('[tabbit-brain] gateway warmup on load: %s (ok=%s)', r.action, String(r.ok))
    })
  }
}
