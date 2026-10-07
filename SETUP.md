# Setup and acceptance

## Prerequisites

Requires Windows, Node.js 22.19+, DSH and an installed, signed-in Tabbit. Account registration and login are user actions.

## 1. Deploy the gateway

Read [REVERSE-PROXY.md](REVERSE-PROXY.md) first. It defines the protocol this plugin depends on.

```powershell
node gateway-patch/install.mjs --dry-run
node gateway-patch/install.mjs --api-key <YOUR_KEY> --base-url https://web.tabbit.com
```

`<YOUR_KEY>` must equal gateway `.env` `API_KEY` and DSH `TABBIT_API_KEY`. Use `https://web.tabbit.ai` for the international backend. The installer obtains upstream and overlays our changes; upstream has no LICENSE, so public redistribution permission remains unresolved.

Verify:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/healthz' -Headers @{Authorization="Bearer <YOUR_KEY>"}
Invoke-RestMethod 'http://127.0.0.1:8787/v1/models' -Headers @{Authorization="Bearer <YOUR_KEY>"}
```

## 2. Install the plugin

```powershell
git clone https://github.com/wbdxy/dsh-tabbit-brain.git
cd dsh-tabbit-brain
npm install --ignore-scripts --legacy-peer-deps
dsh plugin --profile <PROFILE> add link:<ABSOLUTE_PLUGIN_DIR>
```

Replace the placeholders. The host plugin registers the seven Brain tools listed in README for ordinary main agents and ordinary children with their own owner; no child preset or manual `tool-subagent-tabbit` row is required.

## 3. Configure model and credentials

Set a user environment variable equal to gateway `.env` `API_KEY`:

```powershell
$key = Read-Host 'Gateway API key' -AsSecureString
$plain = [System.Net.NetworkCredential]::new('', $key).Password
[Environment]::SetEnvironmentVariable('TABBIT_API_KEY', $plain, 'User')
$env:TABBIT_API_KEY = $plain
Remove-Variable plain, key
```

Set `agentModel` to an id returned by `/v1/models`; keep `gatewayUrl` and `apiKeyEnv` aligned. Users can also pass any `/v1/models` id through the `tabbit_brain` `model` parameter for a single request without changing the global setting. `delegationStyle` accepts `off`, `standard` (default) and `aggressive`.

## 4. Restart and accept

Restart DSH and start an ordinary main conversation. Confirm `tabbit_brain` is visible. In a staged preset, complete its normal `phase_begin`; do not call `phase_advance` to fake completion.

```text
Give this self-contained reasoning task to tabbit_brain with run_in_background: true. Continue your own tool work, then collect the job result and verify it.
```

Acceptance requires a job ID, no DSH child session, a receipt containing the requested model and local endpoint, no `tools` or `tool_choice` in the gateway request, serialized same-label history, and independent labels.

## 5. Capability boundaries and DSH Skill handoff

The plugin is a text handoff layer, not a second DSH tool runner. The main DSH agent sees the local skill catalog, files, attachments, browser-control tools and verification surfaces; Brain receives only the text placed in `prompt` plus its own conversation history. For a DSH-only Skill, run it in the main agent first, then pass its result or a faithful extracted transcription:

```text
The main agent ran DSH skill <SKILL_NAME>. Here is the complete relevant result:
<PASTE_RESULT_OR_EXTRACTED_EVIDENCE>
Now analyze/design/summarize it. Do not claim to have run the Skill or inspected the original file.
```

Do not pass a path as a substitute for file contents. `tabbit_brain` cannot open a local path, read the DSH skill catalog, use `tabbit_browser`, or receive a generic file attachment through its current parameters.

The reverse-proxied Tabbit service has separately demonstrated its own upstream search/web-fetch tools, Tabbit Skill/妙招 retrieval, multimodal image reading, and HTML/SVG widget generation. Search and fetch are site-limited and require source verification. Tabbit Skill retrieval comes from Tabbit's own help/Skill source, not the local DSH catalog. Upstream browser-task events and `agent_mode` are forwarded, but this bridge has not produced verifiable browser-state receipts; do not claim that it controls the user's Tabbit browser. `browser_control` instructions may be returned as text without execution. Widget HTML can be saved by the gateway; embedded DSH rendering is not a tested contract. Generic file attachments remain unconnected.

## 5. Cookie recovery boundary

If Tabbit is closed, the gateway attempts a short-lived headless read of the existing login state and exits. If a normal browser is open without CDP, the read is skipped and the old cookie remains in use. If the server invalidated the token, sign in again, save work, quit Tabbit completely, then explicitly refresh:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/admin/refresh-cookie' -Method Post -Headers @{Authorization="Bearer $env:TABBIT_API_KEY"}
```

## 6. Remote bindings and recovery

Brain sends `X-Brain-Conversation-Id` to bind a local conversation to a long-lived remote session created empty. The source contract creates with `POST /panel/session`, then validates with `GET /panel/id/data`: the returned ID must match and history must be empty.

The gateway ledger `state/brain-session-map.json` is scoped by `accountKey` and `baseURL`. Set `TABBIT_ACCOUNT_KEY` explicitly for the intended account; set `TABBIT_BRAIN_SESSION_MAP_PATH` to a distinct ledger path when changing account or backend environment. The ledger's `baseURL` scope field is not the plugin's `gatewayUrl`. Provenance is `created`, `pool`, `legacy` or `unverified`; existing non-`created` bindings fail closed with 409. For an old scope or provenance, explicitly select a new state path for the intended account/environment. Preserve original state and history instead of deleting them as a recovery shortcut.

Production Brain create failure must surface the error, not fall back to a pool session. Brain pool-related 409 compatibility is restricted to an explicitly selected compatibility fixture. The separate legacy mode keeps an operational list-pool path; it is not fixture-only. Local SQLite persistence does not establish production isolation or the absence of remote hidden account memory.

## 7. Regression checks

```powershell
npm run test:brain
python tools/test-setup.py
npm run check
npm run scan
npm run audit:docs
```

Task4 source checks (83 tests) and independent review passed. The local deployment has also been accepted with the default-port gateway, restart mapping, a fresh main-session smoke test, A/B isolation, background jobs and pagination. Capability acceptance is separate: search/web-fetch, image reading, Tabbit-owned Skill retrieval and gateway widget capture are verified; browser-task execution, `browser_control` execution, DSH embedded widget rendering and generic file attachments are not accepted as complete. See `D:/my-project/tabbit-capabilities-4efc/EXTENDED-CAPABILITIES.md` for evidence and scope.
