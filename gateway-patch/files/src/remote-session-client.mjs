function failure(code, status) {
  return Object.assign(new Error(code), { code, ...(Number.isInteger(status) ? { status } : {}) });
}

function remoteRequests({ cookie, baseUrl, signal, fetchImpl = fetch, timeoutMs = 15000 }) {
  let base;
  try {
    base = new URL(baseUrl);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/' || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error();
  } catch {
    throw failure('REMOTE_SESSION_CONFIG_INVALID');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const abortFailure = () => failure(timeout.aborted ? 'REMOTE_SESSION_TIMEOUT' : 'REMOTE_SESSION_ABORTED');
  const headers = { Accept: 'application/json', Cookie: cookie ?? '', Origin: base.origin, Referer: `${base.origin}/` };
  const root = base.href.replace(/\/$/, '');
  async function request(path, method, stage) {
    if (bounded.aborted) throw abortFailure();
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, { method, headers, signal: bounded, redirect: 'error', ...(stage === 'CHECK' ? { cache: 'no-store' } : {}) });
    } catch {
      if (bounded.aborted) throw abortFailure();
      throw failure(`REMOTE_SESSION_${stage === 'CHECK' ? 'HISTORY' : stage}_NETWORK`);
    }
    if (bounded.aborted) throw abortFailure();
    const missingCandidate = stage === 'CHECK' && response?.status === 404;
    const diagnosticStage = stage === 'CHECK' ? 'HISTORY' : stage;
    if (!Number.isInteger(response?.status) || ((response.status < 200 || response.status >= 300) && !missingCandidate)) {
      throw failure(`REMOTE_SESSION_${diagnosticStage}_HTTP`, response?.status);
    }
    let data;
    try {
      data = await response.json();
      if (bounded.aborted) throw abortFailure();
    } catch {
      if (bounded.aborted) throw abortFailure();
      throw failure(`REMOTE_SESSION_${diagnosticStage}_INVALID`, response.status);
    }
    if (missingCandidate) {
      if (data?.errorCode === 'SESSION_NOT_FOUND') throw failure('REMOTE_SESSION_NOT_FOUND', 404);
      throw failure('REMOTE_SESSION_HISTORY_HTTP', 404);
    }
    return data;
  }
  return request;
}

/** Checks existence without requiring an existing session to be empty. */
export async function checkRemoteSession({ remoteSessionId, ...options }) {
  const request = remoteRequests(options);
  if (typeof remoteSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(remoteSessionId)) throw failure('REMOTE_SESSION_HISTORY_INVALID');
  const history = await request(`/panel/${encodeURIComponent(remoteSessionId)}/data`, 'GET', 'CHECK');
  if (history?.id !== remoteSessionId || !Array.isArray(history?.messages)) throw failure('REMOTE_SESSION_HISTORY_INVALID');
  return { remoteSessionId };
}

/** Creates a remote session and verifies its visible history before binding. */
export async function createRemoteSession(options) {
  const request = remoteRequests(options);
  const created = await request('/panel/session', 'POST', 'CREATE');
  const id = created?.chat_session_id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw failure('REMOTE_SESSION_CREATE_INVALID');
  const history = await request(`/panel/${encodeURIComponent(id)}/data`, 'GET', 'HISTORY');
  if (history?.id !== id || !Array.isArray(history?.messages)) throw failure('REMOTE_SESSION_HISTORY_INVALID');
  if (history.messages.length !== 0) throw failure('REMOTE_SESSION_HISTORY_NOT_EMPTY');
  return { remoteSessionId: id, provenance: 'created' };
}
