# Private Brain Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the DSH child-agent Tabbit path with a plugin-owned, persistent, text-only Brain service that ordinary main agents and ordinary DSH child agents can call through `tabbit_brain`, while preserving gateway lazy start and route evidence.

**Architecture:** `BrainService` owns SQLite-backed conversations, messages, and jobs. `brain-tool.js` exposes main-agent tools in each ordinary agent scope and sends requests directly to the local OpenAI-compatible gateway; it never creates a DSH child agent. Each conversation is scoped by `(ownerSessionId, conversationId)`, same-conversation requests serialize, different conversations can run concurrently, and every successful result carries request/model/endpoint evidence. The gateway remains responsible for Tabbit cookies and remote-session behavior; local history isolation must not be presented as remote-session isolation until explicitly verified.

**Tech Stack:** Node.js ESM, built-in `node:sqlite` after runtime verification, DSH `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-jobs`, YAML settings, existing Node fixture servers, Python setup regression tests.

## Global Constraints

- Node engine remains `^22.19.0 || >=24.0.0`; verify `node:sqlite` availability before implementation.
- The first release has no UI panel, autonomous Brain loop, recursive Brain-to-agent calls, or remote public API.
- Brain requests must never include `tools` or `tool_choice`.
- Gateway URL must remain loopback-only (`127.0.0.1`, `localhost`, or `::1`).
- API keys must come from an environment variable; never log, persist, or include them in receipts.
- Existing Tabbit cookie acquisition remains gateway-owned; do not extract browser credentials in the plugin.
- Ordinary main agents and ordinary DSH child agents may use `tabbit_brain`; the Brain service itself creates no DSH child agent.
- `router-standard` stage startup remains its own contract: `phase_begin` is required where that preset requires it; the plugin must not auto-advance stages.
- Existing DSH-shipped presets must not be edited. User-owned legacy `tool-subagent-tabbit` rows are documented as removable, not silently rewritten.
- Every behavior change needs a failing test before implementation and a passing regression after implementation.
- No tag or remote publish is part of implementation; commit locally only after the user reviews the completed plan/results.

---

## Task 1: Establish the persistence/runtime boundary

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/brain-store.js`
- Test: `tools/test-brain-store.mjs`

**Interfaces:**
- Produces `BrainStore.open(path)`, `createConversation(ownerSessionId, title, model)`, `listConversations(ownerSessionId, includeArchived)`, `getConversation(ownerSessionId, conversationId)`, `appendMessages(conversationId, messages)`, `listMessages(ownerSessionId, conversationId, limit, before)`, `setStatus(ownerSessionId, conversationId, status)`, `deleteConversation(ownerSessionId, conversationId)`, `createJob(...)`, `updateJob(...)`, and `close()`.
- Every public method must enforce owner scoping in SQL, not only in caller code.

- [ ] **Step 1: Verify SQLite runtime support before writing production code**

Run:

```powershell
node -e "import('node:sqlite').then(m => { const d = new m.DatabaseSync(':memory:'); d.exec('select 1'); d.close(); console.log('node:sqlite ok') }).catch(e => { console.error(e); process.exit(1) })"
```

Expected: `node:sqlite ok`. If this fails on the supported Node floor, stop and revise the plan to use a pinned userland SQLite package before continuing; do not silently ship an unverified storage backend.

- [ ] **Step 2: Write failing store tests**

Cover: schema creation, conversation creation/listing, owner isolation, message ordering, archive status, cascade delete, job status transitions, and reopening the same database after process restart.

- [ ] **Step 3: Run the store tests to confirm they fail**

Run:

```powershell
node tools/test-brain-store.mjs
```

Expected: failure because `lib/brain-store.js` does not yet provide the interface.

- [ ] **Step 4: Implement the minimal SQLite schema**

Use `DatabaseSync` with migrations executed transactionally:

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS conversations_owner_updated
  ON conversations(owner_session_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant')),
  content TEXT NOT NULL,
  request_id TEXT,
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation_created
  ON messages(conversation_id, created_at, id);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  prompt TEXT NOT NULL,
  request_id TEXT,
  error TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_owner_created
  ON jobs(owner_session_id, created_at DESC);
```

Store timestamps as integer milliseconds. Use prepared statements for all values; never build SQL with user content.

- [ ] **Step 5: Run the store tests and verify restart persistence**

Run the same command. Expected: all tests pass, including closing and reopening the database with messages and statuses intact.

- [ ] **Step 6: Commit the storage boundary**

```powershell
git add package.json package-lock.json lib/brain-store.js tools/test-brain-store.mjs
git commit -m "feat: add persistent Brain conversation store"
```

---

## Task 2: Move BrainService from memory to SQLite and direct gateway HTTP

**Files:**
- Modify: `lib/brain-service.js`
- Test: `tools/test-brain-service.mjs`

**Interfaces:**
- `BrainService(options)` accepts `{ dbPath, apiKeyEnv, gatewayUrl, agentModel, brainPrompt, contextBudgetChars, requestTimeoutMs }`.
- `ask({ owner, conversation, prompt, signal })` returns `{ conversationId, requestId, model, endpoint, content, usage }`.
- `list`, `read`, `archive`, `delete`, `reset`, `status`, and `cancel` delegate to the store and enforce owner scope.
- `dispose()` closes the store and aborts active requests.

- [ ] **Step 1: Extend the HTTP fixture with route and history assertions**

Add tests that record every request and assert:

```js
assert.equal(request.body.model, 'TEST_MODEL');
assert.equal('tools' in request.body, false);
assert.equal('tool_choice' in request.body, false);
assert.equal(request.headers.authorization, 'Bearer fixture-only');
```

Also assert that the response receipt contains the fixture endpoint and model, and that a second request in the same conversation receives only that conversation's history.

- [ ] **Step 2: Run the service tests to establish the failing persistence behavior**

Run:

```powershell
node tools/test-brain-service.mjs
```

Expected: the existing memory tests should fail or lack restart/list behavior until the store integration is implemented.

- [ ] **Step 3: Implement conversation creation and persisted message flow**

On the first `ask`, create a conversation row for `(owner, conversation label)` if absent. Load only the most recent complete message pairs that fit `contextBudgetChars`; never truncate the current prompt silently. On successful HTTP response, append user and assistant messages in one transaction. On any HTTP, parse, timeout, or abort failure, append neither message.

- [ ] **Step 4: Implement gateway route receipts and strict response validation**

Use `POST ${gatewayUrl}/v1/chat/completions`, `Authorization: Bearer ${apiKey}`, and a unique request id header. Reject non-2xx, empty content, and a response whose `data.model` differs from the requested model. Return the local endpoint, request id, model, and content without returning credentials.

- [ ] **Step 5: Run service tests and restart persistence tests**

Run:

```powershell
node tools/test-brain-service.mjs
```

Expected: direct HTTP, no tools, owner isolation, history, queueing, failure rollback, budget, cancellation, reset, archive/delete, and database-reopen tests all pass.

- [ ] **Step 6: Commit the service migration**

```powershell
git add lib/brain-service.js tools/test-brain-service.mjs
 git commit -m "feat: persist Brain conversations and route receipts"
```

---

## Task 3: Expose global Brain tools and job ownership

**Files:**
- Modify: `lib/brain-tool.js`
- Modify: `lib/index.js`
- Delete: `lib/global-tool.js` if no longer referenced
- Test: `tools/test-brain-tools.mjs`

**Interfaces:**
- Register `tabbit_brain`, `tabbit_brain_list`, `tabbit_brain_read`, `tabbit_brain_archive`, `tabbit_brain_delete`, `tabbit_brain_reset`, and `tabbit_brain_status` in every ordinary agent own scope, including ordinary DSH child agents.
- Exclude only the Brain service itself; do not exclude ordinary agents based solely on `origin: subagent`.
- Background `tabbit_brain` creates a job through the DSH jobs service but stores the durable row in `BrainStore`; the returned result must be retrievable through `tabbit_brain_status` and `tabbit_brain_read` using the owning main-session id.

- [ ] **Step 1: Expand the adapter tests with main and ordinary-child agents**

Use two isolated agent fixtures. Assert both receive the tools, repeated `agent/created` events do not duplicate registration, disposal removes tools and releases owner history, and the child agent calls the same Brain service rather than an agent factory.

- [ ] **Step 2: Add failing tests for list/read/archive/delete/status/reset**

Assert each tool uses the current owner session and rejects a conversation or job owned by another session. Assert list excludes archived rows by default, archive changes status, delete cascades messages, read paginates, and status reports queued/running/completed/failed/cancelled.

- [ ] **Step 3: Implement the tools with exact schemas**

Use these required fields:

```text
tabbit_brain: description, prompt, conversation?, run_in_background?
tabbit_brain_list: includeArchived?, limit?
tabbit_brain_read: conversationId, limit?, before?
tabbit_brain_archive/delete/reset: conversationId
tabbit_brain_status: jobId
```

Use `run_in_background: false` for foreground content and `true` for a job id. Do not expose `tools`, `tool_choice`, filesystem handles, or DSH child IDs in any Brain receipt.

- [ ] **Step 4: Remove the obsolete global tool installer and child-agent provider path**

Delete old `subagent_tabbit` registration, `TabbitBrainProvider`, `prepareContinuable`, child setup/mount code, and legacy preset-only settings. Keep the gateway settings, model, API-key env, prompt, budget, timeout, delegation style, and diagnostics settings.

- [ ] **Step 5: Run adapter tests and verify no child-agent API remains**

Run:

```powershell
npm run test:brain
node --check lib/index.js
```

Additionally assert that the source contains no `agentPresets.mount`, `agents.create`, `prepareContinuable`, or `subagent_tabbit` implementation references.

- [ ] **Step 6: Commit the tool boundary**

```powershell
git add lib/brain-tool.js lib/index.js tools/test-brain-tools.mjs
 git commit -m "feat: expose global persistent Brain tools"
```

---

## Task 4: Update configuration, setup assistant, docs, and cleanup

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `cordis.patch.yml`
- Modify: `scripts/setup.mjs`
- Modify: `README.md`, `README.zh.md`
- Replace: `SETUP.md`, `SETUP.zh.md`
- Modify: `CHANGELOG.md`
- Modify: `tools/verify_tabbit_brain.py`
- Modify: `tools/audit-docs.mjs` if its expectations change

**Interfaces:**
- The setup assistant registers only gateway/model route settings and does not create child presets or edit main preset tool rows.
- `cordis.patch.yml` configures `agentModel`, `apiKeyEnv`, `brainPrompt`, `contextBudgetChars`, `requestTimeoutMs`, gateway settings, `delegationStyle`, and diagnostics.

- [ ] **Step 1: Write documentation assertions before rewriting docs**

Add checks that docs say `tabbit_brain`, not `subagent_tabbit`; that setup no longer requires a child preset or main preset mount; that background results use job IDs; and that the gateway remote-session limitation is stated.

- [ ] **Step 2: Update setup assistant tests for the new contract**

Change fixtures so no `agent-presets/main` file is required. Assert setup creates or updates only settings and never creates `~/.dsh/.agent-presets/tabbit-brain` or appends a main-preset tool row. Keep dry-run, YAML failure, idempotence, and provider nesting tests.

- [ ] **Step 3: Implement setup assistant cleanup**

Remove child-preset and mount-preset writes. Make `--models` required, preserve safe YAML parsing, write only `llm-pi-ai.providers.<id>` when `--write-settings` is present, and document that CLI API-key arguments can appear in shell history; prefer the secure environment-variable path.

- [ ] **Step 4: Rewrite README and SETUP around the new flow**

The user path becomes:

```text
install Tabbit and sign in
→ deploy gateway
→ install plugin
→ set TABBIT_API_KEY and agentModel
→ restart DSH
→ call tabbit_brain
```

Document conversation list/read/archive/delete/reset, job ownership, SQLite path, retention, owner isolation, remote-session limitation, and the distinction between `tabbit_brain` and DSH child agents.

- [ ] **Step 5: Update changelog and package metadata**

Bump the package version only after all tests pass. Add the migration, SQLite persistence, tool surface, removal of child-agent setup, and known remote-session limitation. Do not create or push a tag in this plan.

- [ ] **Step 6: Run documentation and package gates**

```powershell
npm run check
npm run test:brain
python tools/test-setup.py
npm run scan
npm run audit:docs
node tools/audit-deadcode.mjs
```

- [ ] **Step 7: Commit the docs/config cleanup**

```powershell
git add package.json package-lock.json cordis.patch.yml scripts/setup.mjs README.md README.zh.md SETUP.md SETUP.zh.md CHANGELOG.md tools
 git commit -m "docs: document persistent Brain service setup"
```

---

## Task 5: Fresh-session host and real gateway acceptance

**Files:**
- Test only: existing session evidence and gateway log
- No production edits unless a test fails

**Interfaces:**
- Fresh DSH main session must expose `tabbit_brain` and `tabbit_brain_reset`.
- Ordinary DSH child agent must also expose `tabbit_brain`.
- Brain receipt must show requested model and loopback endpoint.

- [ ] **Step 1: Restart DSH to load the migration**

Do not use an old session. Create a fresh standard main conversation.

- [ ] **Step 2: Verify tool visibility**

Check the actual tool definition for `tabbit_brain`. For a staged preset, call its normal `phase_begin`; do not call `phase_advance` just to expose the tool.

- [ ] **Step 3: Run a foreground Brain request**

Use a small self-contained reasoning prompt. Assert the receipt has:

```text
model = configured agentModel
endpoint = http://127.0.0.1:8787/v1/chat/completions
conversationId exists
requestId exists
```

- [ ] **Step 4: Run a background Brain request**

Set `run_in_background: true`, record the job id, continue independent main-agent work, then query `tabbit_brain_status`/`tabbit_brain_read`. Assert no DSH child session was created.

- [ ] **Step 5: Test history and isolation**

Use owner A conversation `design` for two calls and confirm the second sees the first. Use owner A `debug` and owner B `design` and confirm neither sees the other. Archive, list, read, reset, and delete each with evidence.

- [ ] **Step 6: Test remote-session boundary explicitly**

Record the gateway's remote Tabbit session id for two local conversations. If both local conversations reuse one remote id, report that remote context isolation is not achieved; do not claim otherwise. If the gateway cannot create/select remote sessions, record that as a known limitation and keep local isolation guarantees separate.

- [ ] **Step 7: Test restart persistence**

Create one conversation, restart the Brain service/DSH, list it, read its messages, and confirm status/title survive. Do not claim remote history persistence unless the gateway evidence confirms it.

- [ ] **Step 8: Review evidence and only then mark complete**

Required evidence: tool visibility, foreground receipt, background job result, no child session, gateway request/model evidence, history isolation, restart persistence, and explicit remote-session result.
