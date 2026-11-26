#!/usr/bin/env bash
# Restore drill: snapshot a DB, restore it to a temp path, boot the server on the
# restored DB, and verify /health + /metrics. Proves a backup is actually usable.
#
#   scripts/restore-drill.sh [path/to/agentmesh.db]
#
# If the given DB is missing, a fresh migrated DB is used (so the drill can run
# on a clean checkout). Prints "RESTORE DRILL PASS" on success, non-zero on fail.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SRC_DB="${1:-data/agentmesh.db}"
PORT="${DRILL_PORT:-18899}"
WORK="$(mktemp -d)"
PID=""
cleanup() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  sleep 0.3 2>/dev/null || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

# 1) Produce a backup (of the real DB if it exists, else a fresh migrated one).
if [ -f "$SRC_DB" ]; then
  node apps/server/dist/cli/backup.js --db "$SRC_DB" --out "$WORK/backup.db" >/dev/null
else
  node apps/server/dist/cli/migrate.js --db "$WORK/backup.db" >/dev/null
fi

# 2) "Restore" = copy the backup to the drill database path.
cp "$WORK/backup.db" "$WORK/restored.db"

# 3) Boot the server on the restored DB.
JWT_SECRET="${JWT_SECRET:-0123456789abcdef0123456789abcdef}" \
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://localhost}" \
HOST=127.0.0.1 PORT="$PORT" NODE_ENV=production LOG_LEVEL=error \
DB_PATH="$WORK/restored.db" \
  node apps/server/dist/index.js >"$WORK/server.log" 2>&1 &
PID=$!

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break || sleep 1
done
if ! curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "restore drill FAILED: /health not reachable" >&2
  cat "$WORK/server.log" >&2
  exit 1
fi

# /health.hashChain must be ok and /metrics must expose the workspace gauge.
curl -fsS "http://127.0.0.1:$PORT/health" | grep -q '"hashChain":"ok"'
curl -fsS "http://127.0.0.1:$PORT/metrics" | grep -q 'agentmesh_workspaces_total'

echo "RESTORE DRILL PASS: health ok (hashChain ok), metrics ok, restored DB booted"
