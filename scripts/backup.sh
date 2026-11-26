#!/usr/bin/env bash
# Timestamped, integrity-checked backup with retention. Intended for cron.
#
#   DB_PATH=data/agentmesh.db BACKUP_DIR=backups BACKUP_KEEP=7 scripts/backup.sh
#
# The backup CLI verifies PRAGMA integrity_check on the produced file and exits
# non-zero on failure, so a failed/partial snapshot never counts as success.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB_PATH="${DB_PATH:-data/agentmesh.db}"
BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP="${BACKUP_KEEP:-7}"

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/agentmesh-$TS.db"

node apps/server/dist/cli/backup.js --db "$DB_PATH" --out "$OUT"

# Retention: keep the newest $KEEP backups, prune older ones.
if [ "$KEEP" -gt 0 ]; then
  ls -1t "$BACKUP_DIR"/agentmesh-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old"
  done
fi

echo "backup ok: $OUT (kept $KEEP)"
