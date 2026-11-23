#!/usr/bin/env bash
# US-021G / M9-shared: bring up a real local stack and run the Playwright e2e.
# Uses OS-assigned free ports (the hosted runner occupies common fixed ports).
set -euo pipefail

free_port() {
  node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});"
}

SERVER_PORT="$(free_port)"
WEB_PORT="$(free_port)"
echo "e2e: server=$SERVER_PORT web=$WEB_PORT"

export NODE_ENV=production
export DB_PATH="$(mktemp -d)/agentmesh-ci.db"
export JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export ALLOWED_ORIGINS="http://localhost:${WEB_PORT}"
export HOST=127.0.0.1
export PORT="${SERVER_PORT}"
export LOG_LEVEL=info

echo "quick check: is ${SERVER_PORT} free? -> $(ss -ltn 2>/dev/null | grep -c ":${SERVER_PORT}" || true) listener(s)"

# Build with the chosen WS URL baked into the web bundle.
NEXT_PUBLIC_WS_URL="ws://localhost:${SERVER_PORT}/ws" npm run build

node apps/server/dist/cli/migrate.js --db "$DB_PATH" >/dev/null
SEED="$(node apps/server/dist/cli/seed-admin.js --name admin --owner ci)"
echo "$SEED"
ADMIN_AGENT_ID="$(printf '%s\n' "$SEED" | sed -n 's/^admin created: agentId=\([^ ]*\) name=.*/\1/p')"
ADMIN_SECRET="$(printf '%s\n' "$SEED" | sed -n 's/^secret: \(.*\)$/\1/p')"
test -n "$ADMIN_AGENT_ID"
test -n "$ADMIN_SECRET"

SERVER_LOG="$(mktemp)"; WEB_LOG="$(mktemp)"
node apps/server/dist/index.js >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
nohup npm run start -w @agentmesh/web -- -p "$WEB_PORT" >"$WEB_LOG" 2>&1 &
WEB_PID=$!
trap 'kill "$SERVER_PID" "$WEB_PID" 2>/dev/null || true' EXIT

wait_url() {
  for _ in $(seq 1 90); do
    curl -fsS "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "timed out waiting for $1" >&2
  return 1
}

sleep 2
echo "--- server.log ---"; cat "$SERVER_LOG" || true
echo "--- web.log ---"; cat "$WEB_LOG" || true
echo "listening on server port: $(ss -ltn 2>/dev/null | grep -c ":${SERVER_PORT}" || true)"

if ! wait_url "http://127.0.0.1:${SERVER_PORT}/health"; then
  echo "--- server.log (final) ---" >&2; cat "$SERVER_LOG" >&2 || true
  exit 1
fi
if ! wait_url "http://localhost:${WEB_PORT}/login"; then
  echo "--- web.log (final) ---" >&2; cat "$WEB_LOG" >&2 || true
  exit 1
fi

BASE_URL="http://localhost:${WEB_PORT}" \
ADMIN_AGENT_ID="$ADMIN_AGENT_ID" ADMIN_SECRET="$ADMIN_SECRET" \
  npx playwright test --config apps/web/e2e/playwright.config.ts
