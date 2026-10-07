# dsh-tabbit-brain

[English](README.md)

## 插件内部静默推理会话

主 AI 通过 `tabbit_brain` 调用本地 Tabbit 网关。插件自己管理专用提示词和历史，不创建 DSH 子 agent，不继承工具、技能目录或主对话历史。没有额外 UI 窗口。

安装与前置条件: [SETUP.zh.md](SETUP.zh.md).
反代协议: [REVERSE-PROXY.zh.md](REVERSE-PROXY.zh.md).

## 工具与会话

- `tabbit_brain` 的 `description` 和 `prompt` 必填；`conversation`、`model` 和 `run_in_background` 可选，默认后台执行。省略 `model` 时使用配置中的 `agentModel`；也可以传入当前网关通过 `/v1/models` 暴露的任意模型 id，仅覆盖本次请求。Harness 的 `jobId` 与 `brainJobId` 是不同标识：用 `job_output`/`job_kill` 收集或取消 Harness 作业，用 `tabbit_brain_status` 查看 Brain 作业。
- 模型覆盖值会原样发送到 `/v1/chat/completions`。只有网关返回相同的模型 id 时插件才接受结果；网关拒绝请求或静默切换模型时会报告错误。
- `tabbit_brain_list` 列出所属会话；`tabbit_brain_read` 返回消息的 `seq`。读取更早一页时，将 `before` 设为当前页最小的 `seq`。
- `tabbit_brain_archive` 归档所属会话；`tabbit_brain_delete` 删除其本地记录。两者均不证明远端账号记忆已删除。
- `tabbit_brain_reset` 仅清空本地历史，标签须处于空闲状态，并保留远端上下文。
- 历史按调用者 owner 和会话标签隔离。SQLite 位于 `~/.dsh/plugins/dsh-tabbit-brain/state/brain.sqlite`，进程重启后保留。同标签请求串行，不同标签独立。失败回合不进入历史。
- 每次请求快照配置。当前任务须满足 `contextBudgetChars`；超限时丢弃较早的完整问答对，不静默截断当前任务。
- 请求没有 `tools` 或 `tool_choice`。前台回执包含 `kind`、`conversationId`、`requestId`、`model`、`endpoint` 和 `content`；这些字段标识本地路由，不证明上游供应商内部模型实现。

## 能力边界：DSH Skill、Tabbit 妙招、浏览器与附件

`tabbit_brain` 是发往本地 OpenAI 兼容网关的文字请求。它不会继承主 DSH 对话、本机 DSH `skill-catalog`、工作区文件、附件、浏览器标签页或 DSH 工具。若任务需要 DSH 专有 Skill，必须由主代理先运行该 Skill，再把结果、提取证据或忠实的文字转录放进 `prompt`；Brain 不能按名称或本机路径发现、读取或执行 DSH Skill。

上游 Tabbit 服务是另一层能力。反代模型已经实测会通过 Tabbit 自己的 `tab_help_rag` 资料源检索官方 Prompt/Script/Agent Skill 与妙招资料，普通聊天也能调用上游搜索和网页抓取工具。网页访问受站点限制，返回事实仍需核验。这是 Tabbit 服务端能力，不是 DSH Skill 目录访问。

反代多模态路径已实测具有读图能力；但当前 `tabbit_brain` 工具本身只接收文字，通用文件附件没有接通。读取本地文件或图片时，应由主代理先读取，再把相关文字或描述交给 Brain；图片也可走另行接通的网关多模态请求。

浏览器必须区分：已观察到上游产生浏览器任务事件并传递 `agent_mode`，但当前桥接尚未返回可验证的最终 URL、DOM 变化、截图或浏览器状态回执，因此它不是 `tabbit_browser` 控制通道。Tabbit 的 `browser_control`/妙招指令可能以文字返回，但本插件不会继续执行。`show_widget` 的 HTML/SVG 产物可以被网关捕获并写入文件；DSH 内嵌渲染尚未作为已验收契约。

## 全局入口与启动限制

工具在普通主代理自己的 scope 中注册，与预设独立。拥有工具的普通子代理可使用自己的 owner 调用 Brain，历史独立，不与父代理共享 owner。`router-standard` 仍须正常完成首次 `phase_begin`，装配后才暴露其他工具。own-layer 注册不受继承的 DSH allow/deny 过滤器约束；停用插件可禁止此能力。插件不自动推进阶段。

## 配置

| Field | Schema default |
|---|---|
| `agentModel` | 'DeepSeek-V4.1-Flash' |
| `apiKeyEnv` | 'TABBIT_API_KEY' |
| `brainPrompt` | bundled text-only prompt |
| `contextBudgetChars` | 16000 |
| `requestTimeoutMs` | 120000 |
| `gatewayUrl` | 'http://127.0.0.1:8787' |
| `gatewayAutoStart` | false |
| `gatewayWarmup` | false |
| `gatewayStartCommand` | '' |
| `gatewayStartCwd` | '' |
| `gatewayStartTimeoutMs` | 20000 |
| `delegationStyle` | 'standard' |
| `diagnostics` | false |
| `diagnosticsPath` | '' |

Set `apiKeyEnv` to the name of the environment variable holding the gateway key. Do not put the key in source or docs. `brainPrompt` is shipped in the package; no companion DSH preset is required. Gateway auto-start is lazy unless warmup is enabled. A detached gateway can outlive DSH.

## 只读 setup 检查助手

BrainService 使用 `apiKeyEnv` 指定的环境变量直接 POST 到 `gatewayUrl`，无需 DSH provider、专用 preset 或 DSH 模型目录登记。`node scripts/setup.mjs --help` 列出检查选项。默认离线运行；`--check-gateway` 显式检查 `/v1/models`，并按需核对 `--models`。`--api-key-env` 选择密钥环境变量且不输出其值。`--dry-run` 只打印计划而不连接，`--yes` 用于自动化。助手永不启动网关，也不读取或写入 settings、preset 或凭据。

## 边界与验收

- Cookie acquisition belongs to the gateway. A normal running Tabbit without CDP causes acquisition to skip; valid old cookies remain usable. See SETUP for explicit recovery.
- Brain 将每个本地会话绑定到账号/环境 scope 下创建时为空的远端会话；provenance 和 fail-closed 恢复见 SETUP。本地隔离不证明生产隔离。`[System]` 是文本角色标记，不代表原生 system 角色保证；远端隐藏账号记忆尚未证明不存在。
- 能力验收分层记录：反代 Tabbit 模型已实证上游搜索/网页抓取（有站点限制）、多模态读图、Tabbit 自有 Skill/妙招资料检索和网关侧 HTML/SVG Widget 捕获。`browser_task_tool` 与 `agent_mode` 尚未返回可验证浏览器状态回执；返回的 `browser_control` 块只是指令，不等于已执行。当前主机证据和边界见 `D:/my-project/tabbit-capabilities-4efc/EXTENDED-CAPABILITIES.md`。
- Task4 源码检查（83 项测试）、独立 review、默认端口部署、重启映射、新主对话冒烟、A/B 隔离、后台任务和分页已在本机部署验收。它们不代表所有上游网站、模型、Skill 类型或 Tabbit 浏览器操作都同样可用。
- Windows gateway only. Browser PID-difference cleanup retains a known user-launch race; do not open Tabbit while headless acquisition is in progress.

## Development

`npm run check`, `npm run test:brain`, `npm run scan`, `npm run audit:docs`; setup fixture tests: `python tools/test-setup.py` (requires PyYAML). Read the current code for exact host contracts. No UI panel or autonomous agent loop is implemented.

## License

[MIT](LICENSE). Upstream gateway code has separate provenance; an overlay of upstream-derived files is not automatically exempt from upstream licensing requirements. Public redistribution permissions remain unresolved.
