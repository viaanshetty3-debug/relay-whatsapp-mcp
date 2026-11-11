#!/data/data/com.termux/files/usr/bin/sh
# Keeps the WhatsApp bridge and the HTTPS relay agent running on this phone.
# Restarts either one if it exits. Running it twice is harmless.
# Stop everything with:  sh ~/whatsapp-bridge/phone-relay.sh stop
cd "$(dirname "$0")" || exit 1
umask 077
PIDFILE=data/phone-relay.pid

if [ "${1:-}" = "stop" ]; then
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill -TERM -- "-$(cat "$PIDFILE")" 2>/dev/null || kill -TERM "$(cat "$PIDFILE")"
    echo "Relay stopped."
  else
    echo "Relay is not running."
  fi
  rm -f "$PIDFILE"
  exit 0
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Relay is already running."; exit 0
fi
if pgrep -f 'node src/main.js' >/dev/null; then
  echo "A bridge is already running outside this script. Stop it first."; exit 1
fi

# Re-run in our own process group so "stop" can end every child at once.
if [ -z "${RELAY_SUPERVISED:-}" ] && command -v setsid >/dev/null; then
  RELAY_SUPERVISED=1 exec setsid sh "$0" "$@"
fi

echo $$ > "$PIDFILE"
timeout 10 termux-wake-lock 2>/dev/null || true
export AUTO_CONNECT=true

( while true; do
    sh ./start.sh >> data/server.log 2>&1
    echo "$(date) bridge exited ($?); restarting in 10s" >> data/server.log
    sleep 10
  done ) &
sleep 10
( while true; do
    sh ./start-remote.sh >> data/remote-agent.log 2>&1
    echo "$(date) relay agent exited ($?); restarting in 10s" >> data/remote-agent.log
    sleep 10
  done ) &
wait
