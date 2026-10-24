// The unversioned M4 messages table is created by server.js before this runs.
// Never rebuild it: production rows, indexes and constraints remain in place.
function migrate(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT`);
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get()) {
      db.exec(`
        CREATE TABLE media (
          id TEXT PRIMARY KEY,
          client_media_id TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK(kind IN ('image','file','voice')),
          original_filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
          sha256 TEXT NOT NULL,
          storage_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          bound_message_id TEXT UNIQUE,
          deleted_at TEXT
        ) STRICT;
        ALTER TABLE messages ADD COLUMN media_id TEXT REFERENCES media(id);
        ALTER TABLE messages ADD COLUMN media_sent_at TEXT;
        ALTER TABLE messages ADD COLUMN followup_text_sent_at TEXT;
        ALTER TABLE messages ADD COLUMN delivery_step TEXT;
        ALTER TABLE messages ADD COLUMN delivery_started_at TEXT;
        ALTER TABLE messages ADD COLUMN lease_token TEXT;
        CREATE INDEX idx_media_cleanup ON media(deleted_at, created_at);
        CREATE UNIQUE INDEX idx_message_media ON messages(media_id) WHERE media_id IS NOT NULL;
      `);
      db.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
module.exports = { migrate };
