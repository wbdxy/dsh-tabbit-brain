# dsh-tabbit-brain

[English](README.md)

## 插件内部静默推理会话

主 AI 通过 `tabbit_brain` 调用本地 Tabbit 网关。插件自己管理专用提示词和历史，不创建 DSH 子 agent，不继承工具、技能目录或主对话历史。没有额外 UI 窗口。

安装与前置条件: [SETUP.zh.md](SETUP.zh.md).
反代协议: [REVERSE-PROXY.zh.md](REVERSE-PROXY.zh.md).

## 工具与会话

- `tabbit_brain`: `description`, `prompt`, optional `conversation` and `run_in_background`. Background is default; returns job ID. Collect with `job_output`, cancel with `job_kill`. Foreground returns content and route receipt.
- `tabbit_brain_reset`: clears one idle history label within the caller session.
- Histories are keyed by main-session ID and conversation label. Same-label requests serialize; different labels are independent. History is memory-only and is lost on DSH restart. Failed turns do not enter history.
- Each request snapshots settings. Current task must fit `contextBudgetChars`; older complete pairs are dropped to fit. No silent truncation of the current task.
- Requests contain no `tools` or `tool_choice`. Receipts contain requestId, endpoint and gateway-reported model; those identify local routing, not the upstream vendor's internal model implementation.

## 全局入口与启动限制

Tools install in ordinary main-agent own scopes, independent of preset. Child agents are excluded. `router-standard` still requires its normal first `phase_begin` before assembly exposes other tools. Own-layer registration is exempt from inherited DSH allow/deny filters; disable this plugin to prohibit the capability. There is no automatic phase advancement.

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

## 边界与验收

- Cookie acquisition belongs to the gateway. A normal running Tabbit without CDP causes acquisition to skip; valid old cookies remain usable. See SETUP for explicit recovery.
- The gateway may reuse a remote Tabbit chat session. Local history isolation does not prove remote backend context isolation; concurrent remote chat safety is not established.
- This version's HTTP fixture and tool-adapter tests pass. The new host tools require a DSH restart and a fresh main-session test before runtime integration can be declared complete.
- Windows gateway only. Browser PID-difference cleanup retains a known user-launch race; do not open Tabbit while headless acquisition is in progress.

## Development

`npm run check`, `npm run test:brain`, `npm run scan`, `npm run audit:docs`; setup fixture tests: `python tools/test-setup.py` (requires PyYAML). Read the current code for exact host contracts. No UI panel or autonomous agent loop is implemented.

## License

[MIT](LICENSE). Upstream gateway code has separate provenance; an overlay of upstream-derived files is not automatically exempt from upstream licensing requirements. Public redistribution permissions remain unresolved.
