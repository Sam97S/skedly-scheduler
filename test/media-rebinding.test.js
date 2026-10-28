const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixture, until } = require('./helpers');
const { MediaStore } = require('../app/media');

const DAY = 86400000;

function mediaRow(f, id) {
  return f.sql(db => db.prepare('SELECT * FROM media WHERE id = ?').get(id));
}

function messageRow(f, id) {
  return f.sql(db => db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
}

function cleanupAt(f, now) {
  return f.sql(db => new MediaStore(db, path.join(f.dir, 'media'), 26214400, () => now).cleanup());
}

function assertMessageUnchanged(before, after) {
  assert.deepEqual(after, before);
}

for (const scenario of [
  { kind: 'image', optional: { caption: 'new image caption' }, paths: ['/api/sendImage'] },
  { kind: 'file', optional: { caption: 'new file caption' }, paths: ['/api/sendFile'] },
  { kind: 'voice', optional: { followupText: 'new voice followup' }, paths: ['/api/sendVoice', '/api/sendText'] }
]) {
  test(`${scenario.kind} pending message atomically rebinds A -> B and delivers B`, async t => {
    const f = await fixture(t);
    const oldBytes = Buffer.from(`old-${scenario.kind}`);
    const newBytes = Buffer.from(`new-${scenario.kind}`);
    const oldMedia = (await f.upload(scenario.kind, { bytes: oldBytes })).body;
    const newMedia = (await f.upload(scenario.kind, { bytes: newBytes })).body;
    const scheduledAt = new Date(Date.now() + DAY).toISOString();
    const created = await f.create(scenario.kind, { mediaId: oldMedia.id }, { scheduledAt });
    const original = created.body;

    const patch = await f.api(`/v1/messages/${original.id}`, {
      method: 'PATCH', body: { payload: { mediaId: newMedia.id, ...scenario.optional } }
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.id, original.id);
    assert.equal(patch.body.clientMessageId, original.clientMessageId);
    assert.equal(patch.body.scheduledAt, scheduledAt);
    assert.equal(patch.body.chatId, original.chatId);
    assert.equal(patch.body.attempts, 0);
    assert.equal(patch.body.status, 'pending');
    assert.deepEqual(patch.body.payload, { mediaId: newMedia.id, ...scenario.optional });

    const oldAfter = mediaRow(f, oldMedia.id);
    const newAfter = mediaRow(f, newMedia.id);
    const stored = messageRow(f, original.id);
    assert.equal(oldAfter.bound_message_id, null);
    assert.ok(oldAfter.deleted_at);
    assert.equal(fs.existsSync(oldAfter.storage_path), true);
    assert.equal(newAfter.bound_message_id, original.id);
    assert.equal(newAfter.deleted_at, null);
    assert.equal(stored.media_id, newMedia.id);
    assert.deepEqual(JSON.parse(stored.payload_json), { mediaId: newMedia.id, ...scenario.optional });

    const release = await f.api(`/v1/messages/${original.id}`, {
      method: 'PATCH', body: { scheduledAt: new Date(Date.now() - 1000).toISOString() }
    });
    assert.equal(release.status, 200);
    assert.equal((await f.terminal(original.id)).status, 'sent');
    assert.deepEqual(f.mock.calls.map(call => call.path), scenario.paths);
    assert.equal(f.mock.calls[0].body.file.data, newBytes.toString('base64'));
    if (scenario.optional.caption) assert.equal(f.mock.calls[0].body.caption, scenario.optional.caption);
    if (scenario.optional.followupText) assert.equal(f.mock.calls[1].body.text, scenario.optional.followupText);
  });
}

test('PATCH with the same mediaId updates caption without rebinding or tombstoning', async t => {
  const f = await fixture(t);
  const media = (await f.upload('image')).body;
  const created = await f.create('image', { mediaId: media.id }, { scheduledAt: new Date(Date.now() + DAY).toISOString() });
  const patch = await f.api(`/v1/messages/${created.body.id}`, {
    method: 'PATCH', body: { payload: { mediaId: media.id, caption: 'same asset' } }
  });
  assert.equal(patch.status, 200);
  assert.deepEqual(patch.body.payload, { mediaId: media.id, caption: 'same asset' });
  const after = mediaRow(f, media.id);
  assert.equal(after.bound_message_id, created.body.id);
  assert.equal(after.deleted_at, null);
});

test('missing replacement media returns 400 without modifying A or the message', async t => {
  const f = await fixture(t);
  const oldMedia = (await f.upload('file')).body;
  const created = await f.create('file', { mediaId: oldMedia.id }, { scheduledAt: new Date(Date.now() + DAY).toISOString() });
  const beforeMessage = messageRow(f, created.body.id);
  const beforeOld = mediaRow(f, oldMedia.id);
  const patch = await f.api(`/v1/messages/${created.body.id}`, {
    method: 'PATCH', body: { payload: { mediaId: randomUUID() } }
  });
  assert.equal(patch.status, 400);
  assert.equal(patch.body.error, 'media_not_found_or_deleted');
  assertMessageUnchanged(beforeMessage, messageRow(f, created.body.id));
  assert.deepEqual(mediaRow(f, oldMedia.id), beforeOld);
});

test('deleted replacement media returns 400 without modifying A or the message', async t => {
  const f = await fixture(t);
  const oldMedia = (await f.upload('file')).body;
  const replacement = (await f.upload('file')).body;
  const created = await f.create('file', { mediaId: oldMedia.id }, { scheduledAt: new Date(Date.now() + DAY).toISOString() });
  f.sql(db => db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), replacement.id));
  const beforeMessage = messageRow(f, created.body.id);
  const beforeOld = mediaRow(f, oldMedia.id);
  const patch = await f.api(`/v1/messages/${created.body.id}`, {
    method: 'PATCH', body: { payload: { mediaId: replacement.id } }
  });
  assert.equal(patch.status, 400);
  assert.equal(patch.body.error, 'media_not_found_or_deleted');
  assertMessageUnchanged(beforeMessage, messageRow(f, created.body.id));
  assert.deepEqual(mediaRow(f, oldMedia.id), beforeOld);
  assert.equal(mediaRow(f, replacement.id).bound_message_id, null);
});

test('replacement with a missing physical file returns 400 without modifying A or the message', async t => {
  const f = await fixture(t);
  const oldMedia = (await f.upload('file')).body;
  const replacement = (await f.upload('file')).body;
  const created = await f.create('file', { mediaId: oldMedia.id }, { scheduledAt: new Date(Date.now() + DAY).toISOString() });
  fs.unlinkSync(mediaRow(f, replacement.id).storage_path);
  const beforeMessage = messageRow(f, created.body.id);
  const beforeOld = mediaRow(f, oldMedia.id);
  const patch = await f.api(`/v1/messages/${created.body.id}`, {
    method: 'PATCH', body: { payload: { mediaId: replacement.id } }
  });
  assert.equal(patch.status, 400);
  assert.equal(patch.body.error, 'media_not_found_or_deleted');
  assertMessageUnchanged(beforeMessage, messageRow(f, created.body.id));
  assert.deepEqual(mediaRow(f, oldMedia.id), beforeOld);
  assert.equal(mediaRow(f, replacement.id).bound_message_id, null);
});

test('replacement media kind mismatch returns 400 without modifying bindings', async t => {
  const f = await fixture(t);
  const oldMedia = (await f.upload('file')).body;
  const replacement = (await f.upload('image')).body;
  const created = await f.create('file', { mediaId: oldMedia.id }, { scheduledAt: new Date(Date.now() + DAY).toISOString() });
  const beforeMessage = messageRow(f, created.body.id);
  const patch = await f.api(`/v1/messages/${created.body.id}`, {
    method: 'PATCH', body: { payload: { mediaId: replacement.id } }
  });
  assert.equal(patch.status, 400);
  assert.equal(patch.body.error, 'media_kind_mismatch');
  assertMessageUnchanged(beforeMessage, messageRow(f, created.body.id));
  assert.equal(mediaRow(f, oldMedia.id).bound_message_id, created.body.id);
  assert.equal(mediaRow(f, replacement.id).bound_message_id, null);
});

test('replacement media bound to another message returns 409 without modifying either job', async t => {
  const f = await fixture(t);
  const oldMedia = (await f.upload('file')).body;
  const replacement = (await f.upload('file')).body;
  const first = await f.create('file', { mediaId: oldMedia.id }, { scheduledAt: new Date(Date.now() + DAY).toISOString() });
  const owner = await f.create('file', { mediaId: replacement.id }, { scheduledAt: new Date(Date.now() + DAY).toISOString() });
  const beforeFirst = messageRow(f, first.body.id);
  const beforeOwner = messageRow(f, owner.body.id);
  const patch = await f.api(`/v1/messages/${first.body.id}`, {
    method: 'PATCH', body: { payload: { mediaId: replacement.id } }
  });
  assert.equal(patch.status, 409);
  assert.equal(patch.body.error, 'media_already_bound');
  assertMessageUnchanged(beforeFirst, messageRow(f, first.body.id));
  assertMessageUnchanged(beforeOwner, messageRow(f, owner.body.id));
  assert.equal(mediaRow(f, oldMedia.id).bound_message_id, first.body.id);
  assert.equal(mediaRow(f, replacement.id).bound_message_id, owner.body.id);
});

test('worker claim wins race: PATCH returns 409 and leaves both media bindings unchanged', async t => {
  const f = await fixture(t);
  f.mock.replies.push('timeout');
  const oldMedia = (await f.upload('file')).body;
  const replacement = (await f.upload('file')).body;
  const created = await f.create('file', { mediaId: oldMedia.id });
  await until(() => f.mock.calls.length === 1);
  const patch = await f.api(`/v1/messages/${created.body.id}`, {
    method: 'PATCH', body: { payload: { mediaId: replacement.id } }
  });
  assert.equal(patch.status, 409);
  assert.equal(patch.body.error, 'only_pending_messages_can_be_modified');
  assert.equal(mediaRow(f, oldMedia.id).bound_message_id, created.body.id);
  assert.equal(mediaRow(f, oldMedia.id).deleted_at, null);
  assert.equal(mediaRow(f, replacement.id).bound_message_id, null);
  assert.equal(mediaRow(f, replacement.id).deleted_at, null);
  assert.equal((await f.terminal(created.body.id)).status, 'unknown');
  assert.equal(f.mock.calls.length, 1);
});

test('forced SQLite failure rolls back A tombstone, B binding, payload and media_id', async t => {
  const f = await fixture(t);
  const oldMedia = (await f.upload('voice')).body;
  const replacement = (await f.upload('voice')).body;
  const created = await f.create('voice', { mediaId: oldMedia.id, followupText: 'old' }, {
    scheduledAt: new Date(Date.now() + DAY).toISOString()
  });
  const beforeMessage = messageRow(f, created.body.id);
  const beforeOld = mediaRow(f, oldMedia.id);
  const beforeNew = mediaRow(f, replacement.id);
  f.sql(db => db.exec(`CREATE TRIGGER force_rebind_rollback
    BEFORE UPDATE OF media_id ON messages
    WHEN NEW.id = '${created.body.id}'
    BEGIN SELECT RAISE(ABORT, 'forced_rebind_failure'); END`));

  const patch = await f.api(`/v1/messages/${created.body.id}`, {
    method: 'PATCH', body: { payload: { mediaId: replacement.id, followupText: 'new' } }
  });
  assert.equal(patch.status, 500);
  assert.equal(patch.body.error, 'internal_server_error');
  assertMessageUnchanged(beforeMessage, messageRow(f, created.body.id));
  assert.deepEqual(mediaRow(f, oldMedia.id), beforeOld);
  assert.deepEqual(mediaRow(f, replacement.id), beforeNew);
});

test('old A is immediately unusable after commit and cleanup removes only A', async t => {
  const f = await fixture(t);
  const oldMedia = (await f.upload('image')).body;
  const replacement = (await f.upload('image')).body;
  const created = await f.create('image', { mediaId: oldMedia.id }, { scheduledAt: new Date(Date.now() + DAY).toISOString() });
  assert.equal((await f.api(`/v1/messages/${created.body.id}`, {
    method: 'PATCH', body: { payload: { mediaId: replacement.id } }
  })).status, 200);
  const oldAfter = mediaRow(f, oldMedia.id);
  const replacementAfter = mediaRow(f, replacement.id);
  assert.ok(oldAfter.deleted_at);
  assert.equal(fs.existsSync(oldAfter.storage_path), true);
  assert.equal(replacementAfter.deleted_at, null);
  cleanupAt(f, Date.now() + 60 * DAY);
  assert.equal(fs.existsSync(oldAfter.storage_path), false);
  assert.equal(fs.existsSync(replacementAfter.storage_path), true);
  assert.equal(mediaRow(f, replacement.id).bound_message_id, created.body.id);
});

test('uploaded B abandoned before PATCH follows existing orphan retention', async t => {
  const f = await fixture(t);
  const started = Date.now();
  const replacement = (await f.upload('file')).body;
  const row = mediaRow(f, replacement.id);
  cleanupAt(f, started + DAY - 1000);
  assert.equal(fs.existsSync(row.storage_path), true);
  assert.equal(mediaRow(f, replacement.id).deleted_at, null);
  cleanupAt(f, started + DAY + 1000);
  assert.equal(fs.existsSync(row.storage_path), false);
  assert.ok(mediaRow(f, replacement.id).deleted_at);
});

test('DELETE regression removes pending message and leaves media to normal cleanup', async t => {
  const f = await fixture(t);
  const media = (await f.upload('file')).body;
  const created = await f.create('file', { mediaId: media.id }, { scheduledAt: new Date(Date.now() + DAY).toISOString() });
  assert.equal((await f.api(`/v1/messages/${created.body.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await f.api(`/v1/messages/${created.body.id}`)).status, 404);
  const beforeCleanup = mediaRow(f, media.id);
  assert.equal(beforeCleanup.bound_message_id, created.body.id);
  assert.equal(beforeCleanup.deleted_at, null);
  cleanupAt(f, Date.now());
  assert.ok(mediaRow(f, media.id).deleted_at);
  assert.equal(fs.existsSync(beforeCleanup.storage_path), false);
});
