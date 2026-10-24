const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID, timingSafeEqual } = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('./migrations');
const { MediaStore } = require('./media');
const { Delivery } = require('./delivery');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || '/data/skedly-scheduler.db';
const WORKER_INTERVAL_MS = Math.max(250, Number(process.env.WORKER_INTERVAL_MS || 1000));
const LEASE_MS = Math.max(5000, Number(process.env.LEASE_MS || 30000));
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES || 26214400);
const MEDIA_DIR = process.env.MEDIA_DIR || '/data/media';
const CLEANUP_INTERVAL_MS = Math.max(1000, Number(process.env.CLEANUP_INTERVAL_MS || 3600000));
if (!Number.isSafeInteger(MAX_MEDIA_BYTES) || MAX_MEDIA_BYTES < 1) throw new Error('invalid_MAX_MEDIA_BYTES');

const DELIVERY_MODE = String(process.env.DELIVERY_MODE || 'local').trim().toLowerCase();
const WAHA_BASE_URL = String(process.env.WAHA_BASE_URL || 'http://waha:3000').replace(/\/+$/, '');
const WAHA_API_KEY = String(process.env.WAHA_API_KEY || '');
const WAHA_TIMEOUT_MS = Math.max(1000, Number(process.env.WAHA_TIMEOUT_MS || 15000));
const SCHEDULER_API_TOKEN = String(process.env.SCHEDULER_API_TOKEN || '');

if (!['local', 'waha'].includes(DELIVERY_MODE)) {
  throw new Error(`unsupported_DELIVERY_MODE:${DELIVERY_MODE}`);
}
if (DELIVERY_MODE === 'waha' && !WAHA_API_KEY) {
  throw new Error('WAHA_API_KEY_required_when_DELIVERY_MODE_is_waha');
}
if (!SCHEDULER_API_TOKEN) {
  throw new Error('SCHEDULER_API_TOKEN_required');
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA synchronous = FULL;');
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

migrate(db);
const mediaStore = new MediaStore(db, MEDIA_DIR, MAX_MEDIA_BYTES);
const deliveryClient = new Delivery(db, mediaStore, {
  baseUrl: WAHA_BASE_URL, apiKey: WAHA_API_KEY, timeoutMs: WAHA_TIMEOUT_MS, leaseMs: LEASE_MS
});

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
  SET status = 'processing', attempts = attempts + 1, lease_until = ?, updated_at = ?, lease_token = ?
  WHERE id = ? AND status = 'pending'
`);
const markUnknownStmt = db.prepare(`
  UPDATE messages
  SET status = 'unknown', lease_until = NULL, updated_at = ?, last_error = ?
  WHERE id = ? AND status = 'processing' AND lease_token = ?
`);
const resumeConfirmedMediaStmt = db.prepare(`
  UPDATE messages SET status = 'pending', lease_until = NULL, lease_token = NULL, updated_at = ?
  WHERE status = 'processing' AND lease_until < ? AND type IN ('image','file','voice')
    AND media_sent_at IS NOT NULL AND delivery_started_at IS NULL
`);
const recoverExpiredStmt = db.prepare(`
  UPDATE messages
  SET status = 'unknown', lease_until = NULL, updated_at = ?, last_error = 'lease_expired_after_processing_delivery_state_ambiguous'
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
    lastError: row.last_error,
    mediaSentAt: row.media_sent_at,
    followupTextSentAt: row.followup_text_sent_at
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
        chunks.length = 0;
        return;
      }
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
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

function validatePayload(type, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'invalid_payload';
  if (type === 'text') return typeof payload.text === 'string' && payload.text.trim() ? null : 'payload_text_required';
  if (typeof payload.mediaId !== 'string' || !payload.mediaId.trim()) return 'payload_mediaId_required';
  const optional = type === 'voice' ? 'followupText' : 'caption';
  if (payload[optional] != null && typeof payload[optional] !== 'string') return `invalid_${optional}`;
  if (Object.keys(payload).some(key => !['mediaId', optional].includes(key))) return 'unsupported_media_payload_field';
  return null;
}
function canonicalPayload(type, payload) {
  if (type === 'text') return { text: payload.text };
  const optional = type === 'voice' ? 'followupText' : 'caption';
  return { mediaId: payload.mediaId.trim(), ...(payload[optional] != null ? { [optional]: payload[optional] } : {}) };
}
function validateCreate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'invalid_body';
  if (typeof input.chatId !== 'string' || !input.chatId.trim()) return 'chatId_required';
  if (!['text', 'image', 'file', 'voice'].includes(input.type)) return 'invalid_type';
  const payloadError = validatePayload(input.type, input.payload);
  if (payloadError) return payloadError;
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
      const result = claimMessageStmt.run(leaseUntil, now, randomUUID(), due.id);
      if (result.changes === 1) id = due.id;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  if (!id) return null;
  const row = getMessageStmt.get(id);
  return { ...serializeMessage(row), leaseToken: row.lease_token };
}

async function executeMessage(message) {
  console.log(`[SCHEDULER] executing id=${message.id} type=${message.type} mode=${DELIVERY_MODE}`);
  const delivery = DELIVERY_MODE === 'local' ? { outcome: 'sent', wahaMessageId: null } : await deliveryClient.execute(message);
  const now = nowIso();
  if (delivery.outcome === 'sent') {
    if (!deliveryClient.fencedUpdate(message, "status = 'sent', sent_at = ?, lease_until = NULL, updated_at = ?, waha_message_id = COALESCE(?, waha_message_id), last_error = NULL",
      [now, now, delivery.wahaMessageId])) {
      markUnknownStmt.run(now, 'delivery_lease_lost', message.id, message.leaseToken);
      return;
    }
    console.log(`[SCHEDULER] sent-${DELIVERY_MODE} id=${message.id}`);
  } else {
    if (delivery.outcome === 'failed') {
      if (!deliveryClient.fencedUpdate(message, "status = 'failed', lease_until = NULL, updated_at = ?, last_error = ?",
        [now, delivery.error])) markUnknownStmt.run(now, 'delivery_lease_lost', message.id, message.leaseToken);
    } else markUnknownStmt.run(now, delivery.error, message.id, message.leaseToken);
    console.log(`[SCHEDULER] ${delivery.outcome} id=${message.id} error=${delivery.error}`);
  }
}

let workerBusy = false;
let shuttingDown = false;
async function runWorker() {
  if (workerBusy || shuttingDown) return;
  workerBusy = true;
  try {
    const now = nowIso();
    resumeConfirmedMediaStmt.run(now, now);
    const recovered = recoverExpiredStmt.run(now, now);
    if (recovered.changes > 0) {
      console.warn(`[SCHEDULER] recovered_expired_leases_to_unknown count=${recovered.changes}`);
    }

    for (let i = 0; i < 20; i += 1) {
      if (shuttingDown) break;
      const message = claimNextDueMessage();
      if (!message) break;

      try {
        await executeMessage(message);
      } catch (error) {
        const failedAt = nowIso();
        markUnknownStmt.run(failedAt, 'scheduler_execution_error', message.id, message.leaseToken);
        console.error(`[SCHEDULER] execution_error_to_unknown id=${message.id}`);
      }
    }
  } catch (error) {
    console.error('[SCHEDULER] worker_error');
  } finally {
    workerBusy = false;
  }
}

function safeTokenEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isApiAuthorized(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7).trim();
  return Boolean(token) && safeTokenEqual(token, SCHEDULER_API_TOKEN);
}

function requireApiAuth(req, res) {
  if (isApiAuthorized(req)) return true;
  json(res, 401, { error: 'unauthorized' });
  return false;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return json(res, 200, {
      status: 'ok',
      service: 'skedly-scheduler',
      db: 'ok',
      worker: workerBusy ? 'busy' : 'idle',
      deliveryMode: DELIVERY_MODE,
      wahaConfigured: DELIVERY_MODE === 'waha' ? Boolean(WAHA_BASE_URL && WAHA_API_KEY) : null,
      apiAuthConfigured: Boolean(SCHEDULER_API_TOKEN)
    });
  }

  if (!requireApiAuth(req, res)) return;

  if (req.method === 'GET' && pathname === '/status') {
    return json(res, 200, {
      service: 'skedly-scheduler',
      mode: DELIVERY_MODE,
      databasePath: DB_PATH,
      workerIntervalMs: WORKER_INTERVAL_MS,
      leaseMs: LEASE_MS,
      wahaBaseUrl: DELIVERY_MODE === 'waha' ? WAHA_BASE_URL : null,
      wahaTimeoutMs: DELIVERY_MODE === 'waha' ? WAHA_TIMEOUT_MS : null,
      counts: statusSummary(),
      now: nowIso()
    });
  }

  if (req.method === 'POST' && pathname === '/v1/media') {
    const result = await mediaStore.upload(req);
    return json(res, result.status, result.body);
  }

  if (req.method === 'POST' && pathname === '/v1/messages') {
    const input = await readJson(req);
    const validationError = validateCreate(input);
    if (validationError) return json(res, 400, { error: validationError });

    const id = randomUUID();
    const clientMessageId = input.clientMessageId?.trim() || randomUUID();
    const createdAt = nowIso();
    const scheduledAt = new Date(input.scheduledAt).toISOString();

    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = getByClientIdStmt.get(clientMessageId);
      if (existing) {
        db.exec('COMMIT');
        return json(res, 200, { ...serializeMessage(existing), idempotentReplay: true });
      }
      const payload = canonicalPayload(input.type, input.payload);
      if (input.type !== 'text') mediaStore.requireBindable(payload.mediaId, input.type);
      insertMessage.run(id, clientMessageId,
        typeof input.session === 'string' && input.session.trim() ? input.session.trim() : 'default',
        input.chatId.trim(), input.type, JSON.stringify(payload), scheduledAt,
        typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : null,
        createdAt, createdAt);
      if (input.type !== 'text') {
        db.prepare('UPDATE media SET bound_message_id = ? WHERE id = ?').run(id, payload.mediaId);
        db.prepare('UPDATE messages SET media_id = ? WHERE id = ?').run(payload.mediaId, id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }

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
      if (!input || typeof input !== 'object' || Array.isArray(input)) return json(res, 400, { error: 'invalid_body' });
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
        const payloadError = validatePayload(current.type, input.payload);
        if (payloadError) return json(res, 400, { error: payloadError });
        if (current.type !== 'text' && input.payload.mediaId.trim() !== current.media_id) {
          return json(res, 409, { error: 'media_rebinding_not_supported' });
        }
        updates.push('payload_json = ?');
        values.push(JSON.stringify(canonicalPayload(current.type, input.payload)));
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
    console.error('[HTTP] request_error');
    if (!res.headersSent) {
      json(res, error?.statusCode || 500, { error: error?.statusCode ? error.message : 'internal_server_error' });
    } else {
      res.destroy();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[skedly-scheduler] listening on http://${HOST}:${server.address().port}`);
  console.log(`[skedly-scheduler] sqlite=${DB_PATH}`);
  console.log(`[skedly-scheduler] deliveryMode=${DELIVERY_MODE}`);
  console.log('[skedly-scheduler] apiAuth=enabled');
  if (DELIVERY_MODE === 'waha') {
    console.log(`[skedly-scheduler] wahaBaseUrl=${WAHA_BASE_URL}`);
  }
});

function runCleanup() {
  try { mediaStore.cleanup(); } catch { console.error('[SCHEDULER] cleanup_error'); }
}
const cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS).unref();
runCleanup();
const workerTimer = setInterval(() => { void runWorker(); }, WORKER_INTERVAL_MS).unref();
const firstWorkerTimer = setTimeout(() => { void runWorker(); }, 100).unref();

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(workerTimer); clearInterval(cleanupTimer); clearTimeout(firstWorkerTimer);
  console.log(`[skedly-scheduler] shutting_down signal=${signal}`);
  server.close(() => {
    const finish = () => {
      if (workerBusy) return setTimeout(finish, 25);
      try { db.close(); } catch {}
      process.exit(0);
    };
    finish();
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
