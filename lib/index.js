/**
 * dsh-tabbit-brain — 把 Tabbit 反代模型接成 DeepSeek Harness 的独立子代理提供方。
 *
 * 问题
 * ----
 * DSH 内置的 spawn/fork 驱动在子代理创建窗口里调用
 * `applyChildComposition(childCtx, parent, ...)`，让子代理**继承父预设**。
 * 父预设（router-standard 等）通常很大，且挂载了 skill 目录、persona 框架等
 * 注入段。`persona` 配置只能遮蔽 persona 一段，挡不住其余段落。
 *
 * 实测：把 Tabbit 反代模型作为子代理委派时，提示词达 **61,031 字符**，
 * 被网关截断后模型只看到「框架注入 + 技能清单」，任务本身被淹没。
 *
 * 解法
 * ----
 * 本插件注册一个自定义 subagent provider，其 `setup` 改为
 * `agentPresets.mount(childCtx, presetId)` —— 给子代理挂**独立预设**
 * （如 `tabbit-brain`：persona `complete: true`、926 字符、无工具行）。
 * `complete: true` 的语义是其他装配监听器无法再往里加提示词文本，
 * 因此技能目录与 persona 框架都不会注入。
 *
 * 浏览器与 cookie 不在本插件职责内：cookie 续期由网关侧用短命 headless 实例自理。
 *
 * 验证（同一任务，改造前后）
 * ------------------------
 *   改造前：`[prompt-budget] trimmed 61031 -> 18635 chars`，模型反馈「没有任务」
 *   改造后：无截断记录；子会话 header 记录 `agentPreset: tabbit-brain`
 *          （父会话是 router-standard）；子会话 51KB vs 父会话 5.1MB
 *
 * 依赖的 DSH 契约（均已核对源码）
 * ----------------------------
 * - provider 契约：`{ name, capabilities, inheritsParentContext, start(), prepareContinuable() }`
 *   （参考 `@deepseek-ai/dsh-subagent-spawn-in-process`）
 * - agent 工厂的 `setup` 支持 async：
 *   `await raceAbort(setup?.(prepared.agent.ctx, prepared.agent), ...)`
 *   （`@deepseek-ai/dsh-agent-loop` 的 createAgent）
 * - `AgentPresets.mount(agentCtx, id)` 是公开方法，文档明示
 *   「Call from the agent factory's setup(agentCtx)；其中的 rejection 会回滚创建」
 * - 技能目录来自预设层：预设挂载点为空时，官方警告写明
 *   "tools, prompt sections, and skill catalog resolve against the empty global layer"
 * - settings 绑定：`settings.installSection(owner, ns, schema, entry, { setSource, validate, onChange })`
 *   （参考 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`）
 *
 * @module dsh-tabbit-brain
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  appendDelegatedPolicyOverrides,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'
import z from 'schemastery'

export const name = 'dsh-tabbit-brain'
export const inject = ['subagents', 'systemPrompt']

/** 设置命名空间：用户在设置界面看到的分组。 */
export const SETTINGS_NAMESPACE = 'tabbit-brain'

/**
 * 随插件分发的委派指引。
 *
 * 为什么要插件自己注入，而不是让用户写进自己的 AGENTS.md：AGENTS.md 是**每个用户
 * 本地的东西**，装了插件的人不会有我们那一份。指引必须跟着插件走，才能对每个人都
 * 自动生效 —— 这正是开源分发的关键差别。
 *
 * 位置：紧挨内置的 subagent 工具指引（`TOOL_SUBAGENT = 2800`），用 2810 避开同名
 * 冲突（同一层内重复的 section 名会抛错）。
 *
 * 措辞刻意强调三件事，都是实测踩出来的：
 *   1. 能力差距在「手」不在「脑」—— 不写清楚，模型会把它当低级助手用错
 *   2. 输出是主张不是事实 —— 它无法验证任何东西，信心与正确性不相关
 *   3. 「我需要材料」是契约在起作用，不是失败
 */
const DELEGATION_GUIDANCE = `You have a second reasoning resource: \`subagent_tabbit\` (the "Tabbit brain"), when that tool is available. Use it as a working habit, not as a fallback.

**Before starting non-trivial work, decompose it. Do not start work directly.**

1. **Split** the request into its parts.
2. **Sort each part by whether it needs hands.** It has no tools and no memory of this
   conversation — it matches you on reasoning quality, and the asymmetry is hands, not
   intelligence.
   - **Its half** (pure reasoning, you already hold the material): analysis, design,
     architecture, drafting, writing, translation, derivation, weighing options,
     reviewing text.
   - **Your half** (needs hands or ground truth): reading and writing files, running
     commands, editing code, searching, git, the browser, verification, anything whose
     answer is "what does this file actually say".
3. **Start its half immediately, in the background, then do your half while it runs.**
   Do not serialize — do not finish your part first and only then think of delegating,
   and do not sit idle waiting for it.

## Guardrails — these matter as much as the three steps

- **Independence test.** Parallelise only parts that genuinely do not depend on each
  other. If you need its result before you can decide your next step, that is fake
  parallelism: either do it yourself or wait for it synchronously with
  \`run_in_background: false\`.
- **Never delegate verification.** It cannot check anything: no file access, no shell,
  no network of its own.
- **Minimum useful size.** If briefing it would take you longer than doing it, do it
  yourself. Delegation costs a round trip plus a written-out brief — spend that only
  where the reasoning is substantial.
- **Its output is a draft, not a result.** A reply is a CLAIM, not a FACT; confidence
  does not correlate with correctness. Land it and check it here. You own the answer.
- **Do not parallelise work that can conflict.** If two lines of output may contradict
  each other, the merge cost exceeds the saving.
- **It cannot see this workspace.** Put the material it needs into the prompt. If it
  replies listing what it needs, that is the contract working as designed — fetch the
  material and send it again rather than treating it as a failure.`

/**
 * 指引风格。委派是有代价的（往返 + 写简报 + 校验），容忍度因人而异，
 * 所以不单方面替用户决定。
 */
const GUIDANCE_STYLES = {
  off: '',
  standard: DELEGATION_GUIDANCE,
  // 更倾向委派：降低"最小任务"门槛，并明确要求宁可多派也不要自己啃
  aggressive: `${DELEGATION_GUIDANCE}

## Aggressive mode

Prefer delegating when in doubt. Lower the size bar: if a part is reasoning-only and
you already hold the material, send it even when it looks small — the cost of one extra
round trip is lower than the context you would spend doing it yourself. Keep every
guardrail above, especially the independence test and never delegating verification.`,
}


/**
 * 配置 schema。同时作为部署基线 schema 与设置界面 schema。
 *
 * 每个字段都带 `description`（默认英文）与 `i18n`（zh/en），
 * 设置界面会直接渲染。
 */
export const Config = z
  .object({
    providerName: z.string().default('tabbit'),
    presetId: z.string().default('tabbit-brain'),
    agentProvider: z.string().default('tabbit-local'),
    agentModel: z.string().default('DeepSeek-V4.1-Flash'),
    gatewayUrl: z.string().default('http://127.0.0.1:8787'),
    gatewayAutoStart: z.boolean().default(false),
    gatewayWarmup: z.boolean().default(false),
    gatewayStartCommand: z.string().default(''),
    gatewayStartCwd: z.string().default(''),
    gatewayStartTimeoutMs: z.number().default(20000),
    // 委派指引风格。见 GUIDANCE_STYLES。
    delegationStyle: z.union([z.const('off'), z.const('standard'), z.const('aggressive')]).default('standard'),
    diagnostics: z.boolean().default(false),
    diagnosticsPath: z.string().default(''),
  })
  .description({
    '': 'Delegate reasoning tasks to models served by a local Tabbit gateway, and keep that gateway up.',
    zh: '把推理型任务委派给本地 Tabbit 网关提供的模型，并托管该网关的可用性。',
    en: 'Delegate reasoning tasks to models served by a local Tabbit gateway, and keep that gateway up.',
  })
  .i18n({
    zh: {
      providerName: '提供方注册名（须与预设里 tool-subagent 的 provider 字段一致；改动需重载插件）',
      presetId: '子代理挂载的预设 id。指向一个 persona 为 complete:true 的极简预设，以避免上下文污染',
      agentProvider: '子代理默认路由：DSH 里的 provider 名',
      agentModel: '子代理默认路由：模型名',
      gatewayUrl: '网关健康检查地址（探测其 /healthz）',
      gatewayAutoStart: '按需拉起网关：每次委派前探测，不通就执行下面的启动命令',
      gatewayWarmup: '加载时预热（默认关）。关=懒启动，只在第一次委派时拉起；开=DSH 启动即拉起',
      gatewayStartCommand: '启动网关的 shell 命令（留空则不自动启动）',
      gatewayStartCwd: '启动命令的工作目录',
      gatewayStartTimeoutMs: '启动后等待健康检查通过的最长时间（毫秒）',
      delegationStyle: '委派指引风格。off=不注入；standard=要求先拆解、把推理部分后台并行（默认）；aggressive=更倾向多派',
      diagnostics: '写入诊断日志（排查预设挂载与网关拉起是否生效时开启）',
      diagnosticsPath: '诊断日志路径；留空则用插件目录下的 trace.log',
    },
    en: {
      providerName: 'Provider registration name (must match the preset tool-subagent provider field; reload after changing)',
      presetId: 'Preset the child agent mounts. Point it at a minimal, complete:true persona preset to avoid context pollution',
      agentProvider: 'Default child route: provider name in DSH',
      agentModel: 'Default child route: model name',
      gatewayUrl: 'Gateway health endpoint base (its /healthz is probed)',
      gatewayAutoStart: 'Start the gateway on demand: probe before every delegation and run the start command when unreachable',
      gatewayWarmup: 'Warm up on plugin load (default off). Off = lazy, started by the first delegation; on = started with DSH',
      gatewayStartCommand: 'Shell command that starts the gateway (empty disables auto-start)',
      gatewayStartCwd: 'Working directory for the start command',
      gatewayStartTimeoutMs: 'How long to wait for the gateway to become healthy after starting (ms)',
      delegationStyle: 'Delegation guidance style. off = none; standard = decompose first and parallelise the reasoning half (default); aggressive = delegate more readily',
      diagnostics: 'Write a diagnostic log (enable when investigating preset mounting or gateway startup)',
      diagnosticsPath: 'Diagnostic log path; empty means trace.log inside the plugin directory',
    },
  })

// ─── 诊断日志（默认关闭）─────────────────────────────────────────────────────

let diagnosticsEnabled = false
let diagnosticsPath = ''

function logTrace(msg) {
  if (!diagnosticsEnabled || !diagnosticsPath) return
  try {
    appendFileSync(diagnosticsPath, `${new Date().toISOString()}  ${msg}\n`, 'utf8')
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

// ─── 网关可用性托管 ──────────────────────────────────────────────────────────
//
// 很多「本地反代 + 子代理」的部署里，网关是个独立进程：忘了启动、崩了没重启，
// 都会以一堆难懂的报错形式暴露出来。这里加一层保险——
// 插件加载时与每次委派前探测一次，不通就执行配置好的启动命令。
//
// 探测本身很便宜（loopback），但仍然缓存一小段时间，避免连续委派时反复打。

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

// ─── 启动自检 ────────────────────────────────────────────────────────────────

/**
 * 检查用户必须自己完成、插件无法代劳的前置条件。
 *
 * 这些检查存在的理由很具体：一条链路上有五六处手工步骤，任何一步漏掉，
 * 表现出来都是「委派报了个看不懂的错」。把话说在前面，好过让用户猜。
 *
 * 只告警、不阻断——缺东西时插件本身仍能加载，用户也还能进设置界面。
 *
 * @param base - 部署基线配置。
 * @param ctx - 插件上下文（用于 logger）。
 */
function checkPrerequisites(base, ctx) {
  const warn = (msg) => {
    ctx.logger?.warn?.(`[tabbit-brain] ${msg}`)
    logTrace(`PREREQ: ${msg}`)
  }

  // 1. 子代理预设 —— 唯一不随插件分发的东西，也是最常被漏掉的一步
  try {
    const presetsRoot = join(homedir(), '.dsh', '.agent-presets')
    const presetDir = join(presetsRoot, base.presetId)
    const manifest = join(presetDir, 'agent.cordis.yml')
    if (!existsSync(presetDir) || !existsSync(manifest)) {
      warn(
        `child preset "${base.presetId}" not found at ${presetDir}. `
        + 'Delegation will fail. Presets live in user state and cannot ship with '
        + 'the plugin - create it by hand, see SETUP.md step 4.',
      )
    } else {
      const text = readFileSync(manifest, 'utf8')
      if (!/complete:\s*true/.test(text)) {
        warn(
          `preset "${base.presetId}" does not set persona complete:true. `
          + 'Without it, the parent\'s prompt sections leak into the child and '
          + 'the task gets buried - see SETUP.md step 4.',
        )
      }
    }
  } catch (e) {
    logTrace(`preset check failed: ${e?.message ?? e}`)
  }

  // 2. 网关：既没在跑也没配启动命令 → 用户只能手动开
  if (base.gatewayAutoStart && !base.gatewayStartCommand) {
    warn(
      `gatewayAutoStart is on but gatewayStartCommand is empty, so the plugin `
      + `cannot start ${base.gatewayUrl} by itself - the gateway must already be running.`,
    )
  }
}

// ─── 配置校验 ────────────────────────────────────────────────────────────────

function validateConfig(value) {
  if (!value || typeof value !== 'object') throw new Error('tabbit-brain: config must be an object')
  if (!value.presetId || typeof value.presetId !== 'string') {
    throw new Error('tabbit-brain: presetId must be a non-empty string')
  }
  if (!value.agentProvider || typeof value.agentProvider !== 'string') {
    throw new Error('tabbit-brain: agentProvider must be a non-empty string')
  }
  if (!value.agentModel || typeof value.agentModel !== 'string') {
    throw new Error('tabbit-brain: agentModel must be a non-empty string')
  }
}

// ─── 驱动（结构对齐官方 in-process 驱动）──────────────────────────────────────

/** 把内部 reason 映射到子代理 seam 的终态词汇。 */
function toStopReason(reason) {
  switch (reason?.kind) {
    case 'completed': return 'completed'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return 'aborted'
    case 'blocked': return 'refusal'
    default: return 'error'
  }
}

/** 构造子 agent 的 session meta——与官方驱动的差别只在 `agentPreset`。 */
function childMeta(parent, childDepth, presetId) {
  const header = parent.session.header
  return {
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    agentPreset: presetId,
    parentSession: header.id,
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: childDepth,
  }
}

/** 读取已结算子 agent 的结果。 */
function readResult(child, boundary, cancelled) {
  const own = child.session.snapshotEvents(boundary)
  const lastEnd = foldConsumedWork(own).end
  const output = finalAssistantOutput(own) ?? []
  const recorded = toStopReason(lastEnd?.data?.reason)
  return { output, stopReason: cancelled && recorded !== 'completed' ? 'aborted' : recorded }
}

/**
 * 驱动一轮一次性子 agent：挂预设 → 发任务 → 等空闲 → 读结果。
 *
 * 与 `@deepseek-ai/dsh-subagent-in-process-driver` 的 startInProcessRun 同构，
 * 唯一实质差别是 setup 用 `agentPresets.mount()` 取代 `applyChildComposition()`。
 *
 * @param request - 子代理 seam 的启动请求。
 * @param opts - 解析后的插件配置。
 * @returns 拥有该子 agent 生命周期的 run 句柄。
 */
async function startRun(request, opts) {
  assertSubagentMaxDepth(request.maxDepth)
  if (request.signal.aborted) throw new Error('tabbit-brain: aborted before child publication')

  // ── 委派前确保网关可用 ──────────────────────────────────────────────────
  //
  // 失败**快速中断**——没有网关就一定调不到模型，早报错比让子代理跑到一半再抛
  // 网络错误好。

  // 浏览器不需要插件管：cookie 续期由网关用短命 headless 实例自理
  // （它起一个无窗口实例取 cookie，取完立刻杀掉，不占 profile、不留常驻进程）。
  //
  const gw = await ensureGateway(opts)
  if (gw.ok === false) {
    throw new Error(
      `tabbit-brain: the local gateway at ${opts.gatewayUrl} is unreachable (${gw.action}). ` +
      'Start it, or set gatewayStartCommand so the plugin can start it for you.',
    )
  }

  const parent = request.parent
  const childDepth = resolveChildDepth(parent, request.maxDepth)
  const childId = brandString(randomUUID())
  const boundary = SessionLogOffset(0)
  const inherited = captureDelegatedPolicyOverrides(parent)

  const setup = async (childCtx, child) => {
    appendDelegatedPolicyOverrides(child.session, inherited)

    // ── 核心：挂我们自己的预设，而不是继承父级 ──────────────────────────
    const presets = childCtx.get('agentPresets')
    if (!presets?.mount) {
      logTrace('setup FAILED: agentPresets service unavailable')
      throw new Error('tabbit-brain: the agentPresets service is unavailable; cannot compose the child preset')
    }
    let mountedId
    try {
      const mounted = await presets.mount(childCtx, opts.presetId)
      mountedId = mounted?.id ?? opts.presetId
      logTrace(`setup OK: mounted preset "${mountedId}" for child ${child?.id ?? childId}`)
    } catch (e) {
      logTrace(`setup FAILED: mount("${opts.presetId}") threw: ${e?.message ?? e}`)
      throw e
    }

    // toolFilter：预设本身已经是空的，这里只尊重调用方的显式收窄。
    if (request.toolFilter !== undefined) {
      const toolsSvc = childCtx.get('tools')
      if (toolsSvc?.restrict) {
        const { allow, deny } = request.toolFilter
        const view = typeof toolsSvc.view === 'function' ? toolsSvc.view(childCtx) : undefined
        const names = view?.restrictableNames ?? view?.knownNames ?? []
        let list = Array.isArray(names) ? [...names] : []
        if (Array.isArray(allow)) list = list.filter((t) => allow.includes(t))
        if (Array.isArray(deny)) list = list.filter((t) => !deny.includes(t))
        if (list.length > 0) toolsSvc.restrict({ allow: list })
      }
    }
  }

  // 插件设置提供默认路由；调用方（经 subagent-model-selection 授权）可按次覆盖。
  const configured = {
    provider: opts.agentProvider,
    model: opts.agentModel,
    ...(request.agentOptions ?? {}),
  }

  const handle = await parent.ctx.agents.create({
    sessionId: childId,
    parentAgent: parent,
    meta: childMeta(parent, childDepth, opts.presetId),
    agentOptions: resolveChildAgentOptions(parent, configured, childDepth),
    signal: request.signal,
    setup,
  })

  // ── 运行生命周期 ────────────────────────────────────────────────────────
  const child = handle.agent
  const flags = { cancelled: false }
  const onAbort = () => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) onAbort()

  const result = (async () => {
    try {
      if (!flags.cancelled) {
        child.followup(createUserMessage({ content: request.prompt, source: { kind: 'user' } }))
        await child.whenIdle()
      }
      return readResult(child, boundary, flags.cancelled)
    } finally {
      request.signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    localAgent: child,
    result,
    async dispose() {
      request.signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      const disposal = (await Promise.allSettled([handle.dispose(), result]))[0]
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

// ─── provider ────────────────────────────────────────────────────────────────

/**
 * 一次性、进程内、挂固定预设的子代理提供方。
 *
 * 配置在每次 `start()` 重新读取，因此改设置即时生效，无需重载插件。
 */
class TabbitBrainProvider {
  /**
   * @param providerName - 注册名（构造期固定；改名需重载插件）。
   * @param readConfig - 每次 start 调用的配置读取器。
   */
  constructor(providerName, readConfig) {
    this.name = providerName
    this.readConfig = readConfig
    this.capabilities = {
      agentOptions: true,
      depthLimit: true,
      toolFilter: true,
      // 不声明 persona：本 provider 靠挂预设获得干净提示词，而不是遮蔽 persona 一段。
      outputSchema: false,
    }
    this.inheritsParentContext = false
  }

  start(request) {
    return startRun(request, this.readConfig())
  }

  /** 一次性提供方：不支持可继续会话。 */
  prepareContinuable() {
    return Promise.resolve({})
  }
}

// ─── 插件入口 ────────────────────────────────────────────────────────────────

/**
 * 配置来源两层，后者优先：
 *   1. 部署基线：`cordis.patch.yml` 里该行的 `config`
 *   2. 用户设置：设置系统的 `tabbit-brain` 命名空间（热重载）
 *
 * @param ctx - 插件上下文。
 * @param config - 部署基线配置。
 */
export function apply(ctx, config) {
  const base = {
    providerName: config.providerName,
    presetId: config.presetId,
    agentProvider: config.agentProvider,
    agentModel: config.agentModel,
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
  validateConfig(base)

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

  // ── 启动自检 ────────────────────────────────────────────────────────────
  // 把「静默神秘失败」变成「一眼知道缺什么」。检查的都是**用户必须自己做**、
  // 插件没法代劳的前置条件——尤其是子代理预设：它是唯一不随插件分发的东西，
  // 也是最容易忘记的一步。
  checkPrerequisites(base, ctx)

  // ── 设置段 ──────────────────────────────────────────────────────────────
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, base, {
        setSource: (next) => { source = next },
        validate: (value) => validateConfig(value),
        onChange: () => {
          const c = current()
          diagnosticsEnabled = Boolean(c.diagnostics)
          if (c.diagnosticsPath) diagnosticsPath = c.diagnosticsPath
          logTrace(`settings changed -> preset="${c.presetId}" route=${c.agentProvider}/${c.agentModel}`)
        },
      })
    } catch (e) {
      ctx.logger?.warn?.('[tabbit-brain] failed to install settings section: %s', e?.message ?? e)
    }
  })

  // ── provider 注册 ───────────────────────────────────────────────────────
  ctx.effect(
    () => ctx.subagents.registerProvider(new TabbitBrainProvider(base.providerName, current)),
    'dsh-tabbit-brain: provider registration',
  )

  // ── 委派指引段（随插件分发，对每个用户自动生效）─────────────────────────
  // 这是本插件与「用户自己写 AGENTS.md」的关键差别：指引跟着插件走，安装即生效。
  // 用 waterfall 之外的正规注册点；scope 是宿主，因此对所有会话可见。
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'plugin:tabbit-brain-guidance',
      order: 2810,   // 紧接内置的 TOOL_SUBAGENT (2800)
      text: GUIDANCE_STYLES[base.delegationStyle] ?? GUIDANCE_STYLES.standard,
    }),
    'dsh-tabbit-brain: delegation guidance section',
  )

  logTrace(`provider "${base.providerName}" registered -> preset "${base.presetId}", route ${base.agentProvider}/${base.agentModel}`)
  ctx.logger?.info?.(
    '[tabbit-brain] provider "%s" registered -> preset "%s", route %s/%s',
    base.providerName, base.presetId, base.agentProvider, base.agentModel,
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
