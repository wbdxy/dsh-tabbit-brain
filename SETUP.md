# Setup

**English** | [简体中文](SETUP.zh.md)

This document answers one question: **on a fresh machine, what do I have to do
before this works?**

---

## Step 0: understand the reverse proxy first (**recommended**)

The entire project rests on one thing: **translating Tabbit's AI backend into an
OpenAI-compatible API**. Every later step — deploy the gateway, register the
provider, create the preset — only exists to support that.

So read [`REVERSE-PROXY.md`](REVERSE-PROXY.md) first. It covers:

- why authentication needs **two legs** (session cookie + signing key), and why the
  cookie can only come from a browser
- how a request is signed, including the trap where **two header names mean the
  opposite of what they say**
- the chat payload shape, and **why an existing session is mandatory**
- the input-length cap (~20,500) and the real failure it caused — **which is where
  this plugin's separate-preset design comes from**
- why images are "understood" but carry no pixel data
- what is known to be imperfect (including error 492 being misread)

**You can install without reading it, but then you can only guess when something
breaks.** Every reverse-proxy detail lives there.

---

## At a glance

| Step | Who | Feasible? |
|---|---|---|
| **Read how the reverse proxy works** | **you** | recommended; you can install without it, but then you can only guess |
| **Install Tabbit Browser and sign in** | **you** | ⚠️ **Required — nothing works without it** |
| Install Node.js 22+ and DSH | you | required |
| Deploy the gateway (clone upstream + overlay our changes) | you | **one command** (the installer does it all) |
| Install this plugin | you | one command |
| Register the provider in `settings.yaml` | you | copy-paste |
| Create the child preset | you | copy-paste |
| Mount the delegation tool in your preset | you | copy-paste |
| — | — | — |
| Start the gateway on demand | **automatic** | the plugin |
| Find the browser installation | **automatic** | the gateway |
| Renew cookies (short-lived headless) | **automatic** | the gateway |
| Inject the delegation guidance | **automatic** | the plugin |

> **Read this first**: if your Tabbit is not signed in, nothing downstream works.
> Step 1 is a hard prerequisite.

---

## Prerequisites

### 1. Tabbit Browser, with a signed-in account ← the important one

Cookie renewal works by **reading the session out of your own browser**. So:

- Tabbit Browser must be installed
- You must **register and sign in** to a Tabbit account
- Accounts are **free**; without signing in there are no cookies and the whole
  chain is dead

Verify — open Tabbit, confirm you are signed in, then check the profile exists:

```powershell
Test-Path "$env:LOCALAPPDATA\Tabbit Browser\User Data"
# expect: True
```

> Is a free account enough? Yes. Which models you can reach depends on your
> account tier and region; this plugin does not assume specific model names.

### 2. Node.js 22+

```powershell
node --version    # need v22.19+ or v24+
```

### 3. DSH

Installed and starting normally.

---

## Step 1: deploy the gateway

**Whose code is this**: the gateway is **not** part of this plugin. It is a fork of
`goehou/tabbit-toy`. This plugin only keeps a gateway *running*.

### Why an installer instead of a separate repo

We did **not** publish the gateway as its own repository. That is deliberate, and
the reason is licensing:

```
goehou/tabbit-toy  ->  GitHub API returns "Not Found" (no LICENSE file)
```

**No declared licence means all rights reserved by default**, so redistributing a
copy of it does not hold up.

So instead: the installer fetches it from the official repo **on your machine** and
overlays the files we changed. We ship only our own part.

A side benefit: **upstream fixes flow in naturally** — re-run the script and you
get their latest code plus our changes.

### One command (recommended)

```bash
node gateway-patch/install.mjs --dry-run     # show what it would do, write nothing
node gateway-patch/install.mjs               # do it
```

**Only you can supply these (★)**:

| Option | Notes | Default |
|---|---|---|
| ★ `--api-key <key>` | gateway auth key; **`TABBIT_API_KEY` on the DSH side must match** | `sk-tabbit-local` |
| ★ `--base-url <url>` | **domestic `https://web.tabbit.com`, international `https://web.tabbit.ai`** | domestic |

The rest (`--dir` / `--port` / `--repo` / `--ref`) have sensible defaults.
`node gateway-patch/install.mjs --help` lists everything.

It does four things: clone upstream, overlay our four changed files, write `.env`,
and tell you what is next. It is idempotent — an existing directory is backed up as
`*.upstream-bak` rather than blindly overwritten.

### The four files it overlays

| File | Kind | Purpose |
|---|---|---|
| `scripts/lib/detect.mjs` | **new** | browser/profile auto-detection |
| `scripts/lib/cdp.mjs` | modified | short-lived headless cookie read |
| `src/config.mjs` | modified | paths go through detection |
| `src/server.mjs` | modified | two-stage cookie refresh |

Why these changed, and the measurements behind them: [`gateway-patch/README.md`](gateway-patch/README.md).

### By hand (if you want control)

```powershell
# 1. get the source
git clone https://github.com/goehou/tabbit-toy
cd tabbit-toy
npm install

# 2. copy the four files from this project's gateway-patch/files/ into it
#    (the directory layout matches)

# 3. write .env
```

```ini
TABBIT_BASE_URL=https://web.tabbit.com     # international: https://web.tabbit.ai
PORT=8787
API_KEY=sk-tabbit-local                    # your choice - keep it consistent below
CDP_PORT=9222
COOKIE_REFRESH_MINUTES=360

TABBIT_AUTO_LAUNCH_BROWSER=1
# leave these empty - they are auto-detected
# TABBIT_EXE=
# TABBIT_USER_DATA_DIR=
```

### Verify

```powershell
cd <gateway-dir>
npm install          # if the installer said dependencies were missing
node src/server.mjs
```

Seeing this means it worked:

```
[server] cookie 自动刷新失败: fetch failed；改用短命 headless 实例取 cookie…
[server] [headless] 启动短命 headless 实例取 cookie（端口 9222）
[server] [headless] 已结束短命 headless 实例
[server] cookie 已自动刷新 (5 个, 长度 1370) [ephemeral]
```

**`[ephemeral]` means a windowless browser came up, the cookies were read, and it
was killed immediately.**

> If the log says `cookie 里没有 token`, your Tabbit is not signed in. Back to
> prerequisite 1.

---

## Step 2: install the plugin

```bash
dsh plugin --profile <your-profile> add dsh-tabbit-brain
```

> From a local checkout: `dsh plugin --profile <profile> add link:/path/to/dsh-tabbit-brain`

---

## Setup assistant: preview, then apply

Run in the plugin directory after installing package dependencies. `--models` is
required; use actual ids returned by the gateway's `/v1/models`.
Replace `<MAIN_PRESET>` with an existing main preset id and `<MODEL_IDS>` with
comma-separated model ids. `DSH_HOME` overrides the default `~/.dsh`.

```powershell
npm install --ignore-scripts --legacy-peer-deps
node scripts/setup.mjs --help
node scripts/setup.mjs --models "<MODEL_IDS>" --mount-preset "<MAIN_PRESET>" --write-settings --dry-run
node scripts/setup.mjs --models "<MODEL_IDS>" --mount-preset "<MAIN_PRESET>" --write-settings
```

| Option | Purpose and omission behaviour |
|---|---|
| `--models <id,id>` | Required; missing values stop setup. No automatic model discovery |
| `--mount-preset <id>` | Existing main preset; defaults to `agent-presets.default`. Missing id/file stops setup |
| `--api-key <key>` | Must match gateway `API_KEY`; default `sk-tabbit-local`. Arguments may appear in local process listings and shell history |
| `--base-url <url>` | LLM endpoint; default `http://127.0.0.1:8787/v1` |
| `--provider <name>` | LLM route name, default `tabbit-local`; distinct from subagent provider `tabbit` |
| `--preset-id <id>` | Child preset directory, default `tabbit-brain`; custom ids also require changing plugin `presetId` |
| `--profile <name>` | Checks profile existence; this script does not install the plugin |
| `--dry-run` | Previews every write; creates no files, directories or backups |
| `--write-settings` | Enables settings writes. Without it, child preset creation and main preset edits still happen; only `--dry-run` is fully read-only |
| `--force` | Replaces target LLM provider and child preset; an existing tool row in the main preset is preserved |

Setup parses settings and main-preset YAML before writing. Invalid YAML or mapping
types stop it before the first write. Existing files are backed up; values are
preserved, but settings comments and formatting may change. Multiple file writes
are not transactional: disk/permission failures can leave partial changes.
Check output and `.bak-setup-*` files before retrying.

## Step 3: register the provider

The apply command writes `llm-pi-ai.providers.tabbit-local`. This LLM route and
subagent provider `tabbit` are different names. A custom `--provider` also requires
changing the plugin's `agentProvider`. Set `agentModel` to an actual model id.

Store the gateway API key in PowerShell without pasting it into command history:

```powershell
$key = Read-Host 'Gateway API key' -AsSecureString
$plain = [System.Net.NetworkCredential]::new('', $key).Password
[Environment]::SetEnvironmentVariable('TABBIT_API_KEY', $plain, 'User')
$env:TABBIT_API_KEY = $plain
Remove-Variable plain, key
```

The value must equal gateway `.env` `API_KEY`. Restart DSH to inherit the new user
environment variable.

## Step 4: create the child preset

The apply command creates `preset.yml` and `agent.cordis.yml`. Existing child
presets are preserved by default. The `complete: true`, no-tool template is in
[The companion preset](README.md#the-companion-preset). Templates can ship in a
package; this plugin currently creates user-state files through the assistant or
requires manual creation.

## Step 5: mount the delegation tool

The assistant appends `tool-subagent-tabbit` to the existing main preset sequence;
an existing row with that id is preserved. Its configuration uses `provider: tabbit`,
`toolName: subagent_tabbit`, and `backgroundMode: continuable`. Keep plugin
`providerName` as `tabbit`, or manually update the tool row too. The script does
not insert into an existing nested delegation group.

## Step 6: verify

```powershell
$env:TABBIT_API_KEY = [Environment]::GetEnvironmentVariable('TABBIT_API_KEY', 'User')
Invoke-RestMethod 'http://127.0.0.1:8787/healthz' -Headers @{Authorization="Bearer $env:TABBIT_API_KEY"}
Invoke-RestMethod 'http://127.0.0.1:8787/v1/models' -Headers @{Authorization="Bearer $env:TABBIT_API_KEY"}
```

Health should return `ok: true`; the model list should include `agentModel`.
Restart DSH and request a real delegation. Confirm a model answer and the expected
preset in the child session. With diagnostics off, absent `trace.log` is normal
and does not prove the plugin failed to load. Isolated setup regression tests
require Python and PyYAML:

```powershell
python -m pip install PyYAML
python tools/test-setup.py
```

---

## Cookie renewal: the one case that needs you

**This is the most confusing part of using the plugin.**

Renewal does **not** only happen when the cookie expires — it is scheduled (at
gateway start, every 6 hours, and on any auth error).

| State at that moment | Result |
|---|---|
| **Tabbit not running, valid login present** | Gateway attempts an ephemeral headless read and cleanup |
| **Tabbit running, started with the debug port** | ✅ read straight from it. You notice nothing |
| **Tabbit running, started normally** | ⚠️ **this renewal is skipped**; the existing cookie is reused |

### Recovery and limits

Reading cookies does not register an account or sign in again, and cannot guarantee
recovery of a server-invalidated token. Browser absence, valid paths and a signed-in
profile permit an automatic read attempt; missing login or port conflicts can still
fail. A normal running browser without CDP makes the read skip; valid old cookies
remain usable. On authentication failure, sign in again if needed, save your work,
quit Tabbit completely, and retry delegation. You can explicitly trigger a read:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/admin/refresh-cookie' -Method Post -Headers @{Authorization="Bearer $env:TABBIT_API_KEY"}
```

This admin endpoint may return `ok: true` while retaining an old cookie after a
failed read. Check whether `lastCookieRefresh` changed and retry a model request;
`ok` alone does not prove the login is valid. Cleanup currently uses a before/after
PID difference; preservation of a pre-existing window was tested, but a user
launching another instance during the read remains insufficiently tested. Avoid
manually launching Tabbit while headless acquisition is in progress.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `cookie 里没有 token` | **Tabbit not signed in** | Open Tabbit and sign in |
| no cookies at all | profile directory not detected | set `TABBIT_USER_DATA_DIR` explicitly in the gateway `.env` |
| `未配置 Tabbit 可执行文件路径` | detection failed | set `TABBIT_EXE` explicitly |
| delegation says the gateway is unreachable | gateway not running, or the plugin's start command is wrong | check the plugin's `gatewayStartCwd` / `gatewayStartCommand` |
| the child answers off-topic, says it sees no task | preset missing or wrong | make sure `presetId` names a preset that exists and is `complete: true` |
| changed settings but the model did not change | the preset sets `agentOptions` | remove it (step 5) |
| empty model list | your tier/region lacks the model | check `curl /v1/models` |

---

## Platform support

**Only verified on Windows.** Known Windows dependencies:

- the gateway uses `tasklist` / `taskkill` to manage browser processes
- browser detection reads the Windows uninstall registry

macOS / Linux need those two ported; **they do not work today**.

---

## Known rough edges

**Step 1 no longer means hand-applying patches** — `gateway-patch/install.mjs`
does it in one command (clone + overlay + write config).

**But there is a limit we cannot fix**: upstream `goehou/tabbit-toy` ships **no
LICENSE file**, so the gateway cannot be published as its own repo (see step 1).
That leaves this project depending on the upstream repository staying reachable. If
it disappears or goes private, step 1 stops working.

If you get stuck at step 1, open an issue saying where.
