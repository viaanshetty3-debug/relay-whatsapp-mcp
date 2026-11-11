#!/bin/sh
# Start a temporary HTTPS MCP endpoint using an installed cloudflared binary.
set -eu
cd "$(dirname "$0")"
command -v cloudflared >/dev/null 2>&1 || { echo 'Install cloudflared first, or use your own HTTPS reverse proxy.' >&2; exit 1; }
if [ -d /data/data/com.termux/files/usr/lib ]; then
  export LD_LIBRARY_PATH=/data/data/com.termux/files/usr/lib
fi
relay_port="${PORT:-8787}"
# Refuse to tunnel another process that is already listening on this port.
PORT="$relay_port" node --input-type=module -e '
import net from "node:net";
const s=net.createServer();s.once("error",()=>{console.error("Port is already in use. Stop the running bridge, or set PORT=8789.");process.exit(1);});s.listen(Number(process.env.PORT),"127.0.0.1",()=>s.close());'
relay_log="$(mktemp)"
relay_app_pid=''
cloudflared tunnel --url "http://127.0.0.1:$relay_port" --no-autoupdate >"$relay_log" 2>&1 &
relay_tunnel_pid=$!
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$relay_app_pid" ]; then kill "$relay_app_pid" 2>/dev/null || true; fi
  kill "$relay_tunnel_pid" 2>/dev/null || true
  rm -f "$relay_log"
}
trap cleanup EXIT INT TERM
relay_url=''
relay_attempt=0
while [ "$relay_attempt" -lt 40 ]; do
  relay_url="$(sed -n 's/.*\(https:\/\/[a-z0-9-]*\.trycloudflare\.com\).*/\1/p' "$relay_log" | head -n 1)"
  if [ -n "$relay_url" ]; then break; fi
  if ! kill -0 "$relay_tunnel_pid" 2>/dev/null; then cat "$relay_log" >&2; exit 1; fi
  relay_attempt=$((relay_attempt + 1))
  sleep 1
done
if [ -z "$relay_url" ]; then echo 'Could not create a temporary tunnel.' >&2; cat "$relay_log" >&2; exit 1; fi
printf 'Temporary public MCP URL: %s/mcp\nKeep this terminal open. The URL changes each time.\n' "$relay_url"
PUBLIC_URL="$relay_url" PORT="$relay_port" node src/main.js "$@" &
relay_app_pid=$!
wait "$relay_app_pid"
