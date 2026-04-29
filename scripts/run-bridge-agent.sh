#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="${CONFIG_PATH:-$REPO_DIR/config/server-config.json}"
NODE_BIN="${NODE_BIN:-node}"
BUILD_BEFORE_START="${BUILD_BEFORE_START:-1}"
TMP_CONFIG="$(mktemp "${TMPDIR:-/tmp}/sdgc-bridge-agent.XXXXXX.json")"

cleanup() {
  rm -f "$TMP_CONFIG"
}
trap cleanup EXIT

if [ ! -f "$CONFIG_PATH" ]; then
  echo "Config file not found: $CONFIG_PATH" >&2
  exit 1
fi

mkdir -p "$REPO_DIR/logs"

python3 - "$CONFIG_PATH" "$TMP_CONFIG" <<'PY'
import json
import os
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
with open(src_path, "r", encoding="utf-8") as f:
    config = json.load(f)

local_agent = config.setdefault("localAgent", {})
local_agent["enabled"] = True
config["bridge"] = {"enabled": False}

overrides = {
    "serverUrl": os.environ.get("BRIDGE_SERVER_URL"),
    "agentId": os.environ.get("AGENT_ID"),
    "secret": os.environ.get("AGENT_SECRET"),
}
for key, value in overrides.items():
    if value:
        local_agent[key] = value

working_directory = os.environ.get("AGENT_WORKDIR")
if working_directory:
    config["workingDirectory"] = working_directory
    config["allowedPaths"] = [working_directory, "/tmp", "/var/tmp"]
    local_agent.setdefault("policy", {})["workingDirectory"] = working_directory
    if config.get("auditLogPath"):
        config["auditLogPath"] = os.path.join(working_directory, "logs", "audit.log")

server_url = local_agent.get("serverUrl", "")
if not server_url:
    raise SystemExit("localAgent.serverUrl is empty; set it in config or via BRIDGE_SERVER_URL")

with open(dst_path, "w", encoding="utf-8") as f:
    json.dump(config, f, ensure_ascii=False, indent=2)
PY

if [ "$BUILD_BEFORE_START" = "1" ]; then
  npm --prefix "$REPO_DIR" run build
fi

echo "Starting local bridge agent"
echo "- config: $CONFIG_PATH"
echo "- effective server url: ${BRIDGE_SERVER_URL:-$(python3 - "$TMP_CONFIG" <<'PY'
import json
import sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    print(json.load(f)['localAgent']['serverUrl'])
PY
)}"

exec "$NODE_BIN" "$REPO_DIR/dist/src/bridge/agent-main.js" --config "$TMP_CONFIG"
