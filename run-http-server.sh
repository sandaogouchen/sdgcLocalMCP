
#!/bin/bash
set -euo pipefail

PROJECT_DIR="/Users/bytedance/Documents/sdgcLocalMCP"
CONFIG_PATH="$PROJECT_DIR/config/server-config.json"
NODE_BIN="/Users/bytedance/.nvm/versions/node/v20.19.6/bin/node"
PORT="${PORT:-3001}"
HOST="${HOST:-0.0.0.0}"

get_local_ip() {
  local ip
  ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [ -z "$ip" ]; then
    ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [ -z "$ip" ]; then
    ip="$(python3 - <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(('8.8.8.8', 80))
    print(s.getsockname()[0])
finally:
    s.close()
PY
)"
  fi
  printf '%s' "$ip"
}

ADVERTISED_HOST="${ADVERTISED_HOST:-$(get_local_ip)}"

if [ -z "$ADVERTISED_HOST" ]; then
  echo "Failed to detect local IP for ADVERTISED_HOST" >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/logs"
cd "$PROJECT_DIR"

if [ ! -x "$NODE_BIN" ]; then
  echo "Node binary not found or not executable: $NODE_BIN" >&2
  exit 1
fi

exec env \
  HOST="$HOST" \
  PORT="$PORT" \
  ADVERTISED_HOST="$ADVERTISED_HOST" \
  SDGC_MCP_CONFIG="$CONFIG_PATH" \
  "$NODE_BIN" dist/src/http-server.js --config "$CONFIG_PATH"

