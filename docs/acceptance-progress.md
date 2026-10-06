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

The gateway request path calls `getSessionId()`, caches one global `sessionCache`, and sends that value as `chat_session_id`. Local Brain conversation IDs are not forwarded to the gateway. Local SQLite owner/history isolation is therefore verified, but remote Tabbit session isolation is not achieved by the current gateway.
