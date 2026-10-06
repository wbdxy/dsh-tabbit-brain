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

Replace the placeholders. The host plugin registers `tabbit_brain` and `tabbit_brain_reset` for ordinary main agents; no child preset or manual `tool-subagent-tabbit` row is required.

## 3. Configure model and credentials

Set a user environment variable equal to gateway `.env` `API_KEY`:

```powershell
$key = Read-Host 'Gateway API key' -AsSecureString
$plain = [System.Net.NetworkCredential]::new('', $key).Password
[Environment]::SetEnvironmentVariable('TABBIT_API_KEY', $plain, 'User')
$env:TABBIT_API_KEY = $plain
Remove-Variable plain, key
```

Set `agentModel` to an id returned by `/v1/models`; keep `gatewayUrl` and `apiKeyEnv` aligned. `delegationStyle` accepts `off`, `standard` (default) and `aggressive`.

## 4. Restart and accept

Restart DSH and start an ordinary main conversation. Confirm `tabbit_brain` is visible. In a staged preset, complete its normal `phase_begin`; do not call `phase_advance` to fake completion.

```text
Give this self-contained reasoning task to tabbit_brain with run_in_background: true. Continue your own tool work, then collect the job result and verify it.
```

Acceptance requires a job ID, no DSH child session, a receipt containing the requested model and local endpoint, no `tools` or `tool_choice` in the gateway request, serialized same-label history, and independent labels.

## 5. Cookie recovery boundary

If Tabbit is closed, the gateway attempts a short-lived headless read of the existing login state and exits. If a normal browser is open without CDP, the read is skipped and the old cookie remains in use. If the server invalidated the token, sign in again, save work, quit Tabbit completely, then explicitly refresh:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/admin/refresh-cookie' -Method Post -Headers @{Authorization="Bearer $env:TABBIT_API_KEY"}
```

## 6. Regression checks

```powershell
npm run test:brain
python tools/test-setup.py
npm run check
npm run scan
npm run audit:docs
```

Fixtures pass locally; fresh-session host verification and real gateway receipts are required before declaring runtime integration complete. Local history isolation does not prove remote Tabbit chat-session isolation.
