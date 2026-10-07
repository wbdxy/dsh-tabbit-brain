# Persistent Brain acceptance progress

## Verified in the running DSH host

- Seven Brain tools are visible after restart.
- Foreground request succeeded via DeepSeek-V4.1-Flash at the configured loopback `/v1/chat/completions` endpoint.
- Conversation `brain-df15a012-ad42-4d74-98ae-70ab007f0061` was created and its two messages were retrieved with request/model metadata.

## Failures found during host acceptance

- Background job returned a receipt but its DSH producer result had no terminal `status`; `job_output` rejected the output.
- `tabbit_brain_status` returned null because the background adapter had not created a persistent Brain job.

## Local fixes and regression evidence

- DSH producer now resolves to `{ status: 'completed', output: JSON.stringify(receipt) }`, or a failed/killed terminal outcome.
- Background submission now creates a SQLite job and returns `jobId` (DSH), `brainJobId` (persistent Brain status), and `conversationId`.
- `tabbit_brain_status` accepts the persistent `brainJobId`, not the DSH `jobId`.
- Service fixture covers queued/completed/failed status, stored result and cross-owner denial.
- Store and tool-adapter fixtures pass. These fixes were written after the latest host restart, so they are not yet verified in the running host.

## Pending; not claimed complete

- Reload/restart and collect one real background job using DSH jobId; query status using brainJobId.
- Exercise same-conversation follow-up and independent-conversation history.
- Verify stable message ordering and pagination when timestamps collide.
- Archive/reset/delete during idle and reject or safely serialize operations while busy.
- Reopen the same DSH main session after restart and read saved history.
- Interrupted job recovery, cancellation and gateway-start failure status.
- Parent access to child-created Brain history: currently owner-scoped, not automatically shared.
- Remote Tabbit session mapping/isolation remains unproven.

No overall completion claim, tag or remote push is authorized by this progress record.

## Latest host acceptance failure

- Background Brain job persistence and `job_output` now work after restart.
- A persisted conversation read showed assistant/user ordering that is not deterministic when messages share a millisecond timestamp. Fixed with per-conversation `messages.seq`, migration of existing rows ordered by old timestamp/id, and seq-based reads.
- A background prompt requesting a fixed short answer returned unrelated remote-context content. The gateway selects and globally caches `sessions[0]`; remote Tabbit session reuse is therefore a confirmed investigation target, but the exact contamination path still needs request/session evidence.

## Remote session boundary evidence

The gateway version used during the failed host acceptance called `getSessionId()`, cached one global `sessionCache`, and sent that value as `chat_session_id`. That deployed path did not forward local Brain conversation IDs. The implementation checkpoints below describe disk changes; they do not imply the running host or gateway has loaded them.

## Fresh-host acceptance supplied by the user

The user created a fresh main session and supplied tool results step by step. Seven Brain tools were reported visible. Foreground requests returned model/endpoint/request receipts, but content referenced unrelated previous remote conversations. A local reset and a second independent local conversation did not eliminate the old remote topic.

The background submission returned both a DSH job ID and a persistent Brain job ID. `job_output` returned content; `tabbit_brain_status` showed completed with matching request metadata. History read returned a user/assistant pair sharing one timestamp with seq 1 and 2. Active and archived list filters behaved as expected. After deleting the archived test conversation it was absent from the list; physical message cascade was not independently inspected in the host. Reset returned removed=true and the following history read returned an empty array. After the requested DSH restart and same-session recovery, the background history pair was still readable in the same order.

These were supplied host results from the earlier acceptance phase. Later controlled acceptance covered A/B remote bindings, restart reuse, pagination, and fresh main-session memory; list membership alone still does not prove remote account-level hidden-memory absence.

## Implementation and upstream investigation checkpoints

- Brain request-header implementation committed locally as 2a06c12; no remote push. Runtime reload is pending.
- Gateway scoped routing Task 3 independently approved. Preloaded network/CDP fixture suites: 37 passing, zero failures. This covers routing, persisted account/environment scope, legacy reservation, instance key/dependency isolation, import side effects, and maintenance close.
- Real upstream creation probe: POST /panel/session returned HTTP 200 with a new session ID; GET /panel/{id}/data returned HTTP 200 with messages=[].
- Read-only positive control on an existing session returned 50 messages; this rules out a history endpoint that always returns an empty list, not hidden account memory.
- A separate low-volume direct-upstream test created two empty sessions and performed four chats: A remembered its random marker; B answered arithmetic; A recalled the exact marker; B reported no A marker. All returned HTTP 200 without the previously observed old topic.
- The direct-upstream probes bypassed gateway mapping integration. Subsequent isolated gateway HTTP acceptance on port 8788 returned HTTP 200 for A/B and A follow-up, with distinct remote IDs and created provenance. A recalled its exact random marker; B returned the expected arithmetic answer. A managed restart using the same acceptance ledger preserved both remote IDs and A recalled its marker again. This exercised the real gateway code, not a fixture; the temporary server was then stopped.
- Final offline gateway recovery suite: 83 passing tests. Installer review and six fixture cases passed; documentation contracts 71/71 and bounded runtime-path fixtures 25/25 passed. Source/overlay hashes match.
- The first default-port deployment attempt encountered EADDRINUSE. A later netstat/process check identified the old node src/server.mjs process; it was stopped after checking its identity. The reviewed gateway was started on 8787 and a direct HTTP request returned 200, answer 5, and created provenance. This confirms default-port gateway deployment, not DSH host reload.
- DSH host reload/new-session acceptance was subsequently completed: the new main-session smoke test returned `已记住。` then the exact marker with the same conversation ID through `http://127.0.0.1:8787/v1/chat/completions`. Existing remote history was not deleted; normal gateway startup refreshed cookies through its documented short-lived browser path. The controlled 8788 instances were stopped; the default 8787 gateway remained the accepted local endpoint.
