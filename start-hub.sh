#!/bin/bash
# Start the Telegram hub in the background
# Usage: ./start-hub.sh

export PATH="$HOME/.bun/bin:$PATH"

# Kill existing hub if running
if [ -f "$HOME/.claude-telegram-hub.pid" ]; then
  PID=$(awk '{print $1}' "$HOME/.claude-telegram-hub.pid")
  kill "$PID" 2>/dev/null
  rm -f "$HOME/.claude-telegram-hub.pid"
  sleep 1
fi

# Source env vars
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
export TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID}"
export ALLOWED_USER_IDS="${ALLOWED_USER_IDS}"
export HUB_PORT="${HUB_PORT:-4100}"
export HUB_HOST="${HUB_HOST:-127.0.0.1}"
export HUB_IDLE_TIMEOUT="${HUB_IDLE_TIMEOUT:-0}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

nohup bun run "$SCRIPT_DIR/src/hub/hub.ts" > /tmp/claude-telegram-hub.log 2>&1 &
echo "Hub started (PID: $!), logs at /tmp/claude-telegram-hub.log"
