# teleclaude

Control Claude Code from Telegram. Send messages from your phone, get full Claude Code responses with tool access. Supports multiple concurrent project sessions across machines.

## How It Works

A hub process runs a Telegram bot. When you send a message, it spawns `claude -p` (the official Claude Code CLI) to process it and sends the response back to Telegram. Each conversation maintains context via `--resume`.

For remote machines, a lightweight relay accepts prompts over TCP and runs `claude -p` locally.

## Quick Start

### 1. Create a Telegram Bot

Message [@BotFather](https://t.me/BotFather) → `/newbot` → save the token.

### 2. Find Your Chat ID

Message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric ID.

### 3. Set Up the Hub

Create env file at `~/.config/claude-telegram-hub.env`:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-user-id
ALLOWED_USER_IDS=your-user-id
AUTO_APPROVE=true
SERVER_NAME=claude
PROJECTS_DIR=/home/youruser/projects
CLAUDE_CWD=/home/youruser
```

### 4. Run as a systemd service

```bash
# Create service file
cat > ~/.config/systemd/user/claude-telegram-hub.service << 'EOF'
[Unit]
Description=Claude Telegram Hub
After=network.target

[Service]
Type=simple
Environment=PATH=/home/youruser/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/youruser
EnvironmentFile=/home/youruser/.config/claude-telegram-hub.env
ExecStart=/home/youruser/.bun/bin/bun run /path/to/src/hub/hub.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

# Enable and start
systemctl --user daemon-reload
systemctl --user enable claude-telegram-hub
systemctl --user start claude-telegram-hub
```

### 5. Message your bot

Send any message to your Telegram bot. Claude will respond.

## Multi-Session

Set `PROJECTS_DIR` to a directory containing project folders. Each subfolder becomes a session, auto-registered as a Telegram `/` command with autocomplete.

```
PROJECTS_DIR=/home/youruser/projects
```

If the directory contains `web-deploy/`, `api-server/`, and `docs/`, you get:
- `/web_deploy` — switch to web-deploy project
- `/api_server` — switch to api-server project
- `/docs` — switch to docs project

### Usage

**Tap a `/command`** from Telegram's autocomplete to switch to that session. Then just type messages normally — they go to that session until you switch.

**Or inline:** `/web_deploy fix the tests` sends "fix the tests" to the web-deploy session.

**Single session:** If only one session exists, no prefix needed — just send messages.

### Bot Commands

| Command | Description |
|---------|-------------|
| `/session_name` | Switch to a session (tap from autocomplete) |
| `/session_name message` | Send message to a specific session |
| `/mode` | Show current permission mode |
| `/mode bypass` | Full access, no limits |
| `/mode auto` | Claude decides risk level |
| `/mode plan` | Read-only, no writes |
| `/refresh` | Rescan projects directory for new sessions |

### Remote Sessions

Run a relay on remote machines:

```bash
RELAY_PORT=4100 CLAUDE_CWD=/home/user/projects bun run src/relay/relay.ts
```

Configure remote sessions on the hub:

```bash
REMOTE_SESSIONS=vm2@10.0.0.5:4100,staging@10.0.0.6:4200
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | — | Target chat ID |
| `ALLOWED_USER_IDS` | Yes | — | Comma-separated user IDs |
| `AUTO_APPROVE` | Yes* | `false` | Auto-approve all permissions |
| `AUTO_APPROVE_TOOLS` | Yes* | — | Selective auto-approve |
| `SERVER_NAME` | No | `claude` | Default session name |
| `PROJECTS_DIR` | No | — | Auto-discover project folders as sessions |
| `REMOTE_SESSIONS` | No | — | Remote relays: `name@host:port,...` |
| `CLAUDE_CWD` | No | `$HOME` | Working directory for Claude |
| `CLAUDE_TIMEOUT` | No | `300000` | Max ms per response (5 min) |
| `RELAY_PORT` | No | `4100` | TCP port for relay |
| `HUB_IDLE_TIMEOUT` | No | `0` | Hub idle shutdown (0 = never) |

*At least one of `AUTO_APPROVE` or `AUTO_APPROVE_TOOLS` must be set.

## Development

```bash
bun install
bun test
bun run typecheck
bun run lint
```

## License

MIT
