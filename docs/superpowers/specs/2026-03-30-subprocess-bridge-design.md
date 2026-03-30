# Subprocess-Based Telegram Bridge Design Spec

## Overview

Replace the buggy MCP channel protocol with a subprocess-based approach. The hub calls `claude -p` directly to handle Telegram messages, with per-session conversation continuity via `--resume`. Remote machines are supported via a lightweight TCP relay.

## Why

The MCP `notifications/claude/channel` has a confirmed bug in Claude Code (20+ open issues, unfixed as of v2.1.87) where the REPL doesn't wake up to process inbound notifications. The subprocess approach bypasses this entirely — each message spawns a `claude -p` call that responds and exits.

## Architecture

Two components:

### 1. Hub

Runs on one machine, owns the Telegram bot. Routes messages to local or remote sessions.

**For local sessions:** spawns `claude -p "message" --resume <conversation-id>` directly, captures stdout, sends response to Telegram.

**For remote sessions:** sends the prompt over TCP to a relay on the remote machine, receives the response, sends it to Telegram.

### 2. Relay

Lightweight process on remote machines. Listens on a TCP port, receives prompts, runs `claude -p` locally, returns the response. No Telegram dependencies — just TCP + claude CLI.

## Data Flow

### Local Session
```
Telegram → Hub (grammy) → Router → claude-runner spawns `claude -p`
                                        ↓
                                   stdout captured
                                        ↓
                              Hub sends response to Telegram
```

### Remote Session (`@vm2`)
```
Telegram → Hub → TCP to relay@10.0.0.5:4100
                      ↓
              Relay runs `claude -p` locally
                      ↓
              Response sent back over TCP
                      ↓
           Hub sends response to Telegram
```

## IPC Protocol (Hub ↔ Relay)

JSON-over-TCP, newline-delimited. Two message types:

### Hub → Relay
```typescript
{
  type: "prompt",
  text: string,           // The user's message
  session_id: string,     // For --resume continuity
  auto_approve: boolean,  // Whether to use --dangerously-skip-permissions
  allowed_tools?: string[], // Specific tools to allow (if not full auto-approve)
  cwd?: string            // Working directory for claude
}
```

### Relay → Hub
```typescript
// Success
{
  type: "response",
  text: string,           // Claude's response (stdout)
  session_id: string,
  conversation_id: string // The conversation ID for future --resume
}

// Error
{
  type: "error",
  message: string,
  session_id: string
}
```

## Claude Runner

Core module shared by hub (local) and relay (remote). Manages spawning `claude -p` and conversation continuity.

**Command construction:**
```bash
# First message in a session (no conversation ID yet)
claude -p "user message" --dangerously-skip-permissions

# Subsequent messages (resume conversation)
claude -p "user message" --resume <conversation-id> --dangerously-skip-permissions

# With specific allowed tools instead of full bypass
claude -p "user message" --resume <conversation-id> --allowedTools "Bash,Read,Write"
```

**Conversation ID extraction:** `claude -p` outputs JSON when using `--output-format json`, which includes a `session_id` field. We use `--output-format json` internally, extract the text response and session ID, then send plain text to Telegram.

**Timeout:** Each `claude -p` call has a configurable timeout (default: 5 minutes). If Claude takes longer, the hub sends a "still working..." message to Telegram and waits.

**Long responses:** Telegram has a 4096 character limit per message. The runner splits responses at natural boundaries (double newlines, then single newlines, then hard split at 4096).

## Session Management

### Session Registry
```typescript
type Session = {
  name: string
  type: 'local' | 'remote'
  conversationId?: string    // for --resume, set after first response
  remoteHost?: string        // for remote sessions
  remotePort?: number
  busy: boolean              // true while claude -p is running
  cwd: string                // working directory
}
```

### Configuration

Sessions are configured via environment variables:

- **Local sessions** are implicit — any message routed to the hub that doesn't match a remote session is local.
- **Remote sessions:** `REMOTE_SESSIONS=vm2@10.0.0.5:4100,staging@10.0.0.6:4100`
- **Default session name:** `SERVER_NAME=claude` (used when only one session is active, no prefix needed)

### Smart Routing (unchanged from original)

- Single session: no prefix needed, all messages route to it
- Multiple sessions: `@session-name message` required
- No prefix with multiple sessions: "Which session? Active: a, b, c"

### Queue

If a message arrives while `claude -p` is still running for that session, it's queued. The hub sends a "Processing previous message, yours is queued..." reply to Telegram. Messages are processed in order per session.

## Permission Handling

Since `claude -p` is headless (no terminal for interactive approval), permissions must be pre-configured:

- `AUTO_APPROVE=true` → passes `--dangerously-skip-permissions` to claude CLI
- `AUTO_APPROVE_TOOLS=Bash,Write,Edit` → passes `--allowedTools Bash,Write,Edit`
- **At least one must be set.** Hub validates at startup and exits with an error if neither is configured.

Interactive Telegram approval (inline keyboards) is removed — it doesn't work with `claude -p` which runs and exits. The auto-approve env vars are the permission mechanism.

## Thread Tracking

Unchanged from original design. The hub maintains per-session thread tracking via `reply_to_message_id` so Telegram conversations stay threaded.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | — | Target chat ID |
| `ALLOWED_USER_IDS` | Yes | — | Comma-separated Telegram user IDs |
| `SERVER_NAME` | No | `claude` | Default session name |
| `AUTO_APPROVE` | Yes* | `false` | Auto-approve all permissions |
| `AUTO_APPROVE_TOOLS` | Yes* | — | Comma-separated tool names to allow |
| `REMOTE_SESSIONS` | No | — | Remote relays: `name@host:port,...` |
| `CLAUDE_CWD` | No | `$HOME` | Working directory for local claude |
| `CLAUDE_TIMEOUT` | No | `300000` | Max ms per claude -p call (5 min) |
| `RELAY_PORT` | No | `4100` | TCP port for relay to listen on |
| `HUB_IDLE_TIMEOUT` | No | `0` | Hub idle shutdown (0 = never) |

*At least one of `AUTO_APPROVE` or `AUTO_APPROVE_TOOLS` must be set.

## File Structure

```
src/
  hub/
    hub.ts              — Entry point: Telegram bot, routing, local/remote dispatch
    telegram-client.ts  — grammy bot setup, filtering, dedup (unchanged)
    router.ts           — Prefix parsing, session registry (simplified, no TCP sockets)
  relay/
    relay.ts            — TCP server, receives prompts, runs claude, returns response
  shared/
    config.ts           — Zod env validation (updated for new vars)
    claude-runner.ts    — Spawns `claude -p`, captures output, manages conversation IDs
    protocol.ts         — Simplified IPC types (prompt/response/error)
    threads.ts          — Reply thread tracking (unchanged)
    types.ts            — Updated interfaces
```

### Deleted files
- `src/instance/` — entire directory (server.ts, hub-client.ts, channel-bridge.ts, server-minimal.ts)
- `src/shared/permission.ts` — inline keyboard code no longer needed (auto-approve only)

### Deleted from .mcp.json
The MCP server configuration is removed. The hub is a standalone process, not an MCP server.

## Relay

### Startup
```bash
# On remote VM
RELAY_PORT=4100 CLAUDE_CWD=/home/user/projects bun run src/relay/relay.ts
```

Or as a systemd service, similar to the hub.

### Security
- Relay accepts TCP connections — should only be exposed on private networks
- No authentication (TCP is trusted within the private network)
- The relay only runs `claude -p` — it can't do anything the Claude CLI can't do

## Graceful Shutdown

### Hub
1. Stop grammy polling
2. Wait for in-flight `claude -p` processes to finish (with timeout)
3. Close TCP connections to relays
4. Remove PID file
5. Exit

### Relay
1. Stop accepting TCP connections
2. Wait for in-flight `claude -p` processes to finish
3. Exit

## Testing Strategy

- **claude-runner:** Unit test command construction, output parsing, conversation ID extraction, message splitting
- **router:** Prefix parsing, session routing (reuse existing tests, update for new Session type)
- **protocol:** Simplified IPC serialization/parsing
- **threads:** Unchanged, existing tests
- **config:** Updated validation tests
- **integration:** Full flow — mock claude CLI, send message through hub, verify response
