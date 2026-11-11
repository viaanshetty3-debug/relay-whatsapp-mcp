#!/bin/sh
set -eu
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  exec gosu node "$@"
fi
exec "$@"
