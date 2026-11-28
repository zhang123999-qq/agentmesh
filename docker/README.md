# AgentMesh Docker deployment

M9 exit condition: `docker compose up` → `/health` returns 200 and SIGTERM shuts
the server down gracefully.

## Decisions

- **Migrations:** the server still migrates automatically on startup
  (`openStore`). `npm run migrate -w @agentmesh/server -- --db <path>` is a
  separate, idempotent entrypoint for production runbooks. Both are safe to run.
- **JWT secret:** mounted as a Docker secret at `/run/secrets/jwt_secret`. The
  entrypoint starts as root only to read the file (created mode 600), exports
  it as `JWT_SECRET`, then drops to the unprivileged `app` user with `runuser`
  before starting the server — Compose file secrets keep the host file's
  ownership and permissions, so the server process itself must never read the
  file. CLI commands run with `docker compose exec` read the same file through
  `JWT_SECRET_FILE` (config fallback; explicit `JWT_SECRET` wins). The secret
  never enters the image, `compose.yaml`, or logs. Production requires ≥32
  bytes; weak values fail fast.
- **TLS:** **Caddy** terminates TLS. Local/default uses `tls internal`; for
  production set `DOMAIN` and `CADDY_TLS_DIRECTIVE=` (empty) so Caddy obtains a
  public certificate. `ALLOWED_ORIGINS` must list the exact `https://DOMAIN`.
- **Data/backup:** named volume `agentmesh_data` mounted at `/app/data`, mode
  `700`, owned by the non-root `app` user. `agentmesh-backup` uses
  better-sqlite3's online backup API (includes committed WAL).
- **First admin:** run the existing local-only `seed-admin` CLI inside the
  container. It is never exposed over HTTP/WS.

## Bootstrap

```bash
mkdir -p docker/secrets
# 48 random bytes, base64 (≥32 bytes after decoding)
openssl rand -base64 48 > docker/secrets/jwt_secret.txt
chmod 600 docker/secrets/jwt_secret.txt

# Local/default: Caddy uses an internal CA on https://localhost:8443
ALLOWED_ORIGINS=https://localhost \
  docker compose -f docker/compose.yaml up -d --build

# Health (server container + through Caddy)
curl -f http://127.0.0.1:8443/health -k   # Caddy is HTTPS; -k for the internal CA
```

Create the first admin (prints the secret once):

```bash
docker compose -f docker/compose.yaml exec server \
  node apps/server/dist/cli/seed-admin.js --name admin --owner ops
```

Do **not** set `ALLOW_ADMIN_SELF_REGISTER`; compose intentionally omits it.

## Migrations

Automatic: every server start calls `openStore` → `runMigrations`.

Explicit (idempotent):

```bash
docker compose -f docker/compose.yaml exec server \
  node apps/server/dist/cli/migrate.js --db /app/data/agentmesh.db
```

v8 (`tasks.completed_at`) is safe on an existing v8 database: the CLI reports
`applied: []` on the second run.

## Backup / restore

Backup inside the running container (consistent, WAL included):

```bash
docker compose -f docker/compose.yaml exec server \
  /usr/local/bin/agentmesh-backup
# or choose the destination:
docker compose -f docker/compose.yaml exec server \
  /usr/local/bin/agentmesh-backup /app/data/backups/manual.db
```

Restore:

1. `docker compose stop server`
2. copy the backup over `/app/data/agentmesh.db` (remove `-wal`/`-shm` first)
3. `docker compose start server`

Run a restore drill in a non-production compose project before relying on it.

## Production TLS

```bash
DOMAIN=app.example.com \
CADDY_TLS_DIRECTIVE= \
ALLOWED_ORIGINS=https://app.example.com \
HTTPS_PORT=443 HTTP_PORT=80 \
  docker compose -f docker/compose.yaml up -d --build
```

Caddy obtains/renews the certificate; the Node container never terminates TLS
and still listens on plain HTTP `:8787` internally.

## Graceful shutdown

`docker compose stop -t 20` sends SIGTERM. Fastify's `preClose` closes
WebSockets, the reclaim interval is cleared, and the owned SQLite handle is
closed. `stop_grace_period: 20s` gives the process time to finish.

## Local verification without Docker

`node docker/verify-local.mjs` builds and runs the server on an ephemeral port,
checks `/health`, runs the migrate CLI twice, runs the backup CLI, and exits
non-zero on failure. (The Docker engine is not available in every dev
environment; this script verifies the same server behavior without it.)
