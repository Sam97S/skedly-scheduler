# Skedly Scheduler — deployment smoke test

Minimal first-step container for validating the deployment path:

GitHub repository → Hostinger Docker Manager → Docker container

This version intentionally does **not** include:
- WAHA integration
- SQLite
- scheduling
- Traefik labels
- authentication
- retries

## Endpoint

`GET /health`

Expected response:

```json
{
  "status": "ok",
  "service": "skedly-scheduler"
}
```

## Validation

```bash
docker compose config -q
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8080/health
docker compose logs --tail=100
```

## Success criteria

1. Compose configuration validates.
2. Container is created.
3. Container remains running.
4. Health status becomes healthy.
5. `GET /health` returns HTTP 200.
6. Container survives a restart and `/health` still works.

After this passes on Hostinger, add SQLite persistence and the actual scheduler in a separate iteration.
