#!/bin/sh
# Load JWT_SECRET from a mounted Docker secret (never baked into the image).
set -eu

if [ -n "${JWT_SECRET_FILE:-}" ]; then
  if [ ! -f "$JWT_SECRET_FILE" ]; then
    echo "JWT_SECRET_FILE is set but the file does not exist: $JWT_SECRET_FILE" >&2
    exit 1
  fi
  JWT_SECRET="$(cat "$JWT_SECRET_FILE")"
  export JWT_SECRET
fi

exec "$@"
