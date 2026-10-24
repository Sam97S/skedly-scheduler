# Skedly Scheduler — Milestone 2

This version adds a persistent local scheduler, still without WAHA integration.

## Included

- SQLite persistence at `/data/skedly-scheduler.db`
- `POST /v1/messages`
- `GET /v1/messages`
- `GET /v1/messages/:id`
- `PATCH /v1/messages/:id`
- `DELETE /v1/messages/:id`
- `GET /health`
- `GET /status`
- background worker
- atomic claim using SQLite transaction
- lease recovery
- `clientMessageId` UNIQUE
- local dry-run execution:
  `pending → processing → sent`

## Important

This milestone intentionally does **not** call WAHA yet.

When a due message is executed, the worker logs it and marks it `sent` locally. This proves that persistence and timed execution work before adding WhatsApp.

## Example message

```json
{
  "clientMessageId": "test-123",
  "session": "default",
  "chatId": "393331234567@c.us",
  "type": "text",
  "payload": {
    "text": "Test Skedly"
  },
  "scheduledAt": "2026-10-24T15:30:00Z",
  "timezone": "Europe/Rome"
}
```
