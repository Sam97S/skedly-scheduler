// Persist a lease-fenced step marker BEFORE every outbound operation. Clear it
// only alongside a confirmed checkpoint. No ambiguous step is ever retried.
class Delivery {
  constructor(db, media, config) { this.db = db; this.media = media; Object.assign(this, config); }
  row(message) { return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id); }
  fencedUpdate(message, assignments, values = []) {
    const now = new Date().toISOString();
    return this.db.prepare(`UPDATE messages SET ${assignments} WHERE id = ? AND status = 'processing'
      AND lease_token = ? AND lease_until > ?`).run(...values, message.id, message.leaseToken, now).changes === 1;
  }
  beginStep(message, step) {
    const now = new Date().toISOString();
    const until = new Date(Date.now() + Math.max(this.leaseMs, this.timeoutMs + 5000)).toISOString();
    if (!this.fencedUpdate(message, 'delivery_step = ?, delivery_started_at = ?, lease_until = ?, updated_at = ?',
      [step, now, until, now])) throw new Error('delivery_lease_lost');
  }
  checkpoint(message, column, id) {
    const now = new Date().toISOString();
    if (!this.fencedUpdate(message, `${column} = ?, delivery_step = NULL, delivery_started_at = NULL,
      updated_at = ?, waha_message_id = COALESCE(?, waha_message_id)`, [now, now, id])) throw new Error('delivery_lease_lost');
  }
  async call(message, endpoint, body, step) {
    this.beginStep(message, step);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: 'POST', redirect: 'manual',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey },
        body: JSON.stringify(body), signal: controller.signal
      });
      const status = response.status;
      // Never persist WAHA response bodies: they may echo content or credentials.
      let id = null;
      if (response.ok) {
        try {
          const reader = response.body?.getReader();
          const chunks = []; let size = 0;
          if (reader) {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              size += part.value.length;
              if (size > 65536) { await reader.cancel(); break; }
              chunks.push(Buffer.from(part.value));
            }
          }
          const data = JSON.parse(Buffer.concat(chunks).toString());
          id = [data?.id, data?.key?.id, data?._data?.id, data?.message?.id]
            .find(value => typeof value === 'string' && value.trim()) || null;
        } catch { /* 2xx still confirms delivery, even without a readable body. */ }
      } else { try { await response.body?.cancel(); } catch {} }
      const current = this.row(message);
      if (current.status !== 'processing' || current.lease_token !== message.leaseToken ||
          current.lease_until <= new Date().toISOString()) return { outcome: 'unknown', error: 'delivery_lease_lost' };
      if (response.ok) return { outcome: 'sent', wahaMessageId: id, httpStatus: status };
      // HTTP 408 itself describes an ambiguous timeout, not a safe rejection.
      return { outcome: status >= 400 && status < 500 && status !== 408 ? 'failed' : 'unknown',
        error: `waha_http_${status}`, httpStatus: status };
    } catch (failure) {
      return { outcome: 'unknown', error: failure.name === 'AbortError' ? 'waha_timeout' : 'waha_transport_error', httpStatus: null };
    } finally { clearTimeout(timer); }
  }
  async execute(message) {
    const common = { session: message.session || 'default', chatId: message.chatId };
    if (message.type === 'text') return this.call(message, 'sendText', { ...common, text: message.payload.text }, 'text');
    let row = this.row(message);
    let result = { outcome: 'sent', wahaMessageId: row.waha_message_id };
    if (!row.media_sent_at) {
      let file;
      try { file = this.media.readForDelivery(message.payload.mediaId); }
      catch { return { outcome: 'failed', error: 'media_missing_or_corrupt' }; }
      const body = { ...common, file };
      if (message.type !== 'voice') body.caption = message.payload.caption || '';
      if (message.type === 'image') result = await this.call(message, 'sendImage', body, 'image');
      else if (message.type === 'file') result = await this.call(message, 'sendFile', body, 'file');
      else {
        result = await this.call(message, 'sendVoice', { ...body, convert: true }, 'voice_convert');
        if (result.outcome === 'failed') result = await this.call(message, 'sendVoice', { ...body, convert: false }, 'voice_native');
        if (result.outcome === 'failed') result = await this.call(message, 'sendFile', body, 'voice_file_fallback');
      }
      if (result.outcome !== 'sent') return result;
      this.checkpoint(message, 'media_sent_at', result.wahaMessageId);
    }
    row = this.row(message);
    if (message.type === 'voice' && message.payload.followupText && !row.followup_text_sent_at) {
      result = await this.call(message, 'sendText', { ...common, text: message.payload.followupText }, 'followup_text');
      if (result.outcome === 'sent') this.checkpoint(message, 'followup_text_sent_at', result.wahaMessageId);
    }
    return result;
  }
}
module.exports = { Delivery };
