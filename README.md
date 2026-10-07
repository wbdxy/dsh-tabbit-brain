# dsh-tabbit-brain

[简体中文](README.zh.md)

## Private reasoning conversations inside DSH

The main AI calls a local Tabbit gateway through `tabbit_brain`. The plugin owns its prompt and history: no DSH child agent, inherited tools, skill catalog, or main-conversation history. No additional UI window.

Install and prerequisites: [SETUP.md](SETUP.md).
Gateway protocol: [REVERSE-PROXY.md](REVERSE-PROXY.md).

## Tools and conversations

- `tabbit_brain` requires `description` and `prompt`; `conversation`, `model`, and `run_in_background` are optional. Background is default. Omit `model` to use the configured `agentModel`, or pass any model id exposed by the configured gateway for a one-request override. Check `/v1/models` to discover the gateway's current ids. The harness `jobId` and `brainJobId` are separate identifiers: collect/cancel the harness job with `job_output`/`job_kill`, and inspect the Brain job with `tabbit_brain_status`.
- A model override is sent unchanged to `/v1/chat/completions`. The plugin accepts the response only when the gateway returns the same model id; gateway rejection or silent model fallback is reported as an error.
- `tabbit_brain_list` lists owned conversations; `tabbit_brain_read` returns message `seq` values. For an older page, set `before` to the minimum `seq` in the current page.
- `tabbit_brain_archive` archives an owned conversation; `tabbit_brain_delete` deletes its local records. Neither establishes deletion of remote account memory.
- `tabbit_brain_reset` clears local history only for an idle label and retains the remote context.
- Histories are keyed by caller owner and conversation label. SQLite at `~/.dsh/plugins/dsh-tabbit-brain/state/brain.sqlite` persists across process restarts. Same-label requests serialize; different labels are independent. Failed turns do not enter history.
- Each request snapshots settings. Current task must fit `contextBudgetChars`; older complete pairs are dropped to fit. No silent truncation of the current task.
- Requests contain no `tools` or `tool_choice`. Foreground receipts contain `kind`, `conversationId`, `requestId`, `model`, `endpoint` and `content`; those identify local routing, not the upstream vendor's internal model implementation.

## Capability boundary: DSH skills, Tabbit skills, browser actions and attachments

`tabbit_brain` is a text request to the local OpenAI-compatible gateway. It does not inherit the main DSH conversation, the local DSH `skill-catalog`, workspace files, attachments, browser tabs, or DSH tools. If a task needs a DSH-only skill, the main agent must run that skill first and pass the resulting text, extracted evidence, or a concise faithful transcription in `prompt`; the Brain cannot discover or execute that DSH skill by name or local path.

The upstream Tabbit service is different. The reverse-proxied model has been observed to use Tabbit's own `tab_help_rag` source for official Prompt/Script/Agent Skill and 妙招 material, and its ordinary chat can invoke upstream search and webpage-fetch tools. Web access is site-dependent and returned facts still require verification. This is Tabbit's service-side capability, not access to the DSH skill catalog.

The reverse-proxied multimodal path has read-image capability. The `tabbit_brain` tool itself currently accepts text only; generic file attachments are not connected. Read a local file or image through the main agent and pass the relevant text or description, or use a separately wired gateway image request.

Browser distinction: upstream browser-task events and `agent_mode` have been observed, but this bridge has not produced a verifiable URL, DOM change, screenshot, or browser-state receipt. It is not a `tabbit_browser` control channel. Tabbit's `browser_control`/Skill instructions may be returned as text without being executed by this plugin. `show_widget` HTML/SVG output is captured and can be written to a gateway file; DSH embedded rendering has not been accepted as a tested contract.

## Global entry and startup restrictions

Tools install in ordinary main-agent own scopes, independent of preset. An ordinary child with tools can call Brain under its own owner with independent history; it does not share the parent's owner. `router-standard` still requires its normal first `phase_begin` before assembly exposes other tools. Own-layer registration is exempt from inherited DSH allow/deny filters; disable this plugin to prohibit the capability. There is no automatic phase advancement.

## Configuration

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

## Read-only setup checker

BrainService posts directly to `gatewayUrl` using the environment variable named by `apiKeyEnv`. It needs no DSH provider, dedicated preset, or DSH model-directory registration. `node scripts/setup.mjs --help` lists the checker options. Default runs are offline; `--check-gateway` explicitly checks `/v1/models` and optionally verifies `--models`. `--api-key-env` selects the key variable without printing its value. `--dry-run` prints the plan without connecting; `--yes` supports automation. The checker never starts a gateway or reads or writes settings, presets, or credentials.

## Limits and verification

- Cookie acquisition belongs to the gateway. A normal running Tabbit without CDP causes acquisition to skip; valid old cookies remain usable. See SETUP for explicit recovery.
- Brain binds each local conversation to a created-empty remote session under an account/environment scope; see SETUP for provenance and fail-closed recovery. Local isolation does not prove production isolation. `[System]` is a textual role marker, not a native system-role guarantee; absence of remote hidden account memory remains unproven.
- Capability acceptance is layered: the reverse-proxied Tabbit model has verified upstream search/web-fetch with site limits, multimodal image reading, Tabbit-owned Skill/妙招 retrieval, and gateway-side HTML/SVG widget capture. It has not produced a verifiable browser-state receipt for `browser_task_tool` or `agent_mode`; a returned `browser_control` block is an instruction, not execution. Current host evidence and boundaries are recorded in `D:/my-project/tabbit-capabilities-4efc/EXTENDED-CAPABILITIES.md`.
- Task4 source checks (83 tests), independent review, default-port deployment, restart mapping, fresh main-session smoke test, A/B isolation, background jobs and pagination were accepted in the local deployment. These results do not imply all upstream sites, models, Skill types or Tabbit browser actions are equally available.
- Windows gateway only. Browser PID-difference cleanup retains a known user-launch race; do not open Tabbit while headless acquisition is in progress.

## Development

`npm run check`, `npm run test:brain`, `npm run scan`, `npm run audit:docs`; setup fixture tests: `python tools/test-setup.py` (requires PyYAML). Read the current code for exact host contracts. No UI panel or autonomous agent loop is implemented.

## License

[MIT](LICENSE). Upstream gateway code has separate provenance; an overlay of upstream-derived files is not automatically exempt from upstream licensing requirements. Public redistribution permissions remain unresolved.
