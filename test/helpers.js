const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createWahaMock } = require('./waha-mock');
const TOKEN = 'test-scheduler-token-1234567890';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 7000) {
  const end = Date.now() + timeout;
  do { const value = await fn(); if (value) return value; await delay(30); } while (Date.now() < end);
  throw new Error('condition_timeout');
}
async function fixture(t, extra = {}, legacy = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skedly-test-'));
  const dbPath = path.join(dir, 'scheduler.db');
  if (legacy) {
    const db = new DatabaseSync(dbPath);
    db.exec(fs.readFileSync(path.join(__dirname, 'm4-schema.sql'), 'utf8'));
    db.prepare(`INSERT INTO messages (id,client_message_id,session,chat_id,type,payload_json,scheduled_at,status,created_at,updated_at)
      VALUES ('m4','m4','default','393331234567@c.us','text','{"text":"legacy"}',?,'pending',?,?)`)
      .run(new Date(Date.now()+86400000).toISOString(), new Date().toISOString(), new Date().toISOString());
    db.close();
  }
  const mock = await createWahaMock();
  let child, base, logs = '';
  const f = {
    dir, dbPath, mock, get base() { return base; }, get logs() { return logs; },
    sql(fn) { const db = new DatabaseSync(dbPath); db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;'); try { return fn(db); } finally { db.close(); } },
    async start() {
      child = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '../app/server.js')], {
        env: { ...process.env, PORT: '0', DB_PATH: dbPath, MEDIA_DIR: path.join(dir, 'media'),
          WORKER_INTERVAL_MS: '250', LEASE_MS: '5000', DELIVERY_MODE: 'waha', WAHA_BASE_URL: mock.url,
          WAHA_API_KEY: 'test-waha-key', WAHA_TIMEOUT_MS: '1000', SCHEDULER_API_TOKEN: TOKEN, ...extra },
        stdio: ['ignore','pipe','pipe']
      });
      let current = '';
      child.stdout.on('data', chunk => { logs += chunk; current += chunk; });
      child.stderr.on('data', chunk => { logs += chunk; });
      const port = await until(() => {
        if (child.exitCode !== null) throw new Error(`scheduler_exited:${logs}`);
        return current.match(/listening on http:\/\/0.0.0.0:(\d+)/)?.[1];
      });
      base = `http://127.0.0.1:${port}`;
    },
    async stop(signal = 'SIGKILL') {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill(signal); await exited;
      }
    },
    async api(route, { method = 'GET', body, auth = true, headers = {} } = {}) {
      const response = await fetch(base + route, { method,
        headers: { ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
          ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: response.status === 204 ? null : await response.json() };
    },
    async upload(kind = 'file', options = {}) {
      const form = new FormData();
      form.set('file', new Blob([options.bytes || Buffer.from('media-content')], { type: options.mime || ({ image:'image/png',file:'application/pdf',voice:'audio/ogg' }[kind]) }), options.name || 'original.pdf');
      form.set('clientMediaId', options.clientId || randomUUID()); form.set('kind', kind);
      return f.api('/v1/media', { method:'POST', body:form, auth:options.auth ?? true });
    },
    create(type, payload, options = {}) {
      return f.api('/v1/messages', { method:'POST', body: { clientMessageId:randomUUID(), session:'default',
        chatId:'393331234567@c.us', type, payload, scheduledAt:new Date(Date.now()-1000).toISOString(), ...options } });
    },
    async terminal(id) {
      return until(async () => { const r = await f.api(`/v1/messages/${id}`); return ['sent','failed','unknown'].includes(r.body.status) ? r.body : false; });
    }
  };
  t.after(async () => { await f.stop(); await mock.close(); fs.rmSync(dir, { recursive:true, force:true }); });
  await f.start();
  return f;
}
module.exports = { fixture, until, delay, TOKEN };
