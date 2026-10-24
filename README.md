# skedly scheduler — media candidate on top of M4

Server-side, persistent, one-shot scheduling for a single chat per message.
Text, image, file and voice delivery use WAHA. Upload media **when scheduling**;
Android is not needed at delivery time. This repository change does not deploy
anything to a VPS and does not change Android, Traefik or the existing volume.

## Compatibility and configuration

M4 behavior remains: SQLite WAL, server worker, unique `clientMessageId`, atomic
claims, fenced leases, `pending / processing / sent / failed / unknown`, mandatory
Bearer auth, public `GET /health`, protected `/status` and `/v1/*`.
`/health` continues returning `apiAuthConfigured: true` when configured.

| Environment | Default / requirement |
| --- | --- |
| `SCHEDULER_API_TOKEN` | Required; startup fails closed if missing |
| `DELIVERY_MODE` | `local` (dry run) or `waha` for real delivery |
| `WAHA_BASE_URL` | `http://waha:3000` |
| `WAHA_API_KEY` | Required in WAHA mode |
| `WAHA_TIMEOUT_MS` | `15000`, minimum `1000` |
| `DB_PATH` | `/data/skedly-scheduler.db` |
| `MEDIA_DIR` | `/data/media` (override for tests only in normal use) |
| `MAX_MEDIA_BYTES` | `26214400` = 25 MiB per file; overflow returns HTTP 413 |
| `CLEANUP_INTERVAL_MS` | `3600000`; cleanup also runs at startup |
| `WORKER_INTERVAL_MS` | `1000`, minimum `250` |
| `LEASE_MS` | `30000`, minimum `5000` |
| `PORT` | `8080` |

Keep the existing persistent volume mounted at `/data`. The checked-in Compose
configuration remains unchanged and still references the existing `latest` tag.
Do not change production to this candidate until separately validated.

## Upload API

`POST /v1/media`, `Authorization: Bearer <SCHEDULER_API_TOKEN>`,
`Content-Type: multipart/form-data`.
Exactly one of each multipart field is required:

| Field | Value |
| --- | --- |
| `file` | Nonempty binary file; original name and MIME supplied by multipart |
| `clientMediaId` | Stable client-generated idempotency key, maximum 200 characters |
| `kind` | `image`, `file` or `voice` |

Image requires `image/*`. Voice requires `audio/*` or `application/ogg`.
Other files can use any valid MIME or `application/octet-stream`.
The bounded multipart parser allows 64 KiB envelope overhead in addition to the
file limit, also for chunked uploads. Parsing buffers at most this envelope per
request, so size concurrency to available memory. There are no npm dependencies.

Successful upload returns HTTP 201:

```json
{
  "id": "server-uuid",
  "clientMediaId": "client-stable-uuid",
  "kind": "file",
  "originalFilename": "preventivo.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 12345,
  "sha256": "hex-sha256",
  "createdAt": "2026-10-24T18:00:00.000Z",
  "boundMessageId": null,
  "deletedAt": null
}
```

A replay returns HTTP 200, the same persisted asset and `idempotentReplay: true`,
including across restarts and concurrent uploads. Replaying a cleaned-up asset
returns its tombstone, not a new file; upload with a new client key to replace it.
Storage paths are internal and never derived from client filenames.

Each successful upload writes a UUID `.tmp` file with private permissions, fsyncs,
renames atomically, fsyncs the directory, and commits metadata. SHA-256 is computed
from the uploaded bytes and rechecked before sending. A crash before metadata
commit may leave an unregistered file; the sweeper removes it after 24 hours.
File bytes and Base64 are never stored in SQLite or logged. WAHA error bodies,
Authorization and API keys are never logged or persisted as error details.

## Schedule and manage messages

`POST /v1/messages` retains the M4 envelope:

```json
{
  "clientMessageId": "stable-message-key",
  "session": "default",
  "chatId": "393331234567@c.us",
  "type": "file",
  "payload": {"mediaId": "server-uuid", "caption": "Il preventivo"},
  "scheduledAt": "2026-11-10T09:00:00+01:00",
  "timezone": "Europe/Rome"
}
```

| `type` | `payload` |
| --- | --- |
| `text` | `{"text":"Messaggio"}` |
| `image` | `{"mediaId":"uuid","caption":"optional"}` |
| `file` | `{"mediaId":"uuid","caption":"optional"}` |
| `voice` | `{"mediaId":"uuid","followupText":"optional separate text"}` |

`scheduledAt` is converted to UTC and never delivered early. Timezone is retained
as metadata; this is one-shot scheduling, not recurrence. Each asset belongs to
at most one scheduled message. Asset validation, message insertion and binding
are one SQLite transaction. Missing, deleted or incompatible assets return 400;
already-bound assets return 409. Message idempotent replay returns the existing
message before attempting a new binding.

Existing endpoints remain:

- `GET /v1/messages`, optionally `?status=pending&limit=100&offset=0`
- `GET /v1/messages/:id`
- `PATCH /v1/messages/:id` for pending messages, including payload and schedule
- `DELETE /v1/messages/:id` for pending messages
- `GET /health` public; `GET /status` authenticated

PATCH can update image/file caption or voice followup text using the same mediaId.
It cannot rebind an asset or change type. Text PATCH retains M4 behavior.

## Delivery and crash recovery

WAHA receives `session`, `chatId` and, for media, `file` with `mimetype`, the
sanitized `filename`, and ephemeral `data` Base64 read from disk at delivery time.
Images call `/api/sendImage`; files call `/api/sendFile`; both include `caption`.

Voice calls `/api/sendVoice` with `convert: true`. Only a deterministic 4xx
rejection permits another `/api/sendVoice` with `convert: false`. A second such
4xx permits `/api/sendFile`. HTTP 408 is treated as an ambiguous timeout, never a
fallback trigger. The file fallback preserves the voice MIME and filename.

| Outcome | Action |
| --- | --- |
| 2xx | Confirm the step even if the optional response body is unreadable |
| Deterministic 4xx | Failed, except the two explicit voice fallbacks |
| 5xx, 408, unexpected redirect, timeout or network error | Unknown; no automatic retry or fallback |
| Expired lease with potentially started delivery | Unknown; no retry |

Voice plus text is two separate WAHA messages. The database commits
`media_sent_at` **before** initiating followup text; it commits
`followup_text_sent_at` after the text's 2xx. Both are exposed in the message API
as `mediaSentAt` and `followupTextSentAt`. A durable step marker is written before
each outbound operation. Checkpoints clear that marker atomically.

After a crash, an expired processing voice with confirmed media and no started
step can be reclaimed: only the unconfirmed followup is sent. If both checkpoints
exist it is finalized without a network call. If any step might have started,
recovery sets `unknown`. A voice confirmed before ambiguous followup is never
resent. Each claim has a unique lease token; stale workers cannot write checkpoints
or start fallback operations. Before each HTTP call the lease is extended to cover
at least the timeout plus 5 seconds. A crash after WAHA accepts but before the
checkpoint commits is intentionally `unknown`, because exactly-once delivery
cannot be proven without remote idempotency.

## Incremental database migration

The production unversioned M4 `messages` table is preserved. Migration 1 runs in a
single transaction and records `schema_migrations(version, applied_at)`. No table
rebuild, database recreation or deletion is performed. SQLite uses WAL, foreign
keys, busy timeout and `synchronous=FULL`.

New `media` table (API uses camelCase aliases):

| Column | Constraint / meaning |
| --- | --- |
| `id` | UUID primary key |
| `client_media_id` | NOT NULL UNIQUE |
| `kind` | image/file/voice, checked |
| `original_filename` | Sanitized original name |
| `mime_type` | MIME retained from upload |
| `size_bytes` | Positive file size |
| `sha256` | SHA-256 hexadecimal digest |
| `storage_path` | UNIQUE absolute UUID path |
| `created_at` | UTC ISO timestamp |
| `bound_message_id` | Nullable UNIQUE; retained as a tombstone after cancellation |
| `deleted_at` | Nullable cleanup tombstone |

New message columns: `media_id` (foreign key to media, unique when not null),
`media_sent_at`, `followup_text_sent_at`, `delivery_step`, `delivery_started_at`,
`lease_token`. Existing text rows require no media association. Media's reverse
binding intentionally has no foreign key so cancellation can delete the message
while retaining its prior ownership for immediate cleanup eligibility.

## Media lifecycle

Cleanup runs hourly and at startup, with no dependence on Android.

| Asset/message | Physical file eligibility |
| --- | --- |
| Uploaded, never bound | 24 hours after upload |
| Pending / processing | Always retained, even for scheduling months ahead |
| Sent | 24 hours after sent_at |
| Failed / unknown | 7 days after terminal updated_at |
| Cancelled scheduled message | Next cleanup when no message references it |

Cleanup tombstones under SQLite's writer lock **before** unlinking. Scheduling
uses the same lock, preventing cleanup/binding races. A restart retries unfinished
unlinks; metadata and idempotency tombstones remain. Stale temporary and
unregistered UUID files are swept after 24 hours. No authenticated file-download
endpoint is exposed; WAHA receives the file directly from this worker.

## Tests and candidate publication

Run `npm test` on Node 22.13+ (production image uses Node 22 Alpine).
The suite extends the original M4 workflow's WAHA mock, now in
`test/waha-mock.js`, with image/file/voice and deterministic/ambiguous outcomes.
Tests cover auth, text CRUD and scheduling, M4 schema upgrade, SHA, upload size
boundaries, idempotency/restart, atomic binding, all voice fallback steps,
confirmed voice recovery, ambiguous followup, actual SIGKILL during delivery,
lease fencing, integrity failures, retention and periodic/crash-safe cleanup.
Crash-boundary tests seed the exact durable checkpoint states without adding
any test-only API to production.

The workflow builds one candidate image, runs the full suite **inside that exact
image**, and smoke-tests its entrypoint with a persistent `/data` Docker volume.
Only after every check succeeds does it publish:

- `ghcr.io/sam97s/skedly-scheduler:media`
- `ghcr.io/sam97s/skedly-scheduler:media-<full-commit-sha>`

The push digest is recorded in the Actions job summary and logs. Both `main` and
`milestone/media` use this candidate-only workflow. It never pushes `latest`, and
contains no VPS deployment step. The immutable digest should be used for later
validation. Real WAHA engine/codec behavior still needs a separately authorized
staging/end-to-end check before production rollout.
