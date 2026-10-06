# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.0] - 2026-10-06

### Changed

- Replaced the DSH child-agent integration with a **plugin-owned private Brain
  service**. Main agents now call `tabbit_brain` for text-only reasoning; the
  plugin sends a direct OpenAI-compatible request to the loopback gateway and
  does not create a DSH child agent, inherit tools, mount a child preset, or
  share the main conversation history.
- Background calls use DSH jobs and return job IDs; collect with `job_output`.
  Conversation history is keyed by main session plus label, same-label calls are
  serialized, failed turns are not stored, and `tabbit_brain_reset` clears idle
  history.
- The installed host entry is global for ordinary main agents; child agents are
  excluded. `router-standard` still needs its normal `phase_begin` startup gate.

### Added

- `lib/brain-service.js`, `lib/brain-tool.js` and regression tests for direct HTTP,
  no-tool requests, owner isolation, queueing, failure rollback, budgets,
  cancellation and reset.

### Known boundary

- The migration has passed unit and tool-adapter fixtures, but it still requires
  a fresh DSH session test proving the host tool is visible and a real gateway
  request carries the receipt model/endpoint. Remote Tabbit chat-session
  isolation is not proved by local history isolation.
- The current gateway overlay still contains upstream-derived source files;
  publishing an installer does not resolve upstream licensing. Obtain permission
  or a licence from upstream before public redistribution.

## [0.11.1] - 2026-10-06

### Fixed

- **Setup assistant configuration writes.** The first implementation used text
  insertion for YAML and had three concrete failures: `--dry-run` still wrote
  files, a new `llm-pi-ai` block could place the provider at the wrong level, and
  damaged YAML was not rejected before later writes. It now uses the `yaml`
  parser, validates the whole configuration before writing, writes the provider
  at `llm-pi-ai.providers.<id>`, preserves existing providers, and remains
  idempotent.

- Added isolated regression tests in `tools/test-setup.py` covering dry-run
  non-mutation, missing/empty/existing provider mappings, idempotence, and
  malformed configuration preservation. The suite passes: 3 tests, 0 failures.

- Verified the browser-running-without-CDP failure path again: the gateway
  returns immediately, reuses the old cookie, and leaves the user's visible
  browser window alive.

## [0.11.0] - 2026-10-06

### Changed

- **The shipped guidance now prescribes a workflow, not just a description.**

  The old text explained what the Tabbit model is — no tools, no memory, a claim
  rather than a fact — and left the decision to use it entirely to the moment. The
  measured result, over hours of substantive work, was nine delegations and all
  nine were "reply with two characters" availability probes. The capability was
  present and unused, and a description cannot fix that: it is permission, not a
  trigger.

  It now opens with an instruction: **decompose before starting non-trivial work.**
  Then a three-step protocol — split, sort by whether a part needs hands, and start
  the reasoning half in the background *while* doing the hands half. The point that
  was missing is the third: the built-in `tool:subagent_tabbit` section already
  explains the mechanics of background delegation, but nothing said to reach for it
  at the moment a task arrives.

  Six guardrails ship alongside it, because guidance that only says "delegate more"
  produces more waste than it saves: an independence test (needing the result to
  decide your next step is fake parallelism), never delegating verification, a
  minimum useful size (if briefing costs more than doing, do it yourself), output is
  a draft you own, do not parallelise work that can conflict, and the workspace
  boundary.

- New `delegationStyle` setting: `off` / `standard` (default) / `aggressive`.
  Delegation costs a round trip plus a written brief, and tolerance for that differs
  between users, so it is not ours to decide unilaterally.

### Note

The baseline and the verification are part of this change, not an afterthought: four
earlier changes in this project drifted precisely because they were made without
checking that the thing they described still matched. For this one the baseline is
recorded above, and the post-change behaviour is verified against the same composite
task plus two negative cases (pure hands work, and pure verification) that must
*not* trigger delegation.

## [0.10.2] - 2026-10-06

### Fixed

- **A cookie-renewal failure could kill the user's browser.** The cleanup path
  killed every process named `Tabbit Browser.exe` by image name, with no
  distinction between the instance we spawned and one the user was using.

  The path to it: the user has Tabbit open -> our headless spawn is handed off to
  their instance by Chromium's single-instance rule, so CDP never appears ->
  timeout -> the `finally` cleanup runs -> it kills their browser too. Found by
  testing exactly the scenario the plugin is meant to support.

  Cleanup now records the Tabbit process IDs that existed *before* the spawn and
  kills only ones that appeared after it. A user's browser is never in that set.

- The same case no longer burns 45 seconds before failing. If Tabbit is already
  running without a debug port, the attempt is pointless — single-instance
  hand-off guarantees the port never appears — so it now returns immediately with
  `browser-running-without-cdp` and reuses the existing cookie.

### Documented

- **When cookie renewal works, and the one case that needs the user**, in
  `gateway-patch/README.md` and both setup guides. Renewal is scheduled (gateway
  start, every 6 hours, on auth errors), so the deciding factor is the state *at
  that moment*, not who opened the browser or whether the cookie had expired:

  | state at that moment | result |
  |---|---|
  | Tabbit not running | windowless instance reads the cookie, then dies |
  | Tabbit running with a debug port | read straight from it |
  | Tabbit running, normal launch | renewal skipped, existing cookie reused |

  Only the third case ever needs the user, and only once the cookie has actually
  expired: quit Tabbit completely and the next renewal succeeds. Skipping is not
  breaking — the existing cookie is reused, usually for hours or days.

## [0.10.1] - 2026-10-06

### Fixed

Documentation drift: four places described behaviour the code no longer had. All
four were introduced by *later* changes that did not go back and update the text
describing them.

- Both README config tables were missing `gatewayWarmup` — the setting that
  decides whether the gateway starts with DSH or waits for the first delegation.
  Eleven fields were listed; the schema has twelve.
- The setup overview still called deploying the gateway "awkward, see below",
  from before `gateway-patch/install.mjs` reduced it to one command.
- The Development section said `tools/` was not part of the published package.
  It is — it is listed in `files` and contains user-runnable audits, now
  documented as a table instead of a dismissal.
- `REVERSE-PROXY{,.zh}.md` linked to `../gateway-patch/README.md`, which from
  the repository root points outside it.

### Added

- **`tools/audit-docs.mjs`** (`npm run audit:docs`) — checks internal links,
  repository path references, `npm run` targets, the config table against the
  code schema, version agreement between `package.json` and the CHANGELOG, and
  EN/ZH section-count symmetry. It reports zero findings after the fixes above.

  It exists because this class of drift is invisible to review: every individual
  document reads correctly, and only a comparison against the code reveals that
  it describes an older design.

## [0.10.0] - 2026-10-05

### Added

- **`REVERSE-PROXY.md` / `REVERSE-PROXY.zh.md`** — the reverse-proxy operations,
  documented as a step in their own right rather than left implicit.

  This was missing and it mattered: the project shipped an installer and patches
  but never explained *what the gateway actually does*. Everything else here —
  registering a provider, creating a preset, tuning prompts — only makes sense
  against that mechanism, and every later troubleshooting question lands there.

  The document covers the two-legged auth chain (session cookie + signing key, and
  why the cookie can only come from a browser), the signing scheme **including the
  trap that two header names mean the opposite of what they say**
  (`x-signature` is a random UUID; `x-nonce` is the HMAC), the chat payload shape
  and why an existing session id is mandatory, the ~20,500-character input cap that
  caused a real task-loss failure, why images carry no pixel data, and the known
  imperfections including error 492 being misread as an auth failure.

  The knowledge came from the upstream project's analysis and was **re-checked
  against the code and our own experiments**; three details did not survive that
  check and were corrected before publishing (the device-id derivation, and two
  length figures).

- Setup guides now open with **Step 0: understand the reverse proxy first**, and
  both READMEs link it above the install instructions.

### Fixed

- Removed a leftover Windows scheduled task that started the gateway **at logon**.
  It predated the lazy-start design and directly contradicted it: a resident Node
  process before any delegation, **bypassing the `gatewayWarmup` setting** so the
  user could not turn it off. Nothing auto-starts now; the gateway comes up in
  about two seconds when a delegation needs it. (Task XML backed up, reversible.)

## [0.9.0] - 2026-10-05

### Added

- **`tools/audit-deadcode.mjs`** — finds unused exports, orphan files, unused
  imports, stray `console.*` in library code, leftover task markers,
  commented-out code, and empty functions. It reports nothing today; what it caught first is below.

- **`.gitleaks.toml`** — configuration for [gitleaks](https://github.com/gitleaks/gitleaks),
  the industry-standard scanner, so the scan can be a CI gate. The allowlist is
  deliberately narrow: the project's documented local default key, obvious doc
  placeholders, and environment-variable reads. Everything else is a real signal.

### Added

- `~` is expanded in `gatewayStartCwd`. Node's `spawn({ cwd })` does not do this,
  so a config written as `~/.tabbit-gateway/tabbit-toy` failed silently and
  surfaced as "the gateway will not start" — one of those failures whose symptom
  sits nowhere near its cause.

### Fixed

- Two hardcoded personal paths in `tools/test_gateway_autostart.mjs`, in both a
  comment and a config value. The gateway directory now comes from an argument,
  an environment variable, or `~/.tabbit-gateway/tabbit-toy`.

- Three unused imports (`join` in the gateway's `config.mjs`, `statSync` twice)
  and three over-exported functions in `detect.mjs` that only its own
  `detectInstallations` used.

- **`tools/scan-secrets.mjs` had two blind spots that made it report "clean"
  falsely**: it did not scan `.py` at all (so a personal path in a Python tool survived),
  and its Windows-path rule matched only backslashes (so the forward-slash form
  YAML prefers survived). A scanner that reports clean while blind is worse than
  no scanner, because it buys false confidence.

### Verified

Three gates, all green before this commit:

| gate | result |
|---|---|
| `npm run scan` (built-in) | 24 files, 0 blocking hits |
| `tools/audit-deadcode.mjs` | 0 findings |
| `gitleaks git .` (full history) | no leaks, exit 0 |

A control run against the real gateway directory **did** report 3 leaks including
the live cookie — which is what proves the allowlist is not simply swallowing
everything.


### Changed

- **License: BSD-3-Clause to MIT**, matching `dsh-tabbit`, the official Tabbit
  plugin, so the ecosystem stays consistent.

- Repository metadata now points at the real location rather than a placeholder
  username.

### Fixed

- `tools/verify_tabbit_brain.py` hardcoded a personal path. It now derives the
  plugin directory from the script's own location.

- `tools/scan-secrets.mjs` did not scan `.py`, `.toml`, `.ini`, `.cfg`, `.conf`,
  `.sh`/`.zsh`, `.bat`, or several other text extensions — which is exactly how
  the path above survived a first pass that reported clean. The extension set now
  covers the languages this repo actually uses.


### Added

- **`gateway-patch/`** — one command to deploy the gateway, which was previously
  "clone a third-party repo and hand-apply patches". `install.mjs` clones upstream
  on *your* machine and overlays our changed files.

  It is an installer rather than a fork for a concrete reason: **upstream
  `goehou/tabbit-toy` ships no LICENSE file**, which defaults to all rights
  reserved. Not redistributing their code keeps this clean, and as a side effect
  upstream fixes flow in on the next run.

  Four files are involved: `detect.mjs` (new — browser/profile auto-detection),
  and `cdp.mjs` / `config.mjs` / `server.mjs` (modified — the short-lived headless
  cookie acquisition and its wiring).

- **`tools/scan-secrets.mjs`** — a pre-release scan, runnable as `npm run scan`.
  Two severity levels: `block` (JWT blobs, API keys, private keys, personal
  paths, real cookies, private keys) and `review` (emails, IPs, ambiguous
  assignments). It covers the categories a release scrub normally needs —
  credentials, personal paths, hostnames/IPs, identity data, internal URLs,
  placeholder residue.

- Hardened `.gitignore`: credentials (`.env` and variants) and every backup
  suffix the tooling produces are excluded, verified with `git check-ignore`.

### Fixed

- `tools/test_plugin_chain.mjs` contained a hardcoded personal path in both a
  comment and a config value. It now resolves the gateway directory from an
  argument, an environment variable, or `~/.tabbit-gateway/tabbit-toy`.

## [0.8.0] - 2026-10-05

### Added

- **`scripts/setup.mjs`** — turns the hand-editing steps into commands. It creates
  the child preset, registers the provider in `settings.yaml`, and mounts the
  delegation tool in your main preset.

  Design rules it follows, because a setup script that surprises people is worse
  than no setup script:

  - **Add and back up only.** Existing entries are skipped, not overwritten
    (`--force` to override), and every write is preceded by a `.bak-setup-*` copy.
  - **`--dry-run` by default behaviour is explicit**: without `--write-settings`
    the script prints what it would add and touches nothing.
  - **Every value only the user can supply is an explicit flag**, and `--help`
    marks them with ★ and says where each one comes from — the gateway API key,
    the model ids, and the preset to mount into. The script invents no guesses
    about your environment.

- `npm run setup` as a shorter entry point.

### Documented

- The setup guides now lead each step with a command, and add a
  **"values only you can provide"** table: option, where it comes from, and what
  happens if you omit it.

## [0.7.0] - 2026-10-05

### Added

- **Startup prerequisite checks.** On load the plugin verifies the things a user
  has to do by hand and cannot be automated, and warns clearly when one is
  missing. The important one is the child preset: it lives in user state and
  therefore cannot ship with the plugin, which makes it the easiest step to miss
  and the hardest failure to diagnose — the symptom is a delegation error that
  points nowhere near the cause. The check also verifies the preset actually sets
  `complete: true`, since without it the parent's prompt sections leak into the
  child and bury the task.

  Warnings never block loading: the plugin stays usable so the user can reach
  settings and fix the problem.

### Documented

- **`SETUP.md` / `SETUP.zh.md`** — a complete walkthrough for a fresh machine,
  built around one question: *what do I have to do before this works?* It
  separates the work explicitly into what the user must do and what happens
  automatically, and it leads with the prerequisite that cannot be automated:

  **Tabbit must be installed with a signed-in account.** Cookie renewal reads the
  session out of the user's own browser, so without an account there are no
  cookies and the entire chain is dead. A README that omits this leaves a new
  user staring at a failure whose cause is nowhere near the symptom.

- A **Platform support** section stating plainly that only Windows has been
  verified, and naming the two Windows-specific dependencies (process management
  via `tasklist`/`taskkill`, and registry-based browser detection).

- A **Known rough edges** section that says the quiet part out loud: step 1
  (deploying the gateway) currently means cloning a third-party project and
  hand-applying patches, which is not good enough for open-source distribution.

- Both READMEs now open with the account prerequisite and link to the setup guide.

### Changed

- Browser detection no longer relies on the configured executable path being
  correct: `TABBIT_EXE` and `TABBIT_USER_DATA_DIR` are auto-detected when empty
  (Windows uninstall registry, then standard locations, then macOS). A hardcoded
  path was correct on exactly one machine.

  The detection deliberately matches on *"name contains tabbit, case-insensitive"*
  rather than an English display-name whitelist: the registry entry on a Chinese
  system is named `Tabbit浏览器`, so any English-only lookup silently finds
  nothing.

## [0.6.0] - 2026-10-05

### Changed

- **Browser management removed from the plugin.** The gateway now acquires its own
  cookies with a **short-lived headless instance**: on a refresh it launches a
  windowless browser with the debug port, reads the cookies, and kills it
  immediately. Measured on that path — no visible window at any stage, 5 cookies
  and a valid token on the first try, and no resident browser process afterwards.

  This is strictly better than the previous arrangement, in three ways:

  1. **Nothing resident.** The earlier design kept a browser alive to hold the
     debug port open. There is now no process at all between refreshes.
  2. **The user's browser is untouched.** A resident headless instance holds the
     profile lock, so a later ordinary launch hands off to an invisible instance
     and nothing appears on screen. An ephemeral instance never gets in the way.
  3. **The cross-plugin race disappears.** Another plugin may start the browser
     too; with an ephemeral instance there is nothing to race over.

  A critical implementation detail: **spawning the browser binary directly does
  not add `--user-data-dir`** — only the browser's own launcher does. Headless
  without it lands on an empty profile: the page loads, but zero cookies for the
  site. Passing the real profile directory is what makes the session readable.

- Removed `browserCdpUrl` / `browserAutoStart` / `browserExe` /
  `browserStartTimeoutMs` and the exported `ensureBrowser` / `pingBrowser`. The
  plugin now does one thing: keep the gateway available.

## [0.5.0] - 2026-10-05

### Fixed

- The default `diagnosticsPath` resolved relative to the module file, so it
  landed in `lib/trace.log` instead of the plugin root. It now points at
  `<plugin>/trace.log`, where a reader actually looks for it.

### Added

- **Shipped delegation guidance.** The plugin now registers a system prompt
  section (`plugin:tabbit-brain-guidance`, order 2810 — next to the built-in
  `TOOL_SUBAGENT` slot) describing how to position the delegated model: a peer in
  reasoning quality, no tools, no memory, and — the operationally important part
  — that its reply is a *claim* to be checked rather than a fact.

  This exists because a README instruction to "copy this into your `AGENTS.md`"
  does not reach other people's installs. Guidance that has to apply everywhere
  belongs in the package; a user's own instructions file is for what is specific
  to their machine.

### Documented

- Added a design note to both READMEs explaining why the plugin manages the
  browser rather than shipping a launcher: single-instance hand-off means the
  install ends up in one of two asymmetric states depending on who starts the
  browser first, and a launcher only wins that race if the user remembers it
  every time. Starting it automatically removes the race instead of asking the
  user to win it.

### Added

- **Browser management.** `browserCdpUrl` / `browserAutoStart` / `browserExe` /
  `browserStartTimeoutMs`. Before each delegation the CDP endpoint is probed, and
  a browser that is not running is launched in the background with its debug port
  so cookie renewal can work. The judgement is **endpoint reachability, not
  process presence**: a browser running without a debug port cannot be taken over
  (single-instance hand-off means the port never appears) and is reported as
  `running-without-cdp` rather than waited on.

  This replaces the earlier advice to launch the browser through a special
  shortcut. Requiring users to change how they open their browser pushes an
  implementation detail onto them and breaks the first time they forget.

  A failed browser start does not abort the delegation — a still-valid cookie is
  enough to reach the model. Only a failed gateway start aborts.

- `ensureBrowser()` and `pingBrowser()` are exported.

### Verified

From a fully stopped state (no browser, no CDP, no gateway):

| step | result |
|---|---|
| `ensureBrowser` | `ok=true action=launched` in 1.6 s |
| `ensureGateway` | `ok=true action=started` in 1.0 s |
| end-to-end chat completion | HTTP 200, model replied |

## [0.3.0] - 2026-10-05

### Changed

- **Gateway startup is lazy by default.** The plugin no longer probes the gateway
  when it loads; the first delegation that needs it does the probe and starts it.
  A resident gateway process is no longer the price of enabling management. Set
  the new `gatewayWarmup: true` to get the old behaviour back — start with DSH
  and trade a resident process for a faster first delegation.

  Per-delegation behaviour is unchanged: before every delegation the gateway is
  probed, and an unreachable gateway is started and awaited.

## [0.2.0] - 2026-10-05

### Added

- **Gateway management.** `gatewayUrl` / `gatewayAutoStart` / `gatewayStartCommand` /
  `gatewayStartCwd` / `gatewayStartTimeoutMs`. When enabled, the gateway's `/healthz`
  is probed before every delegation; an unreachable gateway is started detached and
  polled until healthy. A still-unreachable gateway fails the delegation fast with
  an actionable message instead of a mid-run network error.
- `ensureGateway()` and `pingGateway()` are exported for reuse in other tooling.

### Fixed

- Liveness probing required an HTTP `2xx` and therefore concluded the gateway was
  permanently down. Gateways commonly authenticate before routing and answer a
  keyless probe with `401`; **any** HTTP response now counts as alive.
  Verified: with the gateway stopped, auto-start brought it back in 1.0 s.

## [0.1.0] - 2026-10-05

### Added

- Custom `subagents` provider (`tabbit`) that composes each child agent on a
  **named preset** via `agentPresets.mount()` instead of inheriting the parent's
  composition with `applyChildComposition()`.
- Settings section under the `tabbit-brain` namespace, hot-reloaded: changes to
  the child preset id and default route take effect on the next delegation
  without reloading the plugin.
- Localized field descriptions (zh / en) on the settings schema.
- Optional diagnostic log (`diagnostics`, off by default) that records whether
  the preset mount succeeded.

### Verified

The provider was built to fix a measured problem. On the same delegation task:

| | before | after |
|---|---|---|
| child prompt size | 61,031 chars (truncated to 18,635) | under the gateway limit, no truncation |
| child session preset | inherited `router-standard` | `tabbit-brain` |
| child session size | — | 51 KB vs 5.1 MB parent |
| model outcome | "there is no task in this message" | complete, correct deliverable |

[Unreleased]: https://github.com/wbdxy/dsh-tabbit-brain/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.12.0
[0.11.1]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.11.1
[0.11.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.11.0
[0.10.2]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.10.2
[0.10.1]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.10.1
[0.10.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.10.0
[0.9.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.9.0
[0.8.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.8.0
[0.7.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.7.0
[0.6.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.6.0
[0.5.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.5.0
[0.4.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.4.0
[0.3.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.3.0
[0.2.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.2.0
[0.1.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.1.0
