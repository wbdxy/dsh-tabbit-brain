# dsh-tabbit-brain

**English** | [简体中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) subagent
provider that gives a child agent a **clean, purpose-built system prompt**
instead of inheriting its parent's composition.

It exists because of a concrete, measured failure — see [Why](#why-this-exists).

---

> **Requires a signed-in Tabbit Browser account.** See [SETUP.md](SETUP.md) for the full walkthrough.

## Why this exists

DSH's built-in `spawn` / `fork` drivers compose a child agent with
`applyChildComposition(childCtx, parent, …)`: **the child inherits the parent's
preset**. If the parent preset is large — a router preset, a preset that mounts
a skill catalog, a preset that injects a persona frame — all of that lands in
the child's system prompt.

`persona` config can shadow *the persona section only*. It cannot remove the
other injected sections.

Measured on a real delegation to a model served by a local Tabbit gateway
(which has a hard input ceiling of roughly 20,500 characters):

| | before | after |
|---|---|---|
| child prompt sent upstream | **61,031 chars**, truncated to 18,635 | under the ceiling — no truncation |
| child session preset | inherited `router-standard` | **`tabbit-brain`** |
| child session size | — | 51 KB (parent: 5.1 MB) |
| what the model reported | *"this message is framework injection plus a skills list — there is no task"* | complete, correct deliverable |

The task was lost inside 61 KB of prompt the child could not use.

---

## How it works

DSH has three seams; this plugin uses all three.

**1. The `subagents` provider registry.** A provider is a small object:

```js
{ name, capabilities, inheritsParentContext, start(request), prepareContinuable() }
```

**2. `agentPresets.mount(agentCtx, id)`.** The agent factory's `setup` runs
inside the child's creation window and supports `async`. Instead of joining the
parent's composition:

```js
// built-in drivers do this — child inherits the parent preset
applyChildComposition(childCtx, parent, { persona, toolFilter })

// this plugin does this — child gets its own preset
await presets.mount(childCtx, opts.presetId)
```

A rejection rolls the agent creation back, so a broken preset never yields a
half-composed session.

**3. The skill catalog resolves against the preset layer.** DSH warns when an
agent joins no preset:

> its tools, prompt sections, and **skill catalog** resolve against the empty
> global layer

So a preset whose persona is `complete: true` (and which mounts no tool rows)
gets a genuinely clean prompt — later assembly listeners cannot add text.

Resulting shape:

```
main agent (full tools, large preset)
  └─ subagent_tabbit  ──►  provider "tabbit"
                             └─ child agent composed on preset "tabbit-brain"
                                  persona complete:true, ~926 chars, no tools
                                  routed to a Tabbit-gateway model
```

The child can reason but cannot act; the parent can act. That division is the
point.

---

## What this is built on

Everything here rests on one thing: **translating Tabbit's AI backend into an
OpenAI-compatible API**. The gateway is not a magic box — it is a specific set of
HTTP calls with signed headers, and all of it is written down:

**[REVERSE-PROXY.md](REVERSE-PROXY.md)** — the auth chain, the signing scheme
(including the trap where two header names mean the opposite of what they say),
the request shape, the input cap that caused a real failure, and what is known to
be imperfect.

Read it and every later step has something to stand on. Skip it and you can only
guess when something breaks.

## Before you install

Two things must be true on your machine, and neither can be automated:

1. **Tabbit Browser is installed and you are signed in.** Cookie renewal works by
   reading the session out of your own browser. No account, no cookies, no chain.
   Accounts are free; signing in is a hard prerequisite.
2. **You have somewhere to run the gateway.** This plugin keeps a gateway alive
   and delegates to it — it does not ship one. See the setup guide.

**Full walkthrough, step by step, with what you do versus what happens
automatically: [SETUP.md](SETUP.md)**

The short version of what is manual: deploy the gateway, install the plugin,
register the provider, create the child preset, mount the delegation tool.
The short version of what is automatic: starting the gateway, finding the browser
installation, renewing cookies, injecting the delegation guidance.

## Install

```bash
# from npm (once published)
dsh plugin --profile <profile> add dsh-tabbit-brain

# from a local checkout
dsh plugin --profile <profile> add link:/path/to/dsh-tabbit-brain
```

Then mount the delegation tool. Add a `tool-subagent` instance to your agent
preset:

```yaml
- id: tool-subagent-tabbit
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: tabbit            # matches providerName below
    toolName: subagent_tabbit
    backgroundMode: continuable
    # do NOT set persona      — the mounted preset provides the prompt
    # do NOT set agentOptions  — routing comes from this plugin's settings
```

> **Both omissions are deliberate.** `persona` is unnecessary because the child
> mounts a whole preset. `agentOptions` is actively harmful: it is resolved by
> `tool-subagent` into `request.agentOptions`, where it **outranks this plugin's
> settings** — setting a model in the settings UI would silently have no effect.

---

## The companion preset

The provider mounts whatever `presetId` names. You need that preset to exist.
A minimal one looks like this (DSH's shipped `minimal` preset is the template,
minus its persistent-shell rows):

```yaml
# ~/.dsh/.agent-presets/tabbit-brain/agent.cordis.yml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    complete: true                 # this prefix IS the whole system prompt
    includeRuntimeContext: false   # no runtime-context snapshot
    prefix: |-
      You are a pure reasoning unit. You have no tools: you cannot run
      commands, read or write files, or reach MCP servers or the skill
      registry.

      Your output is consumed by a main agent that DOES have those tools.
      So produce a self-contained deliverable — analysis, design, code,
      conclusion — and never say "I will read the file". If you need
      material, state exactly what you need and the caller will fetch it.

      Answer directly, accurately, and concisely. Do not fabricate.
```

No tool rows. Every tool schema is dead weight for a model that cannot call
tools — it burns the input budget and reads as an injection attempt.

---

## Configuration

Settings live under the `tabbit-brain` namespace and are **hot-reloaded**: the
provider re-reads them on every `start()`, so a change takes effect on the next
delegation with no plugin reload.

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `tabbit` | Registration name. Must match `provider:` in the tool config. **Changing it needs a plugin reload.** |
| `presetId` | `tabbit-brain` | Preset the child mounts. |
| `agentProvider` | `tabbit-local` | Default child route: DSH provider name. |
| `agentModel` | `DeepSeek-V4.1-Flash` | Default child route: model name. |
| `gatewayUrl` | `http://127.0.0.1:8787` | Gateway base URL; its `/healthz` is probed. |
| `gatewayAutoStart` | `false` | Keep the gateway up (see below). |
| `gatewayStartCommand` | *(empty)* | Shell command that starts the gateway. Empty disables auto-start. |
| `gatewayStartCwd` | *(empty)* | Working directory for that command. |
| `gatewayStartTimeoutMs` | `20000` | How long to wait for health after starting. |
| `diagnostics` | `false` | Write a diagnostic log. |
| `diagnosticsPath` | *(plugin dir)/trace.log* | Where that log goes. |

Precedence, lowest to highest:

```
deployment baseline (cordis.patch.yml config)
  → user settings (tabbit-brain namespace)
    → per-call override (when modelSelectionSettings is enabled)
```

### Diagnostics

Turn `diagnostics` on when you need to confirm the preset mount actually ran:

```
2026-10-05T09:37:59.902Z  setup OK: mounted preset "tabbit-brain" for child 4904ad0b-…
2026-10-05T09:40:38.825Z  settings changed -> preset="tabbit-brain" route=tabbit-local/DeepSeek-V4.1-Flash
```

If the mount fails you get `setup FAILED: mount("…") threw: …` and the child
creation is rolled back rather than silently running under the wrong preset.

---

## Gateway management

A local gateway is a separate process. Forgetting to start it — or losing it to
a crash — shows up as a confusing network error halfway through a delegation.
Enable `gatewayAutoStart` and the plugin starts it **on demand**:

- **Nothing runs at load time.** The gateway is started by the first delegation
  that needs it, so you do not pay for a resident process you might not use.
- Before **every** delegation the gateway's `/healthz` is probed (cheap loopback
  call, results cached for 15 s). If it is unreachable, `gatewayStartCommand` is
  run detached and the plugin polls until health returns.
- If it still is not up, the delegation **fails fast** with an actionable message
  instead of a mystery network error.

```yaml
gatewayUrl: http://127.0.0.1:8787
gatewayAutoStart: true          # start it when a delegation needs it
gatewayWarmup: false            # true = also start it when DSH loads
gatewayStartCommand: node "src\server.mjs"
gatewayStartCwd: ~/.tabbit-gateway/tabbit-toy
gatewayStartTimeoutMs: 30000
```

Set `gatewayWarmup: true` if you would rather trade a resident process for a
faster first delegation.

Two details worth knowing:

- **Liveness is any HTTP response.** The probe does not check the status code:
  a gateway that authenticates before routing replies `401` to a keyless probe,
  and that still proves the process is alive. (An earlier version required `2xx`
  and therefore concluded the gateway was permanently down.)
- **The spawned process is detached**, so it outlives DSH. If you already keep
  the gateway alive some other way — a service manager, a scheduled task — leave
  `gatewayAutoStart` off; this is a safety net, not a supervisor.

### Where the browser fits (and why this plugin does not manage it)

Some gateways renew their session cookie by reading it out of a browser over CDP.
An earlier version of this plugin managed that browser — starting it, keeping it
alive to hold the debug port open. That was the wrong place for it, and the wrong
shape.

**The gateway owns its cookies**, and the clean way to read them is a
**short-lived headless instance**: launch a windowless browser with the debug
port, read the cookies, kill it immediately. Measured on that path — no visible
window at any stage, a valid token on the first try, and no resident process
afterwards.

The reason it has to be short-lived is worth stating, because it is not obvious:
a resident headless instance holds the profile lock, so when the user later opens
their browser normally it hands off to that invisible instance and **nothing
appears on screen**. An ephemeral instance never gets in the way — and as a bonus
there is no launch race with other plugins that also drive the browser.

So this plugin does exactly one thing: **keep the gateway available.** If you want
the cookie behaviour, it lives on the gateway side.

`ensureGateway` and `pingGateway` are exported for use in your own tooling:

```js
import { ensureGateway } from 'dsh-tabbit-brain'

const result = await ensureGateway({ gatewayAutoStart: true, gatewayUrl: '…', gatewayStartCommand: '…' })
// -> { ok: true, action: 'started' | 'already-running' | 'cached' }
```

---

## What ships with the plugin, and what you create

A note on how the guidance reaches your agent — because "copy this into your
`AGENTS.md`" does not scale to other people's installs.

**The behavioural guidance ships inside the plugin.** It registers a system
prompt section (`plugin:tabbit-brain-guidance`) that tells the agent how to
position the delegated model — peer in reasoning, no hands, no memory, and
crucially that a reply is a *claim* to be checked rather than a fact. Every
session of every install gets it automatically. You do not write anything into
`AGENTS.md`, and nothing breaks if you never touch that file.

**Your `AGENTS.md` stays yours.** Use it for what is specific to your machine:
paths, ports, which models you standardised on, local quirks. That is the split
the plugin is built around — a plugin can only carry what is true everywhere,
and a user's own instructions file is the right place for everything else.

**One thing you do create by hand: the companion preset.** A preset lives in
`~/.dsh/.agent-presets/`, which is user state, not package content — so it cannot
ride along in the tarball. Copy the template from
[The companion preset](#the-companion-preset) once per machine.

| Piece | Ships with the plugin? | Where it lives |
|---|---|---|
| Provider, tool wiring, gateway/browser management | yes | the package |
| Delegation guidance (prompt section) | yes | injected at load |
| Settings section (`tabbit-brain`) | yes | the package |
| **The child preset** | **no** | `~/.dsh/.agent-presets/<id>/` |
| Machine-specific notes | no — and shouldn't | your `AGENTS.md` |

## Verifying it works

After installing, delegate once and confirm the child session recorded the
preset you expect:

```bash
python tools/verify_tabbit_brain.py
```

It checks three things: the plugin loaded, the settings section registered, and
the most recent subagent sessions were composed on your preset rather than the
parent's.

---

## Caveats

- **One-shot only.** `prepareContinuable()` resolves to `{}`; this provider does
  not implement continuable children.
- **`providerName` is fixed at construction.** The `subagents` registry keys
  providers by name, so renaming requires reloading the plugin.
- **No `outputSchema` capability.** Structured-output children are not supported.
- **The child is not sandboxed from *reading* — it simply has no tools.** The
  isolation here is about prompt composition, not permissions.
- **Peer dependency on internal DSH packages.** This plugin composes against
  `@deepseek-ai/dsh-subagent`, `dsh-agent`, `dsh-session`, `dsh-llm`, and
  `dsh-agent-presets`. Those are not a stable public API; a DSH upgrade may
  require changes here. Each usage is annotated with where it was verified in
  DSH's source.

---

## Development

Plain ESM, no build step. `lib/index.js` is the artifact.

```bash
npm run check     # node --check lib/index.js
```

For a local plugin directory to resolve `@deepseek-ai/*`, point its
`node_modules` at your DSH installation (junction on Windows, symlink
elsewhere). `tools/` holds the scripts used during development — they are
diagnostics, not part of the published package.

---

## License

[MIT](LICENSE)
