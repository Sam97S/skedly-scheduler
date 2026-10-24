
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
