import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainStore } from '../lib/brain-store.js';

const root = await mkdtemp(join(tmpdir(), 'tabbit-brain-store-'));
const db = join(root, 'brain.sqlite');
try {
  const store = BrainStore.open(db);
  const a = store.createConversation('owner-a', 'Design', 'MODEL_A');
  const b = store.createConversation('owner-b', 'Design', 'MODEL_A');
  assert.notEqual(a.id, b.id);
  store.appendMessages(a.id, [
    { id: 'm1', role: 'user', content: 'hello', requestId: 'r1', model: 'MODEL_A' },
    { id: 'm2', role: 'assistant', content: 'world', requestId: 'r1', model: 'MODEL_A' },
  ]);
  assert.equal(store.listConversations('owner-a', false).length, 1);
  assert.equal(store.listConversations('owner-b', false).length, 1);
  assert.equal(store.getConversation('owner-b', a.id), null, 'owner isolation');
  assert.equal(store.listMessages('owner-a', a.id, 10, null).length, 2);
  store.setStatus('owner-a', a.id, 'archived');
  assert.equal(store.listConversations('owner-a', false).length, 0);
  assert.equal(store.listConversations('owner-a', true).length, 1);
  const job = store.createJob({ ownerSessionId: 'owner-a', conversationId: a.id, prompt: 'p' });
  store.updateJob(job.id, { status: 'completed', resultJson: JSON.stringify({ ok: true }) });
  assert.equal(store.getJob('owner-a', job.id).status, 'completed');
  store.close();

  const reopened = BrainStore.open(db);
  assert.equal(reopened.listMessages('owner-a', a.id, 10, null).length, 2, 'restart persistence');
  assert.equal(reopened.deleteConversation('owner-a', a.id), true);
  assert.equal(reopened.getConversation('owner-a', a.id), null);
  reopened.close();
  console.log('PASS BrainStore persistence, owner isolation, archive, jobs, cascade delete');
} finally {
  await rm(root, { recursive: true, force: true });
}
