#!/bin/sh
# Create a consistent SQLite backup inside the server container.
set -eu

DB_PATH="${DB_PATH:-/app/data/agentmesh.db}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${1:-/app/data/backups/agentmesh-${STAMP}.db}"

mkdir -p "$(dirname "$OUT")"
node /app/apps/server/dist/cli/backup.js --db "$DB_PATH" --out "$OUT"
