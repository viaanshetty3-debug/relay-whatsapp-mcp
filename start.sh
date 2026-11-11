#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -d /data/data/com.termux/files/usr/lib ]; then
  export LD_LIBRARY_PATH=/data/data/com.termux/files/usr/lib
fi
relay_node="${NODE_BINARY:-}"
if [ -z "$relay_node" ]; then relay_node="$(command -v node || true)"; fi
if [ -z "$relay_node" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then relay_node="$candidate"; fi
  done
fi
if [ -z "$relay_node" ] || [ ! -x "$relay_node" ]; then
  echo 'Node.js 22.13 or newer is required. No working Node executable was found.' >&2
  exit 1
fi
exec "$relay_node" src/main.js "$@"
