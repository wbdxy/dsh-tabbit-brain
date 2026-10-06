import { randomUUID } from 'node:crypto';

export const BRAIN_PROMPT = 'You are a text-only reasoning assistant. You have no tools, filesystem, browser, skills, or access to the caller conversation. Use only the supplied material. Produce a self-contained analysis, design, draft, or derivation. State missing evidence rather than inventing it. Your output is a draft for the caller to verify.';

export class BrainService {
  histories = new Map();
  queues = new Map();
  controllers = new Set();
  closed = false;

  key(owner, conversation) {
    if (!owner || typeof owner !== 'string') throw new Error('A main-conversation owner id is required');
    if (!conversation || typeof conversation !== 'string' || conversation.length > 100) throw new Error('Invalid conversation label');
    return JSON.stringify([owner, conversation]);
  }

  ask(request, options) {
    if (this.closed) return Promise.reject(new Error('Brain service is disposed'));
    const key = this.key(request.owner, request.conversation ?? 'default');
    const prior = this.queues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.run(key, request, { ...options }));
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }

  async run(key, request, options) {
    if (this.closed) throw new Error('Brain service is disposed');
    request.signal?.throwIfAborted();
    const { prompt } = request;
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A non-empty prompt is required');
    const budget = options.contextBudgetChars ?? 16000;
    const system = options.brainPrompt ?? BRAIN_PROMPT;
    let remaining = budget - system.length - prompt.length;
    if (remaining < 0) throw new Error('Current prompt exceeds context budget; split the task');
    const history = this.histories.get(key) ?? [];
    const retained = [];
    for (let i = history.length - 2; i >= 0; i -= 2) {
      const pair = history.slice(i, i + 2);
      const cost = pair.reduce((n, m) => n + m.content.length, 0);
      if (cost > remaining) break;
      retained.unshift(...pair); remaining -= cost;
    }
    const messages = [{ role: 'system', content: system }, ...retained, { role: 'user', content: prompt }];
    const base = String(options.gatewayUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Brain gateway must be a loopback HTTP endpoint');
    }
    if (url.username || url.password) throw new Error('Credentials in gateway URL are not supported');
    const apiKey = options.apiKey ?? process.env[options.apiKeyEnv || 'TABBIT_API_KEY'];
    if (!apiKey) throw new Error('Set the gateway API key environment variable before calling tabbit_brain');
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
    const abort = () => ctrl.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const timer = setTimeout(() => ctrl.abort(new Error('Brain request timed out')), options.requestTimeoutMs ?? 120000);
    const requestId = randomUUID();
    try {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', redirect: 'error', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Brain-Request-Id': requestId },
        body: JSON.stringify({ model: options.agentModel, messages, stream: false }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Brain gateway HTTP ${response.status}; inspect the gateway without exposing credentials`); }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('Brain gateway returned empty text');
      if (typeof data.model !== 'string' || data.model !== options.agentModel) throw new Error('Brain gateway response model does not match requested model');
      // Bound stored history as well as the outgoing request.
      const stored = [...retained, { role: 'user', content: prompt }, { role: 'assistant', content }];
      while (stored.length && stored.reduce((n, m) => n + m.content.length, 0) > budget - system.length) stored.splice(0, 2);
      this.histories.set(key, stored);
      return { conversation: request.conversation ?? 'default', requestId, model: data.model,
        endpoint: `${base}/v1/chat/completions`, content, usage: data.usage ?? null };
    } finally {
      clearTimeout(timer); request.signal?.removeEventListener('abort', abort); this.controllers.delete(ctrl);
    }
  }

  reset(owner, conversation = 'default') {
    const key = this.key(owner, conversation);
    if (this.queues.has(key)) throw new Error('Conversation is busy; cancel or await its job before resetting');
    return { removed: this.histories.delete(key), conversation };
  }

  release(owner) {
    for (const key of this.histories.keys()) if (JSON.parse(key)[0] === owner) this.histories.delete(key);
  }

  dispose() {
    this.closed = true;
    for (const ctrl of this.controllers) ctrl.abort(new Error('Brain service disposed'));
    this.histories.clear();
  }
}
