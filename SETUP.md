# Setup

**English** | [简体中文](SETUP.zh.md)

This document answers one question: **on a fresh machine, what do I have to do
before this works?**

---

## At a glance

| Step | Who | Feasible? |
|---|---|---|
| **Install Tabbit Browser and sign in** | **you** | ⚠️ **Required — nothing works without it** |
| Install Node.js 22+ and DSH | you | required |
| Deploy the gateway (third-party project + patches) | you | ⚠️ see below, currently awkward |
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

## Step 1: deploy the gateway ⚠️ currently the awkward step

**Be clear about this**: the gateway is **not** part of this plugin. It is a fork
of `goehou/tabbit-toy`. This plugin keeps the gateway *running*; it does not
provide one.

That is genuinely the roughest part of the setup, and we intend to publish the
gateway as its own repo (see "Known rough edges" below).

```powershell
# 1. get the gateway
git clone https://github.com/goehou/tabbit-toy
cd tabbit-toy
npm install
```

```ini
# 2. write .env (inside tabbit-toy/)
TABBIT_BASE_URL=https://web.tabbit.com     # use https://web.tabbit.ai internationally
PORT=8787
API_KEY=sk-tabbit-local                    # your choice — keep it consistent below
CDP_PORT=9222
COOKIE_REFRESH_MINUTES=360

# automatic cookie acquisition (short-lived headless instance)
TABBIT_AUTO_LAUNCH_BROWSER=1
# leave these empty — they are auto-detected
# TABBIT_EXE=
# TABBIT_USER_DATA_DIR=
```

**3. Apply the patches** (short-lived headless in `cdp.mjs`, auto-detection in
`detect.mjs`, the refresh logic in `server.mjs`). The patches ship with this
project, under `gateway-patch/`.

**4. Verify the gateway can get its own cookies**:

```powershell
cd tabbit-toy
node src/server.mjs
```

Look for this in the log:

```
[server] cookie 自动刷新失败: fetch failed；改用短命 headless 实例取 cookie…
[server] [headless] 启动短命 headless 实例取 cookie（端口 9222）
[server] [headless] 已结束短命 headless 实例
[server] cookie 已自动刷新 (5 个, 长度 1370) [ephemeral]
```

**Seeing `[ephemeral]` means it worked** — a windowless browser came up, the
cookies were read, and it was killed immediately.

> If the log says `cookie 里没有 token`, your Tabbit is not signed in. Go back to
> prerequisite 1.

---

## Step 2: install the plugin

```bash
dsh plugin --profile <your-profile> add dsh-tabbit-brain
```

> From a local checkout: `dsh plugin --profile <profile> add link:/path/to/dsh-tabbit-brain`

---

---

## Setup assistant: turn file editing into commands

Steps 3, 4 and 5 below otherwise mean hand-editing YAML. The plugin ships a
script that does them instead:

```bash
cd <plugin-dir>
node scripts/setup.mjs --help         # all options; ★ marks the ones only you can fill
node scripts/setup.mjs --dry-run      # show what it would change, touch nothing
```

### Values only you can provide

| Option | Where it comes from | If omitted |
|---|---|---|
| ★ `--api-key <key>` | **the `API_KEY` you set in the gateway `.env`** | falls back to `sk-tabbit-local`; a mismatch means everything 401s |
| ★ `--models <id,id>` | `curl <gateway>/v1/models -H "Authorization: Bearer <key>"` | the script prints the command instead of writing |
| ★ `--mount-preset <name>` | the preset your **main conversation** uses (e.g. `router-standard`) | it tries to infer it from `settings.yaml`, otherwise prints the snippet |
| `--profile <name>` | a directory under `~/.dsh/profiles/` | defaults to `desktop` |
| `--base-url <url>` | your gateway address | defaults to `http://127.0.0.1:8787/v1` |
| `--preset-id <id>` | the preset the child mounts | defaults to `tabbit-brain` |
| `--provider <name>` | provider registration name | defaults to `tabbit-local` |

### Common invocations

```bash
# print what would be added, change nothing (the default)
node scripts/setup.mjs --models DeepSeek-V4.1-Flash,GLM-5.3

# actually write (backs up to .bak-setup-* first)
node scripts/setup.mjs --models DeepSeek-V4.1-Flash,GLM-5.3 --write-settings --mount-preset router-standard
```

**What the script will not do**: it only adds and backs up. Existing entries are
**skipped, not overwritten** (use `--force` to override), every write is preceded
by a backup, and anything it cannot find it reports rather than guesses.

---

## Step 3: register the provider

**With the assistant** (recommended):

```bash
node scripts/setup.mjs --models <your-model-ids> --write-settings
```

**Or by hand.** Edit `~/.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    tabbit-local:                    # <- your chosen provider name
      displayName: Tabbit local gateway
      apiKeyEnv: TABBIT_API_KEY
      baseURL: http://127.0.0.1:8787/v1   # <- your gateway address
      models:
        - id: DeepSeek-V4.1-Flash    # <- ids your account actually has
          inputModalities: [text, image]
        - id: GLM-5.3                # <- same
          inputModalities: [text, image]
```

List what your account offers:

```bash
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer <your-key>"
```

Set the API key environment variable (**must equal `API_KEY` in the gateway `.env`**):

```powershell
[Environment]::SetEnvironmentVariable('TABBIT_API_KEY', '<your-key>', 'User')
```

---

## Step 4: create the child preset

**With the assistant** (recommended):

```bash
node scripts/setup.mjs     # creates ~/.dsh/.agent-presets/<presetId>/
```

**Or create the two files by hand** (contents below). Presets live in
`~/.dsh/.agent-presets/`, which is **user state, not package content** — they
cannot ship with the plugin, so every user creates them once.

---

## Step 5: mount the delegation tool

**With the assistant** (recommended):

```bash
node scripts/setup.mjs --mount-preset <the-preset-your-main-chat-uses>
```

**Or add the line by hand** (YAML below).

---

## Step 6: verify


Edit `~/.dsh/settings.yaml` and add an OpenAI-compatible provider:

```yaml
llm-pi-ai:
  providers:
    tabbit-local:
      displayName: Tabbit local gateway
      apiKeyEnv: TABBIT_API_KEY
      baseURL: http://127.0.0.1:8787/v1
      models:
        - id: DeepSeek-V4.1-Flash
          inputModalities: [text, image]
        - id: GLM-5.3
          inputModalities: [text, image]
```

> **Use the model ids your account actually has.** Run
> `curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer sk-tabbit-local"`
> and put those ids here. Availability differs by account and region.

Set the API key environment variable (same value as `API_KEY` in the gateway `.env`):

```powershell
[Environment]::SetEnvironmentVariable('TABBIT_API_KEY', 'sk-tabbit-local', 'User')
```

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

**Step 1 (the gateway) is the uncomfortable one** — asking users to clone a
third-party project and hand-apply patches is not good enough for an open-source
distribution. The plan is to publish the gateway as its own repo (patches
included), reducing that step to a single clone.

Until then, if you get stuck at step 1, open an issue saying where.
