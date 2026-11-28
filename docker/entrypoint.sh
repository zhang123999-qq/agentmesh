#!/bin/sh
# Load JWT_SECRET from a mounted Docker secret (never baked into the image).
#
# The entrypoint starts as root so it can read the secret file (created
# mode 600 by the bootstrap), then drops to the unprivileged `app` user
# before starting the server. Docker Compose file secrets keep the host
# file's ownership and permissions, so the server process itself must never
# be the one to read the secret file.
set -eu

if [ -n "${JWT_SECRET_FILE:-}" ]; then
  if [ ! -f "$JWT_SECRET_FILE" ]; then
    echo "JWT_SECRET_FILE is set but the file does not exist: $JWT_SECRET_FILE" >&2
    exit 1
  fi
  JWT_SECRET="$(cat "$JWT_SECRET_FILE")"
  export JWT_SECRET
fi

if [ "$(id -u)" = "0" ]; then
  exec runuser -u app -g app -- "$@"
fi

exec "$@"
