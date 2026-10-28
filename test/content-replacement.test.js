const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { fixture, until, TOKEN } = require('./helpers');
const { MediaStore } = require('../app/media');

const DAY = 86400000;
const TYPES = ['text', 'image', 'file', 'voice'];
const messageRow = (f, id) => f.sql(db => db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
const mediaRow = (f, id) => f.sql(db => db.prepare('SELECT * FROM media WHERE id = ?').get(id));
const snapshot = f => f.sql(db => ({
  messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
  media: db.prepare('SELECT * FROM media ORDER BY id').all()
}));
const cleanupAt = (f, at) => f.sql(db => new MediaStore(db, path.join(f.dir, 'media'), 26214400, () => at).cleanup());

async function content(f, type, label) {
  if (type === 'text') return { payload: { text: `${label} text` }, media: null };
  const media = (await f.upload(type, { bytes: Buffer.from(`${label} ${type}`) })).body;
  return { media, payload: { mediaId: media.id, ...(type === 'voice' ? { followupText: `${label} followup` } : { caption: `${label} caption` }) } };
}

async function pending(f, type = 'image') {
  const initial = await content(f, type, 'original');
  const response = await f.create(type, initial.payload, { scheduledAt: new Date(Date.now() + 90 * DAY).toISOString() });
  assert.equal(response.status, 201);
  return { ...initial, message: response.body };
}

// The server sends 100 Continue and starts handling the request before the
// client finishes its body. This deterministically exercises readJson's await.
async function heldPatch(t, f, id, body) {
  const bytes = JSON.stringify(body);
  const request = http.request(`${f.base}/v1/messages/${id}`, { method: 'PATCH', headers: {
    Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(bytes), Expect: '100-continue'
  } });
  t.after(() => request.destroy());
  const response = new Promise((resolve, reject) => {
    request.on('error', reject);
    request.on('response', res => {
      const chunks = [];
      res.on('error', reject);
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
  });
  const continued = once(request, 'continue');
  request.flushHeaders();
  await continued;
  return { async finish() { request.end(bytes); return response; } };
}

for (const from of TYPES) {
  for (const to of TYPES) {
    test(`atomic content replacement ${from} -> ${to} preserves identity and delivers only the new content`, async t => {
      const f = await fixture(t);
      const original = await pending(f, from);
      const replacement = await content(f, to, 'replacement');
      const before = original.message;
      f.sql(db => db.prepare('UPDATE messages SET attempts = 2 WHERE id = ?').run(before.id));
      const patch = await f.api(`/v1/messages/${before.id}`, { method: 'PATCH', body: { type: to, payload: replacement.payload } });
      assert.equal(patch.status, 200);
      for (const key of ['id', 'clientMessageId', 'scheduledAt', 'chatId', 'session', 'createdAt', 'timezone']) {
        assert.equal(patch.body[key], before[key], key);
      }
      assert.equal(patch.body.attempts, 2);
      assert.equal(patch.body.status, 'pending');
      assert.equal(patch.body.type, to);
      assert.deepEqual(patch.body.payload, replacement.payload);
      assert.equal(messageRow(f, before.id).media_id, replacement.media?.id ?? null);
      if (original.media) {
        const old = mediaRow(f, original.media.id);
        assert.equal(old.bound_message_id, null);
        assert.ok(old.deleted_at);
        assert.equal(fs.existsSync(old.storage_path), true);
      }
      if (replacement.media) {
        const fresh = mediaRow(f, replacement.media.id);
        assert.equal(fresh.bound_message_id, before.id);
        assert.equal(fresh.deleted_at, null);
      }
      assert.equal(f.mock.calls.length, 0);
      // PATCH commits before claim; the actual worker must use the new type.
      assert.equal((await f.api(`/v1/messages/${before.id}`, {
        method: 'PATCH', body: { scheduledAt: new Date(Date.now() - 1000).toISOString() }
      })).status, 200);
      const final = await f.terminal(before.id);
      assert.equal(final.status, 'sent');
      assert.equal(final.attempts, 3);
      const endpoint = { text: 'sendText', image: 'sendImage', file: 'sendFile', voice: 'sendVoice' }[to];
      assert.deepEqual(f.mock.calls.map(call => call.path), [`/api/${endpoint}`, ...(to === 'voice' ? ['/api/sendText'] : [])]);
      if (to === 'text') {
        assert.equal(f.mock.calls[0].body.text, replacement.payload.text);
        assert.equal(final.mediaSentAt, null);
      } else {
        assert.equal(f.mock.calls[0].body.file.data, Buffer.from(`replacement ${to}`).toString('base64'));
        assert.ok(final.mediaSentAt);
        if (to === 'voice') {
          assert.equal(f.mock.calls[1].body.text, replacement.payload.followupText);
          assert.ok(final.followupTextSentAt);
        } else assert.equal(f.mock.calls[0].body.caption, replacement.payload.caption);
      }
    });
  }
}

for (const kind of ['image', 'file', 'voice']) {
  test(`explicit same type/media ${kind} PATCH updates metadata without altering the media row`, async t => {
    const f = await fixture(t);
    const original = await pending(f, kind);
    const beforeMedia = mediaRow(f, original.media.id);
    const payload = { mediaId: original.media.id, ...(kind === 'voice' ? { followupText: 'updated' } : { caption: 'updated' }) };
    const patch = await f.api(`/v1/messages/${original.message.id}`, { method: 'PATCH', body: { type: kind, payload } });
    assert.equal(patch.status, 200);
    assert.deepEqual(patch.body.payload, payload);
    assert.deepEqual(mediaRow(f, original.media.id), beforeMedia);
  });
}

for (const type of ['empty', '', null, 123]) {
  test(`invalid target type ${JSON.stringify(type)} returns 400 without writes`, async t => {
    const f = await fixture(t);
    const original = await pending(f);
    const before = snapshot(f);
    const patch = await f.api(`/v1/messages/${original.message.id}`, { method: 'PATCH', body: { type, payload: { text: 'test' } } });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.error, 'invalid_type');
    assert.deepEqual(snapshot(f), before);
  });
}

test('type change always requires an explicit final payload; captions and followups are never converted to text', async t => {
  const f = await fixture(t);
  for (const from of TYPES) {
    const original = await pending(f, from);
    for (const to of TYPES.filter(value => value !== from)) {
      const before = snapshot(f);
      const patch = await f.api(`/v1/messages/${original.message.id}`, { method: 'PATCH', body: { type: to } });
      assert.equal(patch.status, 400);
      assert.equal(patch.body.error, 'type_change_requires_payload');
      assert.deepEqual(snapshot(f), before);
    }
  }
});

test('empty text and incompatible final payloads return 400 with full rollback', async t => {
  const f = await fixture(t);
  const original = await pending(f, 'voice');
  for (const body of [
    { type: 'text', payload: { text: '' } }, { type: 'text', payload: { text: '  \n ' } },
    { type: 'text', payload: { caption: 'not text' } }, { type: 'text', payload: { followupText: 'not text' } },
    { type: 'image', payload: {} }, { type: 'file', payload: { text: 'not a media' } },
    { type: 'text', payload: null }, { type: 'text', payload: [] }
  ]) {
    const before = snapshot(f);
    const patch = await f.api(`/v1/messages/${original.message.id}`, { method: 'PATCH', body });
    assert.equal(patch.status, 400);
    assert.deepEqual(snapshot(f), before);
  }
});

for (const reason of ['missing', 'deleted', 'physical_missing', 'kind_mismatch', 'occupied']) {
  test(`cross-type replacement rejects B ${reason} and rolls back the whole job and both bindings`, async t => {
    const f = await fixture(t);
    const original = await pending(f, 'image');
    const replacement = reason === 'missing' ? { id: randomUUID() } :
      (await f.upload(reason === 'kind_mismatch' ? 'voice' : 'file')).body;
    if (reason === 'deleted') f.sql(db => db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), replacement.id));
    if (reason === 'physical_missing') fs.unlinkSync(mediaRow(f, replacement.id).storage_path);
    if (reason === 'occupied') assert.equal((await f.create('file', { mediaId: replacement.id }, {
      scheduledAt: new Date(Date.now() + DAY).toISOString()
    })).status, 201);
    const before = snapshot(f);
    const patch = await f.api(`/v1/messages/${original.message.id}`, { method: 'PATCH', body: {
      type: 'file', payload: { mediaId: replacement.id, caption: 'replacement' },
      session: 'replacement-session', chatId: 'test-target', scheduledAt: new Date(Date.now() + 2 * DAY).toISOString()
    } });
    assert.equal(patch.status, reason === 'occupied' ? 409 : 400);
    assert.equal(patch.body.error, reason === 'occupied' ? 'media_already_bound' :
      reason === 'kind_mismatch' ? 'media_kind_mismatch' : 'media_not_found_or_deleted');
    assert.deepEqual(snapshot(f), before);
    assert.equal(fs.existsSync(mediaRow(f, original.media.id).storage_path), true);
  });
}

test('changing kind with the same old mediaId validates the new kind before releasing A', async t => {
  const f = await fixture(t);
  const original = await pending(f, 'image');
  const before = snapshot(f);
  const patch = await f.api(`/v1/messages/${original.message.id}`, { method: 'PATCH', body: { type: 'file', payload: { mediaId: original.media.id } } });
  assert.equal(patch.status, 400);
  assert.equal(patch.body.error, 'media_kind_mismatch');
  assert.deepEqual(snapshot(f), before);
});

for (const [from, to] of [['image', 'file'], ['voice', 'text'], ['text', 'voice']]) {
  test(`forced SQLite failure during ${from} -> ${to} restores type, payload, media_id, bindings and tombstones`, async t => {
    const f = await fixture(t);
    const original = await pending(f, from);
    const replacement = await content(f, to, 'replacement');
    f.sql(db => db.exec(`CREATE TRIGGER force_content_rollback AFTER UPDATE OF payload_json ON messages
      WHEN NEW.id = '${original.message.id}' BEGIN SELECT RAISE(ABORT, 'forced_content_failure'); END`));
    const before = snapshot(f);
    const patch = await f.api(`/v1/messages/${original.message.id}`, { method: 'PATCH', body: {
      type: to, payload: replacement.payload, session: 'changed', chatId: 'test-target',
      scheduledAt: new Date(Date.now() + DAY).toISOString()
    } });
    assert.equal(patch.status, 500);
    assert.equal(patch.body.error, 'internal_server_error');
    assert.deepEqual(snapshot(f), before);
    if (original.media) assert.equal(fs.existsSync(mediaRow(f, original.media.id).storage_path), true);
    if (replacement.media) assert.equal(fs.existsSync(mediaRow(f, replacement.media.id).storage_path), true);
  });
}

test('worker claims while PATCH body is incomplete: 409 and no content or binding changes', async t => {
  const f = await fixture(t, { WAHA_TIMEOUT_MS: '10000' });
  f.mock.replies.push('timeout');
  const original = await pending(f, 'image');
  const replacement = await content(f, 'file', 'replacement');
  const held = await heldPatch(t, f, original.message.id, { type: 'file', payload: replacement.payload });
  assert.equal((await f.api(`/v1/messages/${original.message.id}`, {
    method: 'PATCH', body: { scheduledAt: new Date(Date.now() - 1000).toISOString() }
  })).status, 200);
  await until(() => f.mock.calls.length === 1);
  assert.equal(messageRow(f, original.message.id).status, 'processing');
  const before = snapshot(f);
  const patch = await held.finish();
  assert.equal(patch.status, 409);
  assert.equal(patch.body.error, 'only_pending_messages_can_be_modified');
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.mock.calls[0].path, '/api/sendImage');
});

test('PATCH without type re-reads the latest type after waiting for the request body', async t => {
  const f = await fixture(t);
  const original = await pending(f, 'image');
  const held = await heldPatch(t, f, original.message.id, { payload: { text: 'latest text edit' } });
  assert.equal((await f.api(`/v1/messages/${original.message.id}`, {
    method: 'PATCH', body: { type: 'text', payload: { text: 'first text edit' } }
  })).status, 200);
  const patch = await held.finish();
  assert.equal(patch.status, 200);
  assert.equal(patch.body.type, 'text');
  assert.deepEqual(patch.body.payload, { text: 'latest text edit' });
});

test('one replacement B cannot be assigned concurrently to two pending jobs', async t => {
  const f = await fixture(t);
  const first = await pending(f, 'text');
  const second = await pending(f, 'image');
  const replacement = await content(f, 'file', 'replacement');
  const patches = await Promise.all([first, second].map(item => f.api(`/v1/messages/${item.message.id}`, {
    method: 'PATCH', body: { type: 'file', payload: replacement.payload }
  })));
  assert.deepEqual(patches.map(patch => patch.status).sort(), [200, 409]);
  const winner = patches.find(patch => patch.status === 200).body;
  const loser = winner.id === first.message.id ? second : first;
  assert.equal(mediaRow(f, replacement.media.id).bound_message_id, winner.id);
  assert.equal(messageRow(f, loser.message.id).type, loser.message.type);
  assert.deepEqual(JSON.parse(messageRow(f, loser.message.id).payload_json), loser.payload);
  if (loser.media) assert.equal(mediaRow(f, loser.media.id).deleted_at, null);
});

test('media -> text tombstones A and lets cleanup unlink only after commit', async t => {
  const f = await fixture(t);
  const original = await pending(f, 'voice');
  assert.equal((await f.api(`/v1/messages/${original.message.id}`, {
    method: 'PATCH', body: { type: 'text', payload: { text: 'explicit final text' } }
  })).status, 200);
  const retired = mediaRow(f, original.media.id);
  assert.equal(retired.bound_message_id, null);
  assert.ok(retired.deleted_at);
  assert.equal(fs.existsSync(retired.storage_path), true);
  cleanupAt(f, Date.now());
  assert.equal(fs.existsSync(retired.storage_path), false);
  assert.equal(messageRow(f, original.message.id).media_id, null);
});

test('text -> media protects B while pending; failed and abandoned replacements keep 24h orphan retention', async t => {
  const f = await fixture(t);
  const original = await pending(f, 'text');
  const bound = await content(f, 'file', 'bound');
  const abandoned = await content(f, 'file', 'abandoned');
  const failed = await content(f, 'voice', 'wrong kind');
  assert.equal((await f.api(`/v1/messages/${original.message.id}`, {
    method: 'PATCH', body: { type: 'file', payload: failed.payload }
  })).status, 400);
  assert.equal((await f.api(`/v1/messages/${original.message.id}`, {
    method: 'PATCH', body: { type: 'file', payload: bound.payload }
  })).status, 200);
  const at = Date.now();
  cleanupAt(f, at + DAY - 5000);
  for (const item of [bound, abandoned, failed]) assert.equal(mediaRow(f, item.media.id).deleted_at, null);
  cleanupAt(f, at + DAY + 5000);
  for (const item of [abandoned, failed]) {
    const row = mediaRow(f, item.media.id);
    assert.ok(row.deleted_at);
    assert.equal(fs.existsSync(row.storage_path), false);
  }
  cleanupAt(f, at + 60 * DAY);
  assert.equal(mediaRow(f, bound.media.id).deleted_at, null);
  assert.equal(fs.existsSync(mediaRow(f, bound.media.id).storage_path), true);
});

test('DELETE and create/upload idempotency remain correct after a type change', async t => {
  const f = await fixture(t);
  const original = await pending(f, 'text');
  const uploadOptions = { clientId: randomUUID(), bytes: Buffer.from('idempotent file') };
  const asset = (await f.upload('file', uploadOptions)).body;
  assert.equal((await f.api(`/v1/messages/${original.message.id}`, {
    method: 'PATCH', body: { type: 'file', payload: { mediaId: asset.id } }
  })).status, 200);
  const replay = await f.create('text', original.payload, {
    clientMessageId: original.message.clientMessageId, scheduledAt: original.message.scheduledAt
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.id, original.message.id);
  assert.equal(replay.body.type, 'file');
  assert.equal(replay.body.payload.mediaId, asset.id);
  assert.equal((await f.upload('file', uploadOptions)).body.id, asset.id);
  assert.equal((await f.api(`/v1/messages/${original.message.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await f.api(`/v1/messages/${original.message.id}`)).status, 404);
  cleanupAt(f, Date.now());
  assert.ok(mediaRow(f, asset.id).deleted_at);
  assert.equal(fs.existsSync(mediaRow(f, asset.id).storage_path), false);
});
