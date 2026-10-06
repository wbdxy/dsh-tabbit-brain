import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const now = () => Date.now();

export class BrainStore {
  constructor(db) {
    this.db = db;
    this.db.exec(`PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  model TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS conversations_owner_updated ON conversations(owner_session_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant')), content TEXT NOT NULL,
  request_id TEXT, model TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages(conversation_id, created_at, id);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  prompt TEXT NOT NULL, request_id TEXT, error TEXT, result_json TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_owner_created ON jobs(owner_session_id, created_at DESC);`);
  }

  static open(path) { mkdirSync(dirname(path), { recursive: true }); return new BrainStore(new DatabaseSync(path)); }

  createConversation(ownerSessionId, title, model) {
    const id = `brain-${randomUUID()}`; const t = now();
    this.db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, ownerSessionId, title || 'Brain conversation', 'active', model, t, t, null);
    return this.getConversation(ownerSessionId, id);
  }

  getConversation(ownerSessionId, id) {
    return this.db.prepare('SELECT id, owner_session_id AS ownerSessionId, title, status, model, created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt FROM conversations WHERE id = ? AND owner_session_id = ?').get(id, ownerSessionId) ?? null;
  }

  listConversations(ownerSessionId, includeArchived = false) {
    const sql = includeArchived ? 'SELECT * FROM conversations WHERE owner_session_id = ? ORDER BY updated_at DESC' : "SELECT * FROM conversations WHERE owner_session_id = ? AND status = 'active' ORDER BY updated_at DESC";
    return this.db.prepare(sql).all(ownerSessionId).map(this.conversationRow);
  }

  conversationRow(row) { return { id: row.id, ownerSessionId: row.owner_session_id, title: row.title, status: row.status, model: row.model, createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at }; }

  appendMessages(conversationId, messages) {
    const insert = this.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)');
    const t = now();
    this.db.exec('BEGIN');
    try { for (const m of messages) insert.run(m.id || randomUUID(), conversationId, m.role, m.content, m.requestId ?? null, m.model ?? null, m.createdAt ?? t); this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(t, conversationId); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  listMessages(ownerSessionId, conversationId, limit = 50, before = null) {
    if (!this.getConversation(ownerSessionId, conversationId)) return [];
    const rows = before == null
      ? this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(conversationId, limit)
      : this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?').all(conversationId, before, limit);
    return rows.reverse().map(m => ({ id: m.id, conversationId: m.conversation_id, role: m.role, content: m.content, requestId: m.request_id, model: m.model, createdAt: m.created_at }));
  }

  setStatus(ownerSessionId, conversationId, status) {
    if (!this.getConversation(ownerSessionId, conversationId)) return false;
    const t = now(); this.db.prepare('UPDATE conversations SET status = ?, archived_at = ?, updated_at = ? WHERE id = ? AND owner_session_id = ?').run(status, status === 'archived' ? t : null, t, conversationId, ownerSessionId); return true;
  }

  clearMessages(ownerSessionId, conversationId) { if (!this.getConversation(ownerSessionId, conversationId)) return false; this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId); this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), conversationId); return true; }
  deleteConversation(ownerSessionId, conversationId) { const r = this.db.prepare('DELETE FROM conversations WHERE id = ? AND owner_session_id = ?').run(conversationId, ownerSessionId); return r.changes > 0; }

  createJob({ ownerSessionId, conversationId, prompt }) { const id = `brain-job-${randomUUID()}`; this.db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, ownerSessionId, conversationId, 'queued', prompt, null, null, null, now(), null, null); return { id }; }
  updateJob(id, patch) { const allowed = ['status','request_id','error','result_json','started_at','finished_at']; const pairs = Object.entries(patch).filter(([k]) => allowed.includes(k)); if (!pairs.length) return; this.db.prepare(`UPDATE jobs SET ${pairs.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...pairs.map(([,v]) => v), id); }
  getJob(ownerSessionId, id) { const r = this.db.prepare('SELECT * FROM jobs WHERE id = ? AND owner_session_id = ?').get(id, ownerSessionId); return r ? { id:r.id, ownerSessionId:r.owner_session_id, conversationId:r.conversation_id, status:r.status, prompt:r.prompt, requestId:r.request_id, error:r.error, resultJson:r.result_json, createdAt:r.created_at, startedAt:r.started_at, finishedAt:r.finished_at } : null; }
  close() { this.db.close(); }
}
