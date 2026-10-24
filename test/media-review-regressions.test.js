const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./helpers');

const DAY = 86400000;

test('real Android OGG Opus MIME is accepted and preserved to WAHA', async t => {
  const f = await fixture(t);
  const media = await f.upload('voice', {
    mime: 'audio/ogg; codecs=opus',
    name: 'audio_record_test.ogg',
    bytes: Buffer.from('ogg-opus-fixture')
  });
  assert.equal(media.status, 201);
  assert.equal(media.body.mimeType, 'audio/ogg; codecs=opus');

  const message = await f.create('voice', { mediaId: media.body.id });
  const final = await f.terminal(message.body.id);
  assert.equal(final.status, 'sent');
  assert.equal(f.mock.calls.length, 1);
  assert.equal(f.mock.calls[0].path, '/api/sendVoice');
  assert.equal(f.mock.calls[0].body.file.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(f.mock.calls[0].body.convert, true);
});

test('reusing clientMediaId for a different upload returns 409 instead of the wrong asset', async t => {
  const f = await fixture(t);
  const clientId = randomUUID();
  const first = await f.upload('file', {
    clientId,
    name: 'preventivo.pdf',
    mime: 'application/pdf',
    bytes: Buffer.from('version-one')
  });
  assert.equal(first.status, 201);

  const exactReplay = await f.upload('file', {
    clientId,
    name: 'preventivo.pdf',
    mime: 'application/pdf',
    bytes: Buffer.from('version-one')
  });
  assert.equal(exactReplay.status, 200);
  assert.equal(exactReplay.body.id, first.body.id);
  assert.equal(exactReplay.body.idempotentReplay, true);

  const conflictingReplay = await f.upload('file', {
    clientId,
    name: 'preventivo.pdf',
    mime: 'application/pdf',
    bytes: Buffer.from('version-two')
  });
  assert.equal(conflictingReplay.status, 409);
  assert.equal(conflictingReplay.body.error, 'clientMediaId_conflict');
});

for (const kind of ['image', 'file']) {
  test(`${kind} confirmed media checkpoint resumes after crash without duplicate WAHA call`, async t => {
    const f = await fixture(t);
    const media = (await f.upload(kind)).body;
    const message = await f.create(kind, { mediaId: media.id }, {
      scheduledAt: new Date(Date.now() + DAY).toISOString()
    });

    await f.stop();
    const past = new Date(Date.now() - 5000).toISOString();
    f.sql(db => db.prepare(`UPDATE messages
      SET status='processing', scheduled_at=?, lease_until=?, lease_token='old',
          media_sent_at=?, delivery_started_at=NULL, delivery_step=NULL
      WHERE id=?`).run(past, past, past, message.body.id));

    await f.start();
    const final = await f.terminal(message.body.id);
    assert.equal(final.status, 'sent');
    assert.ok(final.mediaSentAt);
    assert.equal(f.mock.calls.length, 0);
  });
}
