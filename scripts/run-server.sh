#!/bin/bash
set -euo pipefail

REPO_DIR="/Users/bytedance/Documents/sdgcLocalMCP"
NODE_BIN="/Users/bytedance/.nvm/versions/node/v20.19.6/bin/node"
CONFIG_PATH="$REPO_DIR/config/server-config.json"

cd "$REPO_DIR"
exec "$NODE_BIN" "$REPO_DIR/dist/src/index.js" --config "$CONFIG_PATH"
