# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/wbdxy/dsh-tabbit-brain/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.9.0
[0.8.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.8.0
[0.7.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.7.0
[0.6.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.6.0
[0.5.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.5.0
[0.4.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.4.0
[0.3.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.3.0
[0.2.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.2.0
[0.1.0]: https://github.com/wbdxy/dsh-tabbit-brain/releases/tag/v0.1.0
