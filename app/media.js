const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const DAY = 86400000;
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const hash = data => createHash('sha256').update(data).digest('hex');

function serializeMedia(row) {
  return {
    id: row.id, clientMediaId: row.client_media_id, kind: row.kind,
    originalFilename: row.original_filename, mimeType: row.mime_type,
    sizeBytes: row.size_bytes, sha256: row.sha256, createdAt: row.created_at,
    boundMessageId: row.bound_message_id, deletedAt: row.deleted_at
  };
}

function sanitizeFilename(name) {
  const cleaned = String(name).replace(/\\/g, '/').split('/').pop()
    .normalize('NFC').replace(/[\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^\.+/, '').replace(/[. ]+$/, '');
  return [...(cleaned || 'attachment')].slice(0, 160).join('');
}

function parseMimeType(value) {
  const mime = String(value || 'application/octet-stream').trim();
  if (!mime || mime.length > 200 || /[\x00-\x1f\x7f]/.test(mime)) throw error('invalid_mime_type');
  const [rawBase, ...rawParams] = mime.split(';');
  const base = rawBase.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(base)) throw error('invalid_mime_type');
  for (const raw of rawParams) {
    const parameter = raw.trim();
    if (!parameter || !/^[a-z0-9!#$&^_.+-]+\s*=\s*(?:[a-z0-9!#$&^_.+\-]+|"[^"\r\n]*")$/i.test(parameter)) {
      throw error('invalid_mime_type');
    }
  }
  return { mime, base };
}

// Bound the entire multipart envelope as well as the actual file. Native Node
// multipart parsing avoids hand-written boundary parsing and extra dependencies.
async function readMultipart(req, maxBytes) {
  const type = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data\s*;/i.test(type)) throw error('multipart_form_data_required', 415);
  const cap = maxBytes + 65536;
  if (Number(req.headers['content-length']) > cap) { req.resume(); throw error('media_too_large', 413); }
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', chunk => {
      size += chunk.length;
      if (size > cap) { chunks.length = 0; reject(error('media_too_large', 413)); }
      else chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('aborted', () => reject(error('upload_aborted')));
    req.on('error', () => reject(error('upload_transport_error')));
  });
  try {
    return await new Request('http://localhost/upload', {
      method: 'POST', headers: { 'content-type': type }, body: Buffer.concat(chunks)
    }).formData();
  } catch { throw error('invalid_multipart'); }
}

class MediaStore {
  constructor(db, root, maxBytes, now = () => Date.now()) {
    this.db = db; this.root = path.resolve(root); this.maxBytes = maxBytes; this.now = now;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  get(id) { return this.db.prepare('SELECT * FROM media WHERE id = ?').get(id); }
  async upload(req) {
    const form = await readMultipart(req, this.maxBytes);
    if ([...form.keys()].some(key => !['file', 'clientMediaId', 'kind'].includes(key)) ||
        ['file','clientMediaId','kind'].some(key => form.getAll(key).length !== 1)) throw error('invalid_upload_fields');
    const file = form.get('file'), clientId = form.get('clientMediaId'), kind = form.get('kind');
    if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 200) throw error('invalid_clientMediaId');
    if (!['image', 'file', 'voice'].includes(kind)) throw error('invalid_media_kind');
    if (!file || typeof file.arrayBuffer !== 'function') throw error('file_required');
    if (file.size > this.maxBytes) throw error('media_too_large', 413);
    if (!file.size) throw error('empty_file');
    const { mime, base: mimeBase } = parseMimeType(file.type || 'application/octet-stream');
    if (kind === 'image' && !mimeBase.startsWith('image/')) throw error('image_mime_required');
    if (kind === 'voice' && !mimeBase.startsWith('audio/') && mimeBase !== 'application/ogg') throw error('voice_mime_required');
    const bytes = Buffer.from(await file.arrayBuffer());
    const digest = hash(bytes);
    const originalFilename = sanitizeFilename(file.name);
    const id = randomUUID(), target = path.join(this.root, id), temp = target + '.tmp';
    // All filesystem finalization + metadata registration is synchronous while
    // holding SQLite's writer lock. Concurrent replays cannot create duplicates.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM media WHERE client_media_id = ?').get(clientId.trim());
      if (existing) {
        const sameRequest = existing.kind === kind && existing.original_filename === originalFilename &&
          existing.mime_type === mime && existing.size_bytes === bytes.length && existing.sha256 === digest;
        this.db.exec('COMMIT');
        if (!sameRequest) throw error('clientMediaId_conflict', 409);
        return { status: 200, body: { ...serializeMedia(existing), idempotentReplay: true } };
      }
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, target);
      this.syncDirectory();
      this.db.prepare(`INSERT INTO media
        (id,client_media_id,kind,original_filename,mime_type,size_bytes,sha256,storage_path,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, clientId.trim(), kind, originalFilename, mime,
          bytes.length, digest, target, new Date(this.now()).toISOString());
      this.db.exec('COMMIT');
      return { status: 201, body: serializeMedia(this.get(id)) };
    } catch (failure) {
      try { this.db.exec('ROLLBACK'); } catch {}
      for (const name of [temp, target]) { try { fs.unlinkSync(name); } catch {} }
      throw failure;
    }
  }
  syncDirectory() {
    const fd = fs.openSync(this.root, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  requireBindable(id, kind, messageId = null) {
    const media = this.get(id);
    if (!media || media.deleted_at || !fs.existsSync(media.storage_path)) throw error('media_not_found_or_deleted', 400);
    if (media.kind !== kind) throw error('media_kind_mismatch');
    if (media.bound_message_id && media.bound_message_id !== messageId) throw error('media_already_bound', 409);
    return media;
  }
  readForDelivery(id) {
    const media = this.get(id);
    if (!media || media.deleted_at || path.dirname(media.storage_path) !== this.root) throw error('media_unavailable');
    const bytes = fs.readFileSync(media.storage_path);
    if (bytes.length !== media.size_bytes || hash(bytes) !== media.sha256) throw error('media_integrity_check_failed');
    return { mimetype: media.mime_type, filename: media.original_filename, data: bytes.toString('base64') };
  }
  cleanup() {
    const now = new Date(this.now()).toISOString();
    const dayAgo = new Date(this.now() - DAY).toISOString();
    const weekAgo = new Date(this.now() - 7 * DAY).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // bound_message_id intentionally remains a tombstone after DELETE message.
      // Never age pending/processing assets by upload date or scheduled date.
      this.db.prepare(`UPDATE media SET deleted_at = ? WHERE deleted_at IS NULL AND (
        (bound_message_id IS NULL AND created_at <= ?) OR
        (bound_message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages WHERE id = bound_message_id)) OR
        EXISTS (SELECT 1 FROM messages m WHERE m.id = bound_message_id AND
          ((m.status = 'sent' AND m.sent_at <= ?) OR
           (m.status IN ('failed','unknown') AND m.updated_at <= ?))))`).run(now, dayAgo, dayAgo, weekAgo);
      this.db.exec('COMMIT');
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
    // Tombstone first, unlink second. Restart retries incomplete unlinks; binding
    // sees the tombstone under the same DB lock and cannot race with cleanup.
    for (const media of this.db.prepare('SELECT storage_path FROM media WHERE deleted_at IS NOT NULL').all()) {
      if (path.dirname(media.storage_path) !== this.root) continue;
      try { fs.unlinkSync(media.storage_path); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    }
    const known = new Set(this.db.prepare('SELECT storage_path FROM media').all().map(row => row.storage_path));
    for (const name of fs.readdirSync(this.root)) {
      if (!/^[0-9a-f-]{36}(\.tmp)?$/.test(name)) continue;
      const filename = path.join(this.root, name);
      if (!known.has(filename) && fs.statSync(filename).mtimeMs <= this.now() - DAY) fs.unlinkSync(filename);
    }
    this.syncDirectory();
  }
}
module.exports = { MediaStore, serializeMedia, sanitizeFilename, parseMimeType };
