# teleclaude

## What This Is

A Telegram bridge for Claude Code. A hub process runs a Telegram bot that spawns `claude -p` to handle messages, with per-session conversation continuity. Supports multiple project sessions and remote machines via TCP relay.

## Architecture

- **Hub** (`src/hub/hub.ts`) — grammy Telegram bot, routes messages to sessions, spawns `claude -p` for local sessions, TCP to relays for remote
- **Relay** (`src/relay/relay.ts`) — lightweight TCP server on remote machines, receives prompts, runs `claude -p` locally
- **Shared** (`src/shared/`) — config parsing, claude CLI runner, IPC protocol, thread tracking

## Key Design Decisions

- Uses `claude -p` subprocess (not MCP channel protocol) because `notifications/claude/channel` has a confirmed bug in Claude Code that prevents auto-wake
- Per-session `--resume` for conversation continuity
- `PROJECTS_DIR` auto-discovers project directories as sessions
- Telegram `/` commands registered dynamically for autocomplete
- `AUTO_APPROVE=true` required — headless mode can't prompt for permissions

## Running

Hub runs as a systemd user service: `systemctl --user start claude-telegram-hub`

Config: `~/.config/claude-telegram-hub.env`

## Development

```bash
bun install
bun test            # 75 tests
bun run typecheck   # tsc --noEmit
bun run lint        # biome check
```

## Testing Changes

After modifying hub code: `systemctl --user restart claude-telegram-hub`

Check logs: `journalctl --user -u claude-telegram-hub -f`
