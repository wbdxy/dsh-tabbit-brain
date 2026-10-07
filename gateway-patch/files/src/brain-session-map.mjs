import { readFile, open, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const LEGACY = '__legacy_default__';

function validateId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 200) {
    throw new TypeError('ID must be a non-empty string of at most 200 characters');
  }
}

function validateState(state, accountKey) {
  if (!state || state.version !== 1 || state.accountKey !== accountKey ||
      !state.mappings || typeof state.mappings !== 'object' || Array.isArray(state.mappings)) {
    throw new Error('invalid mapping state schema, version or accountKey');
  }
  const used = new Set();
  for (const [id, entry] of Object.entries(state.mappings)) {
    validateId(id);
    if (!entry || typeof entry !== 'object') throw new Error('invalid mapping entry');
    validateId(entry.remoteSessionId);
    if (!Number.isFinite(entry.assignedAt) || !Number.isFinite(entry.lastUsedAt) ||
        !Number.isSafeInteger(entry.useCount) || entry.useCount < 0) {
      throw new Error('invalid mapping metadata');
    }
    if (entry.provenance !== undefined && !['created', 'pool', 'legacy', 'unverified'].includes(entry.provenance)) throw new Error('invalid mapping provenance');
    if (used.has(entry.remoteSessionId)) throw new Error('duplicate remote session binding');
    used.add(entry.remoteSessionId);
  }
}

/**
 * Single-writer mapping ledger. All methods except the factory return promises.
 * Concurrent resolves share an operation only when their exclusion requirements match;
 * a conflicting caller waits for that operation and then resolves with its own requirements.
 * useCount counts later reuse; each remote session remains reserved by its persisted mapping.
 */
export function createBrainSessionMap({ statePath, accountKey, scopeKey, listSessions, createSession, now = Date.now, onCorrupt, renameFile = rename }) {
  validateId(accountKey);
  if (typeof statePath !== 'string' || !statePath) throw new TypeError('statePath is required');
  if (typeof listSessions !== 'function' || typeof now !== 'function') {
    throw new TypeError('listSessions and now must be functions');
  }
  if (createSession !== undefined && typeof createSession !== 'function') throw new TypeError('createSession must be a function');
  if (onCorrupt !== undefined && typeof onCorrupt !== 'function') {
    throw new TypeError('onCorrupt must be a function');
  }
  let state = { version: 1, accountKey, ...(scopeKey === undefined ? {} : { scopeKey }), mappings: {} };
  let loaded = false;
  let closed = false;
  let queue = Promise.resolve();
  let closing;
  const inFlight = new Map();
  const acceptedResolves = new Set();

  async function load() {
    if (loaded) return;
    let text;
    try {
      text = await readFile(statePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      loaded = true;
      return;
    }
    let candidate;
    try {
      candidate = JSON.parse(text);
      if (candidate?.version !== 1) {
        throw Object.assign(new Error('unsupported mapping state version'), { code: 'BRAIN_SESSION_STATE_VERSION_UNSUPPORTED' });
      }
      if (candidate?.accountKey !== accountKey || candidate?.scopeKey !== scopeKey) {
        throw Object.assign(new Error('mapping state accountKey mismatch'), { code: 'BRAIN_SESSION_STATE_SCOPE_MISMATCH' });
      }
      validateState(candidate, accountKey);
    } catch (error) {
      if (error.code === 'BRAIN_SESSION_STATE_VERSION_UNSUPPORTED' || error.code === 'BRAIN_SESSION_STATE_SCOPE_MISMATCH') throw error;
      const backupPath = `${statePath}.corrupt-${now()}-${randomUUID()}`;
      await rename(statePath, backupPath);
      onCorrupt?.({ code: 'BRAIN_SESSION_STATE_CORRUPT', backupPath });
      loaded = true;
      return;
    }
    for (const entry of Object.values(candidate.mappings)) entry.provenance ??= 'unverified';
    state = candidate;
    loaded = true;
  }

  function enqueue(operation) {
    const result = queue.then(async () => { await load(); return operation(); });
    queue = result.catch(() => {});
    return result;
  }

  async function persist(candidate) {
    await mkdir(dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp`;
    let file;
    let created = false;
    try {
      file = await open(temporary, 'w', 0o600);
      created = true;
      await file.writeFile(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
      // The in-memory state changes only after replacement succeeds, so an open or rename
      // failure leaves both the durable ledger and the current snapshot unchanged.
      await renameFile(temporary, statePath);
      state = candidate;
    } catch (error) {
      if (file) await file.close().catch(() => {});
      if (created) await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  function assertOpen() {
    if (closed) throw new Error('Brain session map is closed');
  }

  function timestamp() {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError('now must return a finite timestamp');
    return value;
  }

  function resolve(conversationId, options = {}) {
    assertOpen();
    validateId(conversationId);
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('resolve options must be an object');
    }
    const excluded = options.excludeRemoteSessionIds ?? [];
    if (!Array.isArray(excluded)) throw new TypeError('excludeRemoteSessionIds must be an array');
    excluded.forEach(validateId);
    const result = resolveAccepted(conversationId, [...excluded], options.touch !== false);
    acceptedResolves.add(result);
    const clear = () => acceptedResolves.delete(result);
    result.then(clear, clear);
    return result;
  }

  function resolveAccepted(conversationId, excluded, touch) {
    const requestedExclusions = new Set(excluded);
    const active = inFlight.get(conversationId);
    if (active) {
      const activeCoversRequest = [...requestedExclusions].every(id => active.exclusions.has(id));
      if (activeCoversRequest && active.touch === touch) return active.promise;
      return active.promise.then(() => resolveAccepted(conversationId, excluded, touch));
    }
    const result = enqueue(async () => {
      const candidate = structuredClone(state);
      const existing = Object.hasOwn(candidate.mappings, conversationId)
        ? candidate.mappings[conversationId] : undefined;
      if (existing && createSession && conversationId !== LEGACY && existing.provenance !== 'created') {
        throw Object.assign(new Error('BRAIN_SESSION_PROVENANCE_UNVERIFIED'), { code: 'BRAIN_SESSION_PROVENANCE_UNVERIFIED' });
      }
      let remoteSessionId;
      let provenance = existing?.provenance;
      const reuseExisting = existing && !excluded.includes(existing.remoteSessionId);
      if (reuseExisting) {
        if (!touch) return { remoteSessionId: existing.remoteSessionId, scope: conversationId === LEGACY ? 'legacy' : 'brain', provenance };
        remoteSessionId = existing.remoteSessionId;
        existing.lastUsedAt = timestamp();
        existing.useCount++;
      } else {
        const used = new Set(Object.values(candidate.mappings).map(mapping => mapping.remoteSessionId));
        if (createSession && conversationId !== LEGACY) {
          const created = await createSession({ conversationId, excludeRemoteSessionIds: [...excluded] });
          remoteSessionId = created?.remoteSessionId;
          if (typeof remoteSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(remoteSessionId) || created?.provenance !== 'created' || excluded.includes(remoteSessionId)) {
            throw Object.assign(new Error('REMOTE_SESSION_CREATE_INVALID'), { code: 'REMOTE_SESSION_CREATE_INVALID' });
          }
          if (used.has(remoteSessionId)) throw Object.assign(new Error('REMOTE_SESSION_CREATE_CONFLICT'), { code: 'REMOTE_SESSION_CREATE_CONFLICT' });
          provenance = 'created';
        } else {
          const sessions = await listSessions();
          if (!Array.isArray(sessions)) throw new TypeError('listSessions must return an array of IDs');
          sessions.forEach(validateId);
          remoteSessionId = sessions.find(id => !used.has(id) && !excluded.includes(id));
          if (remoteSessionId === undefined) {
            throw Object.assign(new Error('no unbound Tabbit session is available for this Brain conversation'), {
              code: 'REMOTE_SESSION_POOL_EXHAUSTED',
            });
          }
          provenance = conversationId === LEGACY ? 'legacy' : 'pool';
        }
        const time = timestamp();
        Object.defineProperty(candidate.mappings, conversationId, {
          value: { remoteSessionId, provenance, assignedAt: time, lastUsedAt: time, useCount: 0 },
          enumerable: true, configurable: true, writable: true,
        });
      }
      await persist(candidate);
      return { remoteSessionId, scope: conversationId === LEGACY ? 'legacy' : 'brain', provenance };
    });
    inFlight.set(conversationId, { promise: result, exclusions: requestedExclusions, touch });
    const clear = () => { if (inFlight.get(conversationId)?.promise === result) inFlight.delete(conversationId); };
    result.then(clear, clear);
    return result;
  }

  function invalidate(conversationId, remoteSessionId) {
    assertOpen();
    validateId(conversationId);
    validateId(remoteSessionId);
    return enqueue(async () => {
      if (!Object.hasOwn(state.mappings, conversationId) ||
          state.mappings[conversationId].remoteSessionId !== remoteSessionId) return;
      const candidate = structuredClone(state);
      delete candidate.mappings[conversationId];
      await persist(candidate);
    });
  }

  function getSnapshot() {
    return enqueue(() => structuredClone(state));
  }

  function close() {
    if (!closing) {
      closed = true;
      closing = Promise.allSettled([queue, ...acceptedResolves]).then(() => undefined);
    }
    return closing;
  }

  return { resolve, invalidate, getSnapshot, close };
}
