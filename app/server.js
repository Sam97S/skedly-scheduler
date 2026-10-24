const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || '/data/skedly-scheduler.db';
const WORKER_INTERVAL_MS = Math.max(250, Number(process.env.WORKER_INTERVAL_MS || 1000));
const LEASE_MS = Math.max(5000, Number(process.env.LEASE_MS || 30000));
const MAX_BODY_BYTES = 1024 * 1024;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    client_message_id TEXT NOT NULL UNIQUE,
    session TEXT NOT NULL DEFAULT 'default',
    chat_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    timezone TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','unknown')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    lease_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT,
    waha_message_id TEXT,
    last_error TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_messages_due
  ON messages(status, scheduled_at, next_retry_at);
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (
    id, client_message_id, session, chat_id, type, payload_json,
    scheduled_at, timezone, status, attempts, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
`);

const getMessageStmt = db.prepare('SELECT * FROM messages WHERE id = ?');
const getByClientIdStmt = db.prepare('SELECT * FROM messages WHERE client_message_id = ?');
const deleteMessageStmt = db.prepare("DELETE FROM messages WHERE id = ? AND status = 'pending'");
const listMessagesStmt = db.prepare('SELECT * FROM messages ORDER BY scheduled_at ASC, created_at ASC LIMIT ? OFFSET ?');
const listMessagesByStatusStmt = db.prepare('SELECT * FROM messages WHERE status = ? ORDER BY scheduled_at ASC, created_at ASC LIMIT ? OFFSET ?');
const dueMessageStmt = db.prepare(`
  SELECT id FROM messages
  WHERE status = 'pending'
    AND scheduled_at <= ?
    AND (next_retry_at IS NULL OR next_retry_at <= ?)
  ORDER BY scheduled_at ASC, created_at ASC
  LIMIT 1
`);
const claimMessageStmt = db.prepare(`
  UPDATE messages
  SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ?
  WHERE id = ? AND status = 'pending'
`);
const markSentStmt = db.prepare(`
  UPDATE messages
  SET status = 'sent', sent_at = ?, lease_until = NULL, updated_at = ?, last_error = NULL
  WHERE id = ? AND status = 'processing'
`);
const markFailedStmt = db.prepare(`
  UPDATE messages
  SET status = 'failed', lease_until = NULL, updated_at = ?, last_error = ?
  WHERE id = ? AND status = 'processing'
`);
const recoverExpiredStmt = db.prepare(`
  UPDATE messages
  SET status = 'pending', lease_until = NULL, updated_at = ?, last_error = 'lease_expired_recovered'
  WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until < ?
`);

function nowIso() {
  return new Date().toISOString();
}

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function serializeMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientMessageId: row.client_message_id,
    session: row.session,
    chatId: row.chat_id,
    type: row.type,
    payload: safeJsonParse(row.payload_json),
    scheduledAt: row.scheduled_at,
    timezone: row.timezone,
    status: row.status,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    leaseUntil: row.lease_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
    wahaMessageId: row.waha_message_id,
    lastError: row.last_error
  };
}

function json(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function empty(res, statusCode = 204) {
  res.writeHead(statusCode);
  res.end();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload_too_large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid_json'), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function validateCreate(input) {
  if (!input || typeof input !== 'object') return 'invalid_body';
  if (typeof input.chatId !== 'string' || !input.chatId.trim()) return 'chatId_required';
  if (input.type !== 'text') return 'type_must_be_text_for_current_mvp';
  if (!input.payload || typeof input.payload.text !== 'string' || !input.payload.text.trim()) return 'payload_text_required';
  if (!isIsoDate(input.scheduledAt)) return 'scheduledAt_must_be_iso_datetime';
  if (input.clientMessageId != null && (typeof input.clientMessageId !== 'string' || !input.clientMessageId.trim())) return 'invalid_clientMessageId';
  return null;
}

function statusSummary() {
  const rows = db.prepare('SELECT status, COUNT(*) AS count FROM messages GROUP BY status').all();
  const counts = { pending: 0, processing: 0, sent: 0, failed: 0, unknown: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

function claimNextDueMessage() {
  const now = nowIso();
  let id = null;

  db.exec('BEGIN IMMEDIATE');
  try {
    const due = dueMessageStmt.get(now, now);
    if (due) {
      const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
      const result = claimMessageStmt.run(leaseUntil, now, due.id);
      if (result.changes === 1) id = due.id;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return id ? serializeMessage(getMessageStmt.get(id)) : null;
}

function executeLocally(message) {
  const text = message?.payload?.text || '';
  console.log(`[SCHEDULER] executing id=${message.id} clientMessageId=${message.clientMessageId} chatId=${message.chatId} text=${JSON.stringify(text)}`);

  // Milestone 2 intentionally performs no WAHA call.
  // Reaching this point proves persistence + due-time execution + state transitions.
  const now = nowIso();
  const result = markSentStmt.run(now, now, message.id);
  if (result.changes !== 1) {
    throw new Error(`unable_to_mark_sent:${message.id}`);
  }

  console.log(`[SCHEDULER] sent-local id=${message.id} at=${now}`);
}

let workerBusy = false;
function runWorker() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const now = nowIso();
    const recovered = recoverExpiredStmt.run(now, now);
    if (recovered.changes > 0) {
      console.log(`[SCHEDULER] recovered_expired_leases count=${recovered.changes}`);
    }

    for (let i = 0; i < 20; i += 1) {
      const message = claimNextDueMessage();
      if (!message) break;

      try {
        executeLocally(message);
      } catch (error) {
        const failedAt = nowIso();
        markFailedStmt.run(failedAt, String(error?.message || error), message.id);
        console.error(`[SCHEDULER] failed id=${message.id}`, error);
      }
    }
  } catch (error) {
    console.error('[SCHEDULER] worker_error', error);
  } finally {
    workerBusy = false;
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return json(res, 200, {
      status: 'ok',
      service: 'skedly-scheduler',
      db: 'ok',
      worker: workerBusy ? 'busy' : 'idle'
    });
  }

  if (req.method === 'GET' && pathname === '/status') {
    return json(res, 200, {
      service: 'skedly-scheduler',
      mode: 'local-dry-run',
      databasePath: DB_PATH,
      workerIntervalMs: WORKER_INTERVAL_MS,
      counts: statusSummary(),
      now: nowIso()
    });
  }

  if (req.method === 'POST' && pathname === '/v1/messages') {
    const input = await readJson(req);
    const validationError = validateCreate(input);
    if (validationError) return json(res, 400, { error: validationError });

    const id = randomUUID();
    const clientMessageId = input.clientMessageId?.trim() || randomUUID();
    const createdAt = nowIso();
    const scheduledAt = new Date(input.scheduledAt).toISOString();

    try {
      insertMessage.run(
        id,
        clientMessageId,
        typeof input.session === 'string' && input.session.trim() ? input.session.trim() : 'default',
        input.chatId.trim(),
        input.type,
        JSON.stringify(input.payload),
        scheduledAt,
        typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : null,
        createdAt,
        createdAt
      );
    } catch (error) {
      if (String(error?.message || error).includes('UNIQUE')) {
        const existing = getByClientIdStmt.get(clientMessageId);
        return json(res, 409, {
          error: 'duplicate_clientMessageId',
          existing: serializeMessage(existing)
        });
      }
      throw error;
    }

    return json(res, 201, serializeMessage(getMessageStmt.get(id)));
  }

  if (req.method === 'GET' && pathname === '/v1/messages') {
    const status = url.searchParams.get('status');
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));

    let rows;
    if (status) {
      if (!['pending', 'processing', 'sent', 'failed', 'unknown'].includes(status)) {
        return json(res, 400, { error: 'invalid_status' });
      }
      rows = listMessagesByStatusStmt.all(status, limit, offset);
    } else {
      rows = listMessagesStmt.all(limit, offset);
    }

    return json(res, 200, { messages: rows.map(serializeMessage) });
  }

  const match = pathname.match(/^\/v1\/messages\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const current = getMessageStmt.get(id);
    if (!current) return json(res, 404, { error: 'message_not_found' });

    if (req.method === 'GET') {
      return json(res, 200, serializeMessage(current));
    }

    if (req.method === 'DELETE') {
      if (current.status !== 'pending') {
        return json(res, 409, { error: 'only_pending_messages_can_be_deleted' });
      }
      const result = deleteMessageStmt.run(id);
      return result.changes === 1 ? empty(res) : json(res, 409, { error: 'delete_conflict' });
    }

    if (req.method === 'PATCH') {
      if (current.status !== 'pending') {
        return json(res, 409, { error: 'only_pending_messages_can_be_modified' });
      }

      const input = await readJson(req);
      const updates = [];
      const values = [];

      if ('scheduledAt' in input) {
        if (!isIsoDate(input.scheduledAt)) return json(res, 400, { error: 'scheduledAt_must_be_iso_datetime' });
        updates.push('scheduled_at = ?');
        values.push(new Date(input.scheduledAt).toISOString());
      }
      if ('timezone' in input) {
        updates.push('timezone = ?');
        values.push(typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : null);
      }
      if ('chatId' in input) {
        if (typeof input.chatId !== 'string' || !input.chatId.trim()) return json(res, 400, { error: 'invalid_chatId' });
        updates.push('chat_id = ?');
        values.push(input.chatId.trim());
      }
      if ('session' in input) {
        if (typeof input.session !== 'string' || !input.session.trim()) return json(res, 400, { error: 'invalid_session' });
        updates.push('session = ?');
        values.push(input.session.trim());
      }
      if ('payload' in input) {
        if (!input.payload || typeof input.payload.text !== 'string' || !input.payload.text.trim()) {
          return json(res, 400, { error: 'payload_text_required' });
        }
        updates.push('payload_json = ?');
        values.push(JSON.stringify(input.payload));
      }

      if (!updates.length) return json(res, 400, { error: 'no_supported_fields_to_update' });
      updates.push('updated_at = ?');
      values.push(nowIso());
      values.push(id);

      const statement = db.prepare(`UPDATE messages SET ${updates.join(', ')} WHERE id = ? AND status = 'pending'`);
      const result = statement.run(...values);
      if (result.changes !== 1) return json(res, 409, { error: 'update_conflict' });
      return json(res, 200, serializeMessage(getMessageStmt.get(id)));
    }
  }

  return json(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('[HTTP] unhandled_error', error);
    if (!res.headersSent) {
      json(res, error?.statusCode || 500, { error: error?.message || 'internal_server_error' });
    } else {
      res.destroy();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[skedly-scheduler] listening on http://${HOST}:${PORT}`);
  console.log(`[skedly-scheduler] sqlite=${DB_PATH}`);
  console.log('[skedly-scheduler] mode=local-dry-run');
});

setInterval(runWorker, WORKER_INTERVAL_MS).unref();
setTimeout(runWorker, 100).unref();

function shutdown(signal) {
  console.log(`[skedly-scheduler] shutting_down signal=${signal}`);
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
