# Remote Tabbit Session Isolation

## Status

Approved design for implementation planning.

## Goal

Give each local Brain conversation a stable, independent Tabbit remote session. A conversation keeps its remote context across gateway restarts, while different local conversations never silently share the same remote `chat_session_id`.

## Scope

This change covers the Brain-to-gateway request boundary and the gateway's remote-session allocation, persistence, recovery, and compatibility behavior. It does not change the DSH UI, Tabbit Browser, local Brain SQLite schema, or existing remote Tabbit history.

## Component boundaries

### BrainService

BrainService remains responsible for local SQLite conversations and messages, context trimming, background jobs, owner isolation, and local history operations. It adds `X-Brain-Conversation-Id` to gateway requests and keeps `X-Brain-Request-Id` as the request correlation header. It does not manage cookies or remote-session mappings.

### Tabbit gateway

The gateway remains responsible for cookie acquisition, Tabbit session discovery, mapping local conversation IDs to remote session IDs, allocation locks, durable mapping state, restart recovery, remote-session rollover, and legacy clients that do not send a Brain conversation header.

## Request protocol

Brain requests send:

```http
X-Brain-Conversation-Id: brain-<uuid>
X-Brain-Request-Id: <uuid>
```

The gateway validates the conversation header as a non-empty, length-limited local key. It uses the value only for local mapping and never forwards it to Tabbit. The Tabbit request continues to send the resolved value as JSON `chat_session_id`.

The gateway logs only truncated local conversation, request, and remote-session identifiers. It never logs API keys, cookies, complete prompts, or complete model responses.

## Durable mapping

The mapping file is:

```text
~/.tabbit-gateway/tabbit-toy/state/brain-session-map.json
```

Format:

```json
{
  "version": 1,
  "accountKey": "tabbit-default",
  "mappings": {
    "brain-conversation-id": {
      "remoteSessionId": "tabbit-session-id",
      "assignedAt": "timestamp",
      "lastUsedAt": "timestamp",
      "useCount": 1
    }
  }
}
```

The file stores only identifiers and allocation metadata. It does not store cookies, API keys, complete requests, or responses.

Writes use a temporary file followed by replacement. A missing file starts with an empty mapping. A corrupt file is preserved as a backup, logged, and replaced with a new empty state. Unsupported versions are migrated or rejected explicitly; they are never silently overwritten.

Mappings are scoped by gateway account and Tabbit environment. Local reset clears only local Brain history. Local deletion removes only local records. Neither operation deletes remote Tabbit history or automatically removes a mapping.

## Allocation

For a request with a Brain conversation ID:

1. Load the mapping state.
2. Reuse a valid existing mapping.
3. Otherwise fetch the current Tabbit session list.
4. Choose an unbound remote session.
5. Persist the mapping atomically.
6. Send the request using that remote session.

The old global `sessions[0]` selection is removed from the Brain path. The gateway may retain a session-list cache, but it must not retain one globally selected session for all Brain conversations.

Concurrent first requests for one local conversation share one allocation operation. First allocations for different conversations may proceed concurrently. If no remote session can be allocated and the gateway cannot create one, return:

```text
HTTP 409
code: REMOTE_SESSION_POOL_EXHAUSTED
message: no unbound Tabbit session is available for this Brain conversation
```

The gateway must not silently fall back to a shared remote session.

## Failure recovery

When the selected remote session is invalid or no longer present:

1. Mark only that mapping stale.
2. Refresh the Tabbit session list.
3. Allocate a replacement for the affected local conversation.
4. Retry the request once.
5. Return the second failure without affecting other mappings.

## Legacy compatibility

Requests without `X-Brain-Conversation-Id` use a separate compatibility mapping key, `__legacy_default__`. New Brain conversations never bind to the legacy session. The legacy path is labeled `sessionScope=legacy` in diagnostics.

The current single-session cache becomes a session-list cache. The legacy path may continue to select its compatibility session, but it must not share that selection with Brain conversations.

## Migration

Existing conversations previously sent through the global `sessions[0]` path are not silently migrated to a new remote mapping. The new state file is created independently. New Brain conversation labels should be used for post-change acceptance. Existing local and remote history is retained; no remote history is deleted.

## Acceptance tests

The implementation must verify:

1. Two new local conversations receive different remote sessions.
2. Follow-up requests reuse the correct remote session for each conversation.
3. Concurrent first requests do not create duplicate mappings.
4. Gateway restart reloads mappings.
5. Invalidating one remote session rebinds only its local conversation and retries once.
6. Pool exhaustion returns HTTP 409 with `REMOTE_SESSION_POOL_EXHAUSTED`.
7. Legacy requests continue through the compatibility path without occupying new Brain mappings.
8. Logs contain no credentials, complete prompts, or complete responses.
9. Local reset clears local history while retaining the mapping.
10. Local deletion does not delete unrelated mappings or remote history.

## Completion criteria

The change is complete when different local Brain conversations never share a remote session, a conversation keeps its mapping across gateway restart, concurrent allocation is deterministic, session rollover is scoped to the affected conversation, legacy traffic is isolated, pool exhaustion is explicit, and diagnostics omit sensitive credentials and full content.
