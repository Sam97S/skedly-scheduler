const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { fixture, until, delay } = require('./helpers');
const { MediaStore, sanitizeFilename } = require('../app/media');
const DAY = 86400000;

function cleanupAt(f, now) {
  return f.sql(db => new MediaStore(db, path.join(f.dir,'media'), 26214400, () => now).cleanup());
}
function fileFor(f, id) { return f.sql(db => db.prepare('SELECT * FROM media WHERE id = ?').get(id)); }

// M4 regression, including its original WAHA payload and persistent DB contract.
test('M4 auth protects /status and all /v1 routes; health remains public', async t => {
  const f = await fixture(t);
  const health = await f.api('/health', { auth:false });
  assert.equal(health.status, 200); assert.equal(health.body.apiAuthConfigured, true);
  assert.equal(health.body.db, 'ok'); assert.equal(health.body.wahaConfigured, true);
  for (const [route, method] of [['/status','GET'],['/v1/messages','GET'],['/v1/messages','POST'],['/v1/media','POST'],['/v1/messages/x','PATCH'],['/v1/messages/x','DELETE'],['/v1/unknown','GET']]) {
    const result = await f.api(route, { method, auth:false }); assert.equal(result.status, 401);
  }
  for (const token of ['Bearer wrong','Basic test','Bearer ']) {
    assert.equal((await f.api('/status', { headers:{Authorization:token} })).status, 401);
  }
  assert.equal((await f.api('/status')).status, 200);
});

test('M4 text scheduling, restart, idempotency, CRUD, timing and exactly one WAHA call', async t => {
  const f = await fixture(t), at = Date.now()+1600, clientMessageId = randomUUID();
  const payload = {text:'Skedly Milestone 3 integration test'};
  const options = {scheduledAt:new Date(at).toISOString(), clientMessageId};
  const created = await f.create('text', payload, options);
  assert.equal(created.status,201); assert.equal(created.body.status,'pending');
  const id = created.body.id;
  const replay = await f.create('text', payload, options);
  assert.equal(replay.body.id,id); assert.equal(replay.body.idempotentReplay,true);
  assert.equal((await f.api(`/v1/messages/${id}`, {method:'PATCH',body:{timezone:'Europe/Rome'}})).status,200);
  const disposable = await f.create('text', {text:'delete'}, {scheduledAt:new Date(Date.now()+DAY).toISOString()});
  assert.equal((await f.api(`/v1/messages/${disposable.body.id}`, {method:'DELETE'})).status,204);
  assert.equal((await f.api(`/v1/messages/${disposable.body.id}`)).status,404);
  assert.equal((await f.api('/v1/messages?status=pending')).body.messages.length,1);
  await f.stop(); await f.start();
  assert.equal((await f.api(`/v1/messages/${id}`)).body.status,'pending');
  assert.equal(f.mock.calls.length,0);
  const final = await f.terminal(id);
  assert.equal(final.status,'sent'); assert.equal(final.wahaMessageId,'mock-message-id-123');
  assert.deepEqual(f.mock.calls[0].body,{session:'default',chatId:'393331234567@c.us',text:payload.text});
  assert.ok(f.mock.calls[0].at>=at); assert.equal(f.mock.calls[0].path,'/api/sendText');
  assert.equal((await f.api(`/v1/messages/${id}`, {method:'PATCH',body:{payload:{text:'changed'}}})).status,409);
  assert.equal((await f.api(`/v1/messages/${id}`, {method:'DELETE'})).status,409);
  await delay(300); assert.equal(f.mock.calls.length,1);
});

test('incremental migration preserves unversioned production M4 rows and is restart-idempotent', async t => {
  const f = await fixture(t, {}, true);
  assert.equal((await f.api('/v1/messages/m4')).body.payload.text,'legacy');
  f.sql(db => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  });
  await f.stop(); await f.start();
  assert.equal((await f.api('/v1/messages/m4')).body.clientMessageId,'m4');
});

for (const [reply, expected] of [[400,'failed'],[500,'unknown'],['timeout','unknown'],['network','unknown']]) {
  test(`M4 text error semantics ${reply} -> ${expected}, no blind retry`, async t => {
    const f = await fixture(t); f.mock.replies.push(reply);
    const created = await f.create('text',{text:'regression'});
    assert.equal((await f.terminal(created.body.id)).status,expected);
    await f.stop(); await f.start(); await delay(350);
    assert.equal(f.mock.calls.length,1);
    assert.ok(!f.logs.includes('SECRET_ECHO'));
  });
}

test('upload auth, SHA256, private UUID storage, sanitized name, persistent bytes and concurrent clientMediaId replay', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload('file',{auth:false})).status,401);
  const options = {clientId:randomUUID(), name:'fattura ottobre.pdf',bytes:Buffer.from('pdf bytes')};
  const uploads = await Promise.all([f.upload('file',options),f.upload('file',options)]);
  assert.deepEqual(uploads.map(r=>r.status).sort(),[200,201]);
  const media = uploads[0].body;
  assert.equal(media.id,uploads[1].body.id);
  assert.equal(media.sha256,createHash('sha256').update(options.bytes).digest('hex'));
  const row = fileFor(f,media.id);
  assert.equal(path.basename(row.storage_path),media.id);
  assert.equal(row.original_filename,options.name); assert.equal(row.mime_type,'application/pdf');
  assert.equal(fs.readFileSync(row.storage_path).toString(),'pdf bytes');
  assert.equal(fs.readdirSync(path.join(f.dir,'media')).length,1);
  await f.stop(); await f.start();
  const replay = await f.upload('file',options);
  assert.equal(replay.body.id,media.id); assert.equal(replay.body.idempotentReplay,true);
  assert.equal(fileFor(f,media.id).sha256,row.sha256);
  assert.equal(sanitizeFilename('../../private\\bad\u0000:name.pdf'),'bad_:name.pdf'.replace(':','_'));
  assert.equal(sanitizeFilename('...'),'attachment');
  assert.ok(!f.logs.includes('pdf bytes'));
});

test('25 MiB accepted, 25 MiB + 1 rejected with 413, no partial assets', async t => {
  const f = await fixture(t);
  const accepted = await f.upload('file',{bytes:Buffer.alloc(26214400,3)});
  assert.equal(accepted.status,201); assert.equal(accepted.body.sizeBytes,26214400);
  assert.equal((await f.upload('file',{bytes:Buffer.alloc(26214401,3)})).status,413);
  assert.equal((await f.upload('file',{bytes:Buffer.alloc(26314400,3)})).status,413);
  assert.equal(fs.readdirSync(path.join(f.dir,'media')).length,1);
});

test('MAX_MEDIA_BYTES env enforced and malformed uploads rejected', async t => {
  const f = await fixture(t,{MAX_MEDIA_BYTES:'8'});
  assert.equal((await f.upload('file',{bytes:Buffer.alloc(8)})).status,201);
  assert.equal((await f.upload('file',{bytes:Buffer.alloc(9)})).status,413);
  assert.equal((await f.api('/v1/media',{method:'POST',body:{file:'bad'}})).status,415);
  assert.equal((await f.upload('image',{mime:'text/plain',bytes:Buffer.from('x')})).status,400);
  assert.equal((await f.upload('voice',{mime:'text/plain',bytes:Buffer.from('x')})).status,400);
  assert.equal((await f.upload('file',{bytes:Buffer.alloc(0)})).status,400);
});

test('binding is atomic, rejects missing/deleted/mismatched/already bound assets; message replay remains idempotent', async t => {
  const f = await fixture(t);
  assert.equal((await f.create('file',{mediaId:randomUUID()})).status,400);
  const asset = (await f.upload()).body;
  assert.equal((await f.create('image',{mediaId:asset.id})).status,400);
  assert.equal(fileFor(f,asset.id).bound_message_id,null);
  const opts = {scheduledAt:new Date(Date.now()+DAY).toISOString(),clientMessageId:randomUUID()};
  const message = await f.create('file',{mediaId:asset.id},opts);
  assert.equal(message.status,201); assert.equal(fileFor(f,asset.id).bound_message_id,message.body.id);
  assert.equal((await f.create('file',{mediaId:asset.id},opts)).body.id,message.body.id);
  assert.equal((await f.create('file',{mediaId:asset.id})).status,409);
  assert.equal((await f.api(`/v1/messages/${message.body.id}`,{method:'PATCH',body:{payload:{mediaId:randomUUID()}}})).status,409);
  const deleted = (await f.upload()).body;
  f.sql(db=>db.prepare('UPDATE media SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(),deleted.id));
  assert.equal((await f.create('file',{mediaId:deleted.id})).status,400);
  assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM messages').get().n),1);
});

for (const kind of ['image','file']) {
  test(`${kind} WAHA payload uses MIME, sanitized original filename, base64 only at delivery, caption, and scheduledAt`, async t => {
    const f = await fixture(t);
    const bytes = Buffer.from('binary-fixture');
    const media = (await f.upload(kind,{bytes,name:'invoice-ottobre.pdf'})).body;
    const at=Date.now()+800;
    const message=await f.create(kind,{mediaId:media.id,caption:'caption'}, {session:'personal',scheduledAt:new Date(at).toISOString()});
    await f.stop(); await f.start();
    assert.equal(f.mock.calls.length,0);
    const final=await f.terminal(message.body.id);
    assert.equal(final.status,'sent'); assert.ok(final.mediaSentAt);
    const call=f.mock.calls[0];
    assert.equal(call.path,kind==='image'?'/api/sendImage':'/api/sendFile');
    assert.deepEqual(call.body,{session:'personal',chatId:'393331234567@c.us',file:{mimetype:media.mimeType,filename:media.originalFilename,data:bytes.toString('base64')},caption:'caption'});
    assert.ok(call.at>=at);
    const stored=f.sql(db=>db.prepare('SELECT payload_json FROM messages WHERE id = ?').get(message.body.id));
    assert.ok(!stored.payload_json.includes(bytes.toString('base64')));
    assert.equal(f.mock.calls.length,1);
  });
}

for (const [name,replies,paths,expected] of [
  ['convert true',[],['/api/sendVoice'],'sent'],
  ['4xx to native',[422,201],['/api/sendVoice','/api/sendVoice'],'sent'],
  ['two deterministic 4xx to file',[422,400,201],['/api/sendVoice','/api/sendVoice','/api/sendFile'],'sent'],
  ['file fallback rejects',[422,400,403],['/api/sendVoice','/api/sendVoice','/api/sendFile'],'failed'],
  ['timeout no fallback',['timeout'],['/api/sendVoice'],'unknown'],
  ['5xx no fallback',[503],['/api/sendVoice'],'unknown'],
  ['network no fallback',['network'],['/api/sendVoice'],'unknown'],
  ['408 no fallback',[408],['/api/sendVoice'],'unknown'],
  ['native timeout stops chain',[422,'timeout'],['/api/sendVoice','/api/sendVoice'],'unknown'],
  ['native 5xx stops chain',[422,502],['/api/sendVoice','/api/sendVoice'],'unknown']
]) {
  test(`voice ${name}`, async t => {
    const f=await fixture(t); f.mock.replies.push(...replies);
    const media=(await f.upload('voice',{name:'vocale.ogg'})).body;
    const message=await f.create('voice',{mediaId:media.id});
    assert.equal((await f.terminal(message.body.id)).status,expected);
    assert.deepEqual(f.mock.calls.map(call=>call.path),paths);
    assert.equal(f.mock.calls[0].body.convert,true);
    if (paths.length>1) assert.equal(f.mock.calls[1].body.convert,false);
    if (paths.length>2) assert.ok(!('convert' in f.mock.calls[2].body));
    assert.ok(!f.logs.includes('SECRET_ECHO'));
  });
}

test('voice followed by separate text with checkpoint durable before text request', async t => {
  const f=await fixture(t); f.mock.replies.push(201,'timeout');
  const media=(await f.upload('voice')).body;
  const message=await f.create('voice',{mediaId:media.id,followupText:'dettagli'});
  await until(()=>f.mock.calls.length===2);
  const during=f.sql(db=>db.prepare('SELECT * FROM messages WHERE id = ?').get(message.body.id));
  assert.ok(during.media_sent_at); assert.equal(during.followup_text_sent_at,null);
  assert.equal(during.delivery_step,'followup_text');
  assert.equal(f.mock.calls[1].body.text,'dettagli');
  assert.equal((await f.terminal(message.body.id)).status,'unknown');
  await f.stop(); await f.start(); await delay(350);
  assert.deepEqual(f.mock.calls.map(c=>c.path),['/api/sendVoice','/api/sendText']);
});

test('voice plus text success stores both checkpoints', async t => {
  const f=await fixture(t);
  const media=(await f.upload('voice')).body;
  const message=await f.create('voice',{mediaId:media.id,followupText:'testo'});
  const final=await f.terminal(message.body.id);
  assert.equal(final.status,'sent'); assert.ok(final.mediaSentAt); assert.ok(final.followupTextSentAt);
  assert.deepEqual(f.mock.calls.map(c=>c.path),['/api/sendVoice','/api/sendText']);
});

for (const [started,followupDone] of [[false,false],[false,true],[true,false]]) {
  test(`restart from durable voice checkpoint, followupStarted=${started}, followupDone=${followupDone}`, async t => {
    const f=await fixture(t);
    const media=(await f.upload('voice')).body;
    const message=await f.create('voice',{mediaId:media.id,followupText:'resume'}, {scheduledAt:new Date(Date.now()+DAY).toISOString()});
    await f.stop();
    // Exact persisted states at the crash boundary; no test-only production API.
    const past=new Date(Date.now()-5000).toISOString();
    f.sql(db=>db.prepare(`UPDATE messages SET status='processing',scheduled_at=?,lease_until=?,lease_token='old',
      media_sent_at=?, followup_text_sent_at=?,delivery_started_at=?,delivery_step=? WHERE id=?`)
      .run(past,past,past,followupDone?past:null,started?past:null,started?'followup_text':null,message.body.id));
    await f.start();
    const final=await f.terminal(message.body.id);
    assert.equal(final.status,started?'unknown':'sent');
    assert.deepEqual(f.mock.calls.map(c=>c.path),!started&&!followupDone?['/api/sendText']:[]);
  });
}

test('actual SIGKILL during voice, expired lease -> unknown without duplicate or fallback', async t => {
  const f=await fixture(t); f.mock.replies.push('timeout');
  const media=(await f.upload('voice')).body;
  const message=await f.create('voice',{mediaId:media.id,followupText:'never'});
  await until(()=>f.mock.calls.length===1); await f.stop();
  f.sql(db=>db.prepare('UPDATE messages SET lease_until=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),message.body.id));
  await f.start();
  assert.equal((await f.terminal(message.body.id)).status,'unknown');
  await delay(350); assert.equal(f.mock.calls.length,1);
});

test('lease fencing stops old worker from marking sent or attempting voice fallback', async t => {
  const f=await fixture(t); f.mock.replies.push('timeout');
  const media=(await f.upload('voice')).body;
  const message=await f.create('voice',{mediaId:media.id});
  await until(()=>f.mock.calls.length===1);
  f.sql(db=>db.prepare('UPDATE messages SET lease_until=? WHERE id=?').run(new Date(Date.now()-1).toISOString(),message.body.id));
  assert.equal((await f.terminal(message.body.id)).status,'unknown');
  assert.equal(f.mock.calls.length,1);
});

test('orphan/sent cleanup at 24h, failed/unknown at 7d; future pending/processing retained; cancellation releases asset', async t => {
  const f=await fixture(t), start=Date.now();
  const orphan=(await f.upload()).body;
  const items={};
  for (const status of ['pending','processing','sent','failed','unknown','cancelled']) {
    const media=(await f.upload()).body;
    const message=await f.create('file',{mediaId:media.id},{scheduledAt:new Date(start+90*DAY).toISOString()});
    if (status==='cancelled') await f.api(`/v1/messages/${message.body.id}`,{method:'DELETE'});
    else if (status!=='pending') f.sql(db=>db.prepare('UPDATE messages SET status=?,sent_at=?,updated_at=? WHERE id=?')
      .run(status,status==='sent'?new Date(start).toISOString():null,new Date(start).toISOString(),message.body.id));
    items[status]=media;
  }
  cleanupAt(f,start+DAY-1000);
  assert.equal(fs.existsSync(fileFor(f,orphan.id).storage_path),true);
  assert.equal(fs.existsSync(fileFor(f,items.sent.id).storage_path),true);
  assert.ok(fileFor(f,items.cancelled.id).deleted_at);
  cleanupAt(f,start+DAY+1000);
  for (const media of [orphan,items.sent]) { const row=fileFor(f,media.id); assert.ok(row.deleted_at); assert.equal(fs.existsSync(row.storage_path),false); }
  for (const status of ['pending','processing','failed','unknown']) assert.equal(fs.existsSync(fileFor(f,items[status].id).storage_path),true);
  cleanupAt(f,start+7*DAY-1000);
  for (const status of ['failed','unknown']) assert.equal(fs.existsSync(fileFor(f,items[status].id).storage_path),true);
  cleanupAt(f,start+7*DAY+1000);
  for (const status of ['failed','unknown']) assert.equal(fs.existsSync(fileFor(f,items[status].id).storage_path),false);
  cleanupAt(f,start+60*DAY);
  for (const status of ['pending','processing']) assert.equal(fs.existsSync(fileFor(f,items[status].id).storage_path),true);
});

test('cleanup crash recovery retries tombstones and removes stale temp/unregistered files only', async t => {
  const f=await fixture(t);
  const media=(await f.upload()).body, row=fileFor(f,media.id);
  f.sql(db=>db.prepare('UPDATE media SET deleted_at=? WHERE id=?').run(new Date().toISOString(),media.id));
  const stale=path.join(f.dir,'media',randomUUID()+'.tmp'); fs.writeFileSync(stale,'incomplete'); fs.utimesSync(stale,new Date(0),new Date(0));
  const fresh=path.join(f.dir,'media',randomUUID()); fs.writeFileSync(fresh,'fresh');
  await f.stop(); await f.start();
  assert.equal(fs.existsSync(row.storage_path),false); assert.equal(fs.existsSync(stale),false); assert.equal(fs.existsSync(fresh),true);
  const replay=await f.upload('file',{clientId:media.clientMediaId});
  assert.equal(replay.body.id,media.id); assert.ok(replay.body.deletedAt);
});

test('missing/corrupt asset fails before WAHA and never emits base64', async t => {
  const f=await fixture(t), asset=(await f.upload()).body;
  const message=await f.create('file',{mediaId:asset.id}, {scheduledAt:new Date(Date.now()+700).toISOString()});
  fs.writeFileSync(fileFor(f,asset.id).storage_path,'corrupted');
  assert.equal((await f.terminal(message.body.id)).status,'failed');
  assert.equal(f.mock.calls.length,0);
});

test('M4 missing API token fails closed before opening DB', () => {
  const { spawnSync } = require('node:child_process');
  const result=spawnSync(process.execPath,['--no-warnings',path.join(__dirname,'../app/server.js')], {
    env:{...process.env,SCHEDULER_API_TOKEN:''}, encoding:'utf8'
  });
  assert.notEqual(result.status,0); assert.match(result.stderr,/SCHEDULER_API_TOKEN_required/);
});

test('chunked multipart upload has the same envelope cap and 413 response', async t => {
  const f=await fixture(t,{MAX_MEDIA_BYTES:'8'});
  const form=new FormData();
  form.set('file',new Blob([Buffer.alloc(80000)],{type:'application/pdf'}),'large.pdf');
  form.set('kind','file'); form.set('clientMediaId',randomUUID());
  const source=new Request('http://localhost/upload',{method:'POST',body:form});
  const response=await fetch(f.base+'/v1/media',{method:'POST',headers:{'content-type':source.headers.get('content-type'),Authorization:'Bearer test-scheduler-token-1234567890'},body:source.body,duplex:'half'});
  assert.equal(response.status,413); assert.equal(fs.readdirSync(path.join(f.dir,'media')).length,0);
});

for (const [reply,status] of [[400,'failed'],[503,'unknown']]) {
  test(`voice confirmed but followup ${reply} -> ${status}, restart never resends voice`, async t => {
    const f=await fixture(t); f.mock.replies.push(201,reply);
    const media=(await f.upload('voice')).body;
    const message=await f.create('voice',{mediaId:media.id,followupText:'separate text'});
    const final=await f.terminal(message.body.id);
    assert.equal(final.status,status); assert.ok(final.mediaSentAt); assert.equal(final.followupTextSentAt,null);
    await f.stop(); await f.start(); await delay(350);
    assert.deepEqual(f.mock.calls.map(c=>c.path),['/api/sendVoice','/api/sendText']);
    assert.ok(!final.lastError.includes('SECRET_ECHO'));
  });
}

test('voice file fallback still sends separate followup text', async t => {
  const f=await fixture(t); f.mock.replies.push(422,422,201,201);
  const asset=(await f.upload('voice')).body;
  const message=await f.create('voice',{mediaId:asset.id,followupText:'after fallback'});
  assert.equal((await f.terminal(message.body.id)).status,'sent');
  assert.deepEqual(f.mock.calls.map(c=>c.path),['/api/sendVoice','/api/sendVoice','/api/sendFile','/api/sendText']);
});

test('periodic cleanup runs without HTTP calls or scheduler restarts', async t => {
  const f=await fixture(t,{CLEANUP_INTERVAL_MS:'1000'});
  const asset=(await f.upload()).body;
  f.sql(db=>db.prepare('UPDATE media SET created_at=? WHERE id=?').run(new Date(Date.now()-2*DAY).toISOString(),asset.id));
  await until(()=>fileFor(f,asset.id).deleted_at);
  assert.equal(fs.existsSync(fileFor(f,asset.id).storage_path),false);
});

test('media PATCH preserves binding and delivers the updated caption', async t => {
  const f=await fixture(t), asset=(await f.upload('image')).body;
  const message=await f.create('image',{mediaId:asset.id},{scheduledAt:new Date(Date.now()+DAY).toISOString()});
  const patch=await f.api(`/v1/messages/${message.body.id}`,{method:'PATCH',body:{scheduledAt:new Date(Date.now()-1000).toISOString(),payload:{mediaId:asset.id,caption:'updated'}}});
  assert.equal(patch.status,200);
  assert.equal((await f.terminal(message.body.id)).status,'sent');
  assert.equal(f.mock.calls[0].body.caption,'updated');
});
