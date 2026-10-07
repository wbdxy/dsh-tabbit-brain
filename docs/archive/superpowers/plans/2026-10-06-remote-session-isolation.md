# Remote Tabbit Session Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind each local Brain conversation to one durable, independent Tabbit remote session and eliminate silent reuse of global `sessions[0]`.

**Architecture:** BrainService sends a validated local conversation ID in `X-Brain-Conversation-Id`. The gateway owns durable mappings to Tabbit `chat_session_id` values and coordinates allocation and recovery. Execution investigation confirmed `POST /panel/session` creates a dedicated session and `GET /panel/{id}/data` returns its message history: production Brain allocation must prefer newly created, visibly empty sessions over arbitrary unbound personal history. Legacy bindings stay reserved. See the execution addendum `D:/my-project/fresh-session-implementation-brief.md` and the recorded real probe evidence before fresh-session integration.

**Tech Stack:** Node.js ESM, native `node:test` or existing fixture style, native `fs` atomic replacement, existing Tabbit session discovery and SSE client, existing DSH BrainService HTTP fixture.

## Global Constraints

- Preserve Node engine `^22.19.0 || >=24.0.0`.
- Do not change the DSH UI, Tabbit Browser, or local Brain SQLite schema.
- Do not delete existing Tabbit remote history.
- Do not store or log cookies, API keys, complete prompts, or complete responses.
- Do not silently fall back to a shared remote session for Brain conversations.
- Keep the gateway loopback-only and preserve existing authentication behavior.
- Keep existing `X-Brain-Request-Id` behavior and add `X-Brain-Conversation-Id` only for Brain requests.
- Every behavior change requires a failing regression before implementation and a passing regression after implementation.
- Legacy requests without `X-Brain-Conversation-Id` remain supported through `__legacy_default__`.

---

## File map

- Modify `~/.dsh/plugins/dsh-tabbit-brain\lib\brain-service.js`: send `X-Brain-Conversation-Id` on gateway requests.
- Modify `~/.dsh/plugins/dsh-tabbit-brain\tools\test-brain-service.mjs`: assert the new header and retain existing HTTP/job coverage.
- Create `~/.tabbit-gateway/tabbit-toy\src\brain-session-map.mjs`: validate IDs, load/migrate/backup state, allocate sessions, serialize first allocation per local conversation, atomically persist metadata, and expose testable functions.
- Modify `~/.tabbit-gateway/tabbit-toy\src\server.mjs`: replace the global selected-session cache with session-list caching and mapping resolution; add one scoped retry and legacy routing.
- Modify `~/.tabbit-gateway/tabbit-toy\scripts\lib\tabbit.mjs`: preserve the existing `chat()` contract while keeping session discovery injectable for gateway tests if needed.
- Create `~/.tabbit-gateway/tabbit-toy\test\brain-session-map.test.mjs`: deterministic unit tests for mapping, persistence, concurrency, pool exhaustion, corruption recovery, and legacy separation.
- Create `~/.tabbit-gateway/tabbit-toy\test\server-session-routing.test.mjs`: fixture HTTP tests for Brain headers, resolved `chat_session_id`, retry isolation, and legacy behavior.
- Modify `~/.dsh/plugins/dsh-tabbit-brain\docs\acceptance-progress.md`: record the completed local-to-remote isolation evidence and any remaining Tabbit API limitation.

---

### Task 1: Add the Brain conversation request header

**Files:**
- Modify: `~/.dsh/plugins/dsh-tabbit-brain\lib\brain-service.js:33-36`
- Test: `~/.dsh/plugins/dsh-tabbit-brain\tools\test-brain-service.mjs`

**Interfaces:**
- Consumes: `conv.id` from `BrainStore`, existing `requestId`, and the existing gateway fetch call.
- Produces: every Brain gateway request includes `X-Brain-Conversation-Id: <conversation id>` and `X-Brain-Request-Id: <request id>`.

- [ ] **Step 1: Add a failing assertion to the HTTP fixture**

Extend the fixture request capture so each record includes request headers, then after the first call add:

```js
assert.equal(requests.at(-1).headers['x-brain-conversation-id'], receipt.conversationId);
assert.match(requests.at(-1).headers['x-brain-request-id'], /^[0-9a-f-]{36}$/);
```

- [ ] **Step 2: Run the focused service test and verify it fails**

Run:

```powershell
node tools/test-brain-service.mjs
```

Expected: FAIL because the conversation header is absent from the fixture request.

- [ ] **Step 3: Add the header at the fetch boundary**

Build the headers as:

```js
headers: {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${apiKey}`,
  'X-Brain-Conversation-Id': conv.id,
  'X-Brain-Request-Id': requestId,
},
```

Keep the existing body shape and response validation unchanged.

- [ ] **Step 4: Run the focused service test and verify it passes**

Run the same command. Expected: `PASS HTTP and durable jobs`.

- [ ] **Step 5: Commit the protocol boundary**

```powershell
git -C ~/.dsh/plugins/dsh-tabbit-brain add lib/brain-service.js tools/test-brain-service.mjs
git -C ~/.dsh/plugins/dsh-tabbit-brain commit -m "feat: identify Brain conversations at gateway"
```

---

### Task 2: Implement durable mapping state and deterministic allocation

**Files:**
- Create: `~/.tabbit-gateway/tabbit-toy\src\brain-session-map.mjs`
- Create: `~/.tabbit-gateway/tabbit-toy\test\brain-session-map.test.mjs`

**Interfaces:**
- `createBrainSessionMap({ statePath, accountKey, listSessions, now })` returns `{ resolve(conversationId), invalidate(conversationId, remoteSessionId), getSnapshot(), close() }`.
- `resolve(id)` returns `{ remoteSessionId, scope: 'brain' }` or throws an error with `code === 'REMOTE_SESSION_POOL_EXHAUSTED'`.
- `resolve('__legacy_default__')` uses the legacy scope and never consumes a session already bound to a Brain conversation.

- [ ] **Step 1: Write failing tests for state format and allocation**

The test fixture must provide sessions `['remote-a', 'remote-b', 'remote-c']` and a fake clock. Assert:

```js
const map = createBrainSessionMap({ statePath, accountKey: 'fixture', listSessions, now: clock.now });
assert.deepEqual(await map.resolve('brain-a'), { remoteSessionId: 'remote-a', scope: 'brain' });
assert.deepEqual(await map.resolve('brain-b'), { remoteSessionId: 'remote-b', scope: 'brain' });
assert.deepEqual(await map.resolve('brain-a'), { remoteSessionId: 'remote-a', scope: 'brain' });
assert.notEqual((await map.resolve('brain-a')).remoteSessionId, (await map.resolve('brain-b')).remoteSessionId);
```

Also test atomic persistence by creating a second map instance over the same path and resolving `brain-a` without calling the allocator again.

- [ ] **Step 2: Run the mapping test and verify it fails**

Run:

```powershell
node --test test/brain-session-map.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement validation, state load, and atomic persistence**

Use a state shape matching the approved spec:

```js
{ version: 1, accountKey, mappings: { [conversationId]: {
  remoteSessionId, assignedAt, lastUsedAt, useCount
} } }
```

Validate IDs as non-empty strings with a maximum length of 200. Write JSON to `${statePath}.tmp`, close the file, then replace the target. On parse or schema failure, rename the original to a timestamped `.corrupt-*` backup and start an empty state.

- [ ] **Step 4: Implement per-conversation allocation locks and pool exhaustion**

Maintain a `Map` of in-flight allocations. Return the same promise for concurrent `resolve('brain-a')` calls. Allocate the first session not present in any Brain mapping. If none exists, throw:

```js
Object.assign(new Error('no unbound Tabbit session is available for this Brain conversation'), {
  code: 'REMOTE_SESSION_POOL_EXHAUSTED',
});
```

Keep `__legacy_default__` in its own compatibility mapping. Reserve its remote ID: Brain allocation must exclude every existing binding, including legacy. This follows the user's Task 2 review decision. `resolve(conversationId, { excludeRemoteSessionIds })` also excludes failed IDs during rollover. Unsupported state versions and account/environment mismatches must fail explicitly without replacing the existing ledger; only corrupt JSON or invalid compatible-schema data is backed up and recovered.

- [ ] **Step 5: Add invalidation and metadata updates**

`invalidate(conversationId, remoteSessionId)` must remove the mapping only when the stored remote ID matches, then persist. Every successful resolve updates `lastUsedAt` and increments `useCount` only for an already-bound mapping.

- [ ] **Step 6: Run mapping tests and verify they pass**

Run:

```powershell
node --test test/brain-session-map.test.mjs
```

Expected: all mapping tests pass, including persistence, concurrent first allocation, corruption backup, pool exhaustion, and legacy separation.

- [ ] **Step 7: Commit the mapping module**

```powershell
git -C ~/.tabbit-gateway/tabbit-toy add src/brain-session-map.mjs test/brain-session-map.test.mjs
git -C ~/.tabbit-gateway/tabbit-toy commit -m "feat: persist Brain remote session mappings"
```

---

### Task 3: Route gateway requests through scoped mappings

**Files:**
- Modify: `~/.tabbit-gateway/tabbit-toy\src\server.mjs:36-50,158-172,424-445,490-537,577-600`
- Modify: `~/.tabbit-gateway/tabbit-toy\scripts\lib\tabbit.mjs:251-285`
- Create: `~/.tabbit-gateway/tabbit-toy\test\server-session-routing.test.mjs`

**Interfaces:**
- Gateway reads `X-Brain-Conversation-Id` from the incoming request.
- `resolveRemoteSession(brainConversationId)` returns `{ remoteSessionId, scope }`.
- Existing `chat({ sessionId })` receives only the resolved remote ID.

- [ ] **Step 1: Build a fixture test for two Brain requests and one legacy request**

Stub `fetchSessionList` to return `['remote-a', 'remote-b', 'remote-c']` and capture the downstream chat body. Send requests with:

```text
X-Brain-Conversation-Id: brain-a
X-Brain-Conversation-Id: brain-b
(no Brain header for legacy)
```

Assert downstream `chat_session_id` values are distinct for `brain-a` and `brain-b`, and the legacy request uses only the `__legacy_default__` mapping.

- [ ] **Step 2: Run the routing test and verify it fails**

Run:

```powershell
node --test test/server-session-routing.test.mjs
```

Expected: FAIL because `server.mjs` currently selects a global `sessions[0]`.

- [ ] **Step 3: Replace the selected-session cache with a session-list cache**

Replace `sessionCache`/`sessionCacheAt` with a cached session list and instantiate the mapping module using the configured state path. The list cache may be shared; selected remote IDs must come from `resolve()`.

- [ ] **Step 4: Resolve the scope before preparing the request**

Read and validate the incoming header. Use `__legacy_default__` when absent. Resolve the mapping before calling `chat()`, and pass the resolved `remoteSessionId` into all normal, image-upload, non-stream, and stream paths.

- [ ] **Step 5: Add HTTP 409 pool exhaustion handling**

Catch mapping errors before upstream chat and return:

```json
{
  "error": {
    "message": "no unbound Tabbit session is available for this Brain conversation",
    "code": "REMOTE_SESSION_POOL_EXHAUSTED"
  }
}
```

with status `409`.

- [ ] **Step 6: Run routing tests and verify they pass**

Run:

```powershell
node --test test/server-session-routing.test.mjs
```

Expected: all scoped routing, legacy, validation, and 409 tests pass.

- [ ] **Step 7: Commit gateway routing**

```powershell
git -C ~/.tabbit-gateway/tabbit-toy add src/server.mjs scripts/lib/tabbit.mjs test/server-session-routing.test.mjs
git -C ~/.tabbit-gateway/tabbit-toy commit -m "feat: isolate Brain requests by remote session"
```

---

### Task 4: Add scoped remote-session rollover

**Files:**
- Modify: `~/.tabbit-gateway/tabbit-toy\src\server.mjs`
- Modify: `~/.tabbit-gateway/tabbit-toy\test\server-session-routing.test.mjs`

**Interfaces:**
- A scoped retry invalidates only the mapping for the affected Brain conversation and retries once with a newly resolved session.
- Legacy requests retain their separate compatibility mapping.

- [ ] **Step 1: Add a failing retry-isolation test**

Make the fixture reject `remote-a` once with a session-invalid error, then return a response for the replacement. Assert `brain-a` retries with a different remote ID and `brain-b` continues using its original ID.

- [ ] **Step 2: Run the focused test and verify it fails**

```powershell
node --test test/server-session-routing.test.mjs
```

Expected: FAIL because current error handling only invalidates one global cache and does not rebind by local conversation.

- [ ] **Step 3: Implement one scoped retry**

On a session-invalid Tabbit error, call `map.invalidate(brainConversationId, remoteSessionId)`, refresh the session list, resolve the same local conversation again, and retry exactly once. Preserve current authentication refresh behavior separately; do not treat context-window errors as session invalidation.

- [ ] **Step 4: Verify retry isolation and error propagation**

Run the routing tests. Assert the second failure returns the original upstream error, no third attempt occurs, and the unrelated conversation mapping remains unchanged.

- [ ] **Step 5: Commit scoped rollover**

```powershell
git -C ~/.tabbit-gateway/tabbit-toy add src/server.mjs test/server-session-routing.test.mjs
git -C ~/.tabbit-gateway/tabbit-toy commit -m "feat: rebind only failed Brain sessions"
```

---

### Task 5: Integrate documentation and acceptance evidence

**Files:**
- Modify: `~/.dsh/plugins/dsh-tabbit-brain\docs\acceptance-progress.md`
- Modify: `~/.dsh/plugins/dsh-tabbit-brain\README.md`
- Modify: `~/.dsh/plugins/dsh-tabbit-brain\README.zh.md`
- Modify: `~/.tabbit-gateway/tabbit-toy\README.md`

**Interfaces:**
- Documentation describes the new headers, mapping file, legacy behavior, pool exhaustion, reset/delete semantics, and the fact that remote history is retained.

- [ ] **Step 1: Add documentation assertions before edits**

Add checks that the Brain docs mention `X-Brain-Conversation-Id`, durable remote mapping, `REMOTE_SESSION_POOL_EXHAUSTED`, and the legacy key `__legacy_default__`; remove wording that claims local history alone provides remote isolation.

- [ ] **Step 2: Run the documentation checks and verify they fail**

Run the repository's existing documentation audit command. Expected: FAIL because the new protocol and mapping behavior are not documented.

- [ ] **Step 3: Update Chinese and English docs**

Document the request flow, mapping state path, reset/delete semantics, pool exhaustion response, one-time rollover, and legacy compatibility. Include a short migration note telling users to use new conversation labels after upgrade.

- [ ] **Step 4: Update acceptance progress**

Replace the current remote-session limitation entry with test evidence: two local conversations use different remote IDs, mappings survive restart, and rollover is scoped. If Tabbit creation remains unavailable, record the exact pool limitation and 409 behavior.

- [ ] **Step 5: Run documentation and package gates**

Run:

```powershell
npm run check
npm run test:brain
python tools/test-setup.py
npm run scan
npm run audit:docs
node tools/audit-deadcode.mjs
```

Run gateway tests:

```powershell
node --test test/brain-session-map.test.mjs test/server-session-routing.test.mjs
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit documentation and acceptance evidence**

```powershell
git -C ~/.dsh/plugins/dsh-tabbit-brain add README.md README.zh.md docs/acceptance-progress.md
git -C ~/.dsh/plugins/dsh-tabbit-brain commit -m "docs: document remote Brain session isolation"
git -C ~/.tabbit-gateway/tabbit-toy add README.md
git -C ~/.tabbit-gateway/tabbit-toy commit -m "docs: document Brain session routing"
```

---

### Task 6: Run fresh-host and real-gateway acceptance

**Files:**
- Test only: fresh DSH host session, gateway state file, gateway log

- [ ] **Step 1: Start from a new Brain conversation label**

Use labels `acceptance-isolation-v2-a` and `acceptance-isolation-v2-b` so old remote contamination is not reused.

- [ ] **Step 2: Verify distinct remote routing**

Run one foreground request in each conversation and inspect gateway diagnostics or fixture evidence. Assert remote session IDs differ.

- [ ] **Step 3: Verify reuse and restart**

Send follow-ups in both conversations, restart the gateway, and send another follow-up. Assert each conversation retains its own remote ID.

- [ ] **Step 4: Verify local reset and delete semantics**

Reset one local conversation and verify its local history clears while its mapping remains. Delete it and verify the other conversation's mapping and remote history are unchanged.

- [ ] **Step 5: Verify legacy path and pool exhaustion**

Send one request without the Brain header and assert it uses the compatibility mapping. Exhaust the fixture session pool and assert HTTP 409 with `REMOTE_SESSION_POOL_EXHAUSTED`.

- [ ] **Step 6: Review logs for sensitive data**

Search gateway logs and mapping state for cookie names, API-key values, complete prompts, and complete responses. Expected: no matches.

- [ ] **Step 7: Record final evidence**

Update `docs/acceptance-progress.md` with timestamps, conversation IDs, remote-session prefixes, restart result, rollover result, and any exact external Tabbit limitation. Do not claim remote isolation until the distinct IDs and restart evidence are present.

---

## Self-review checklist

- Spec coverage: request header, durable mapping, atomic writes, corruption backup, per-conversation lock, pool exhaustion, scoped rollover, legacy path, migration, logging, reset/delete semantics, and real acceptance are all assigned to tasks.
- Placeholder scan: every implementation step has an explicit scope and verification command.
- Type consistency: `createBrainSessionMap`, `resolve`, `invalidate`, `getSnapshot`, `close`, `REMOTE_SESSION_POOL_EXHAUSTED`, `X-Brain-Conversation-Id`, and `__legacy_default__` are used consistently across tasks.
- Scope: the plan changes only the Brain request boundary, gateway session mapping, tests, and documentation.
