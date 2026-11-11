#!/bin/sh
set -eu
cd "$(dirname "$0")"
relay_node="${NODE_BINARY:-}"
if [ -z "$relay_node" ]; then relay_node="$(command -v node || true)"; fi
if [ -z "$relay_node" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then relay_node="$candidate"; fi
  done
fi
if [ -z "$relay_node" ] || [ ! -x "$relay_node" ]; then
  echo 'Node.js is required to run the private Relay connection.' >&2
  exit 1
fi
exec "$relay_node" src/remote-agent.js
