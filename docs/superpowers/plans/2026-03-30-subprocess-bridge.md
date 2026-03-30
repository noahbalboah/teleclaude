# Subprocess Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MCP channel protocol with `claude -p` subprocess calls so the Telegram hub auto-responds to messages without requiring an active Claude Code session.

**Architecture:** The hub receives Telegram messages, spawns `claude -p` with `--resume` for conversation continuity, captures the response, and sends it back to Telegram. Remote machines are supported via a TCP relay that receives prompts and runs `claude -p` locally.

**Tech Stack:** Bun, TypeScript, grammy, Zod, bun:test

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/shared/types.ts` | Updated interfaces — remove MCP types, add Session/HubConfig |
| `src/shared/config.ts` | Updated Zod validation — new env vars, remove HUB_PORT/HUB_HOST/InstanceConfig |
| `src/shared/protocol.ts` | Simplified IPC — just prompt/response/error for relay |
| `src/shared/claude-runner.ts` | Core: spawns `claude -p`, captures JSON output, extracts text + session_id, splits long messages |
| `src/shared/threads.ts` | Unchanged — reply thread tracking |
| `src/hub/telegram-client.ts` | Unchanged — grammy bot |
| `src/hub/router.ts` | Rewritten — session registry with local/remote sessions (no Socket dependency) |
| `src/hub/hub.ts` | Rewritten — Telegram bot + routing + local claude-runner + TCP to relays |
| `src/relay/relay.ts` | New — TCP server that receives prompts and runs claude-runner |

### Deleted
- `src/instance/` — entire directory
- `src/shared/permission.ts` — no more inline keyboards
- `.mcp.json` — no more MCP server

---

### Task 1: Delete Old Code and Update Types

**Files:**
- Delete: `src/instance/server.ts`, `src/instance/hub-client.ts`, `src/instance/channel-bridge.ts`, `src/instance/server-minimal.ts`
- Delete: `src/shared/permission.ts`
- Delete: `src/__tests__/permission.test.ts`, `src/__tests__/channel-bridge.test.ts`, `src/__tests__/server.test.ts`, `src/__tests__/hub-client.test.ts`
- Modify: `src/shared/types.ts`
- Delete: `.mcp.json`

- [ ] **Step 1: Delete the instance directory and permission module**

```bash
rm -rf src/instance
rm src/shared/permission.ts
rm src/__tests__/permission.test.ts src/__tests__/channel-bridge.test.ts src/__tests__/server.test.ts src/__tests__/hub-client.test.ts
rm -f .mcp.json
```

- [ ] **Step 2: Update types.ts**

Replace `src/shared/types.ts` with:

```typescript
// src/shared/types.ts
export interface HubConfig {
  telegramBotToken: string
  telegramChatId: number
  allowedUserIds: number[]
  serverName: string
  autoApprove: boolean
  autoApproveTools: string[]
  remoteSessions: RemoteSessionConfig[]
  claudeCwd: string
  claudeTimeout: number
  hubIdleTimeout: number
}

export interface RemoteSessionConfig {
  name: string
  host: string
  port: number
}

export interface RelayConfig {
  relayPort: number
  claudeCwd: string
  claudeTimeout: number
}

export interface Session {
  name: string
  type: 'local' | 'remote'
  conversationId?: string
  remoteHost?: string
  remotePort?: number
  busy: boolean
  cwd: string
  queue: QueuedMessage[]
}

export interface QueuedMessage {
  text: string
  messageId: number
  userId: number
}
```

- [ ] **Step 3: Verify remaining tests pass**

Run: `bun test src/__tests__/threads.test.ts src/__tests__/config.test.ts src/__tests__/protocol.test.ts src/__tests__/router.test.ts src/__tests__/telegram-client.test.ts`
Expected: Some may fail due to import changes — that's fine, we'll fix them in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove MCP instance, permission module, and .mcp.json"
```

---

### Task 2: Update Config Parsing

**Files:**
- Modify: `src/shared/config.ts`
- Modify: `src/__tests__/config.test.ts`

- [ ] **Step 1: Write the updated test**

```typescript
// src/__tests__/config.test.ts
import { describe, expect, it } from 'bun:test'
import { parseDuration, parseHubConfig, parseRelayConfig, safeErrorMessage } from '../shared/config.ts'

describe('parseHubConfig', () => {
  const validEnv = {
    TELEGRAM_BOT_TOKEN: '7123456789:ABCdefGHIjklMNOpqrSTUvwxYZ',
    TELEGRAM_CHAT_ID: '-100123456789',
    ALLOWED_USER_IDS: '123456789',
    AUTO_APPROVE: 'true',
  }

  it('parses valid env into HubConfig', () => {
    const config = parseHubConfig(validEnv)
    expect(config.telegramBotToken).toBe('7123456789:ABCdefGHIjklMNOpqrSTUvwxYZ')
    expect(config.telegramChatId).toBe(-100123456789)
    expect(config.allowedUserIds).toEqual([123456789])
    expect(config.autoApprove).toBe(true)
    expect(config.serverName).toBe('claude')
    expect(config.claudeCwd).toBe(process.env.HOME ?? '/tmp')
    expect(config.claudeTimeout).toBe(300000)
  })

  it('uses defaults for optional fields', () => {
    const config = parseHubConfig({
      TELEGRAM_BOT_TOKEN: '7123456789:ABCdefGHIjklMNOpqrSTUvwxYZ',
      TELEGRAM_CHAT_ID: '-100123456789',
      ALLOWED_USER_IDS: '123456789',
      AUTO_APPROVE: 'true',
    })
    expect(config.serverName).toBe('claude')
    expect(config.remoteSessions).toEqual([])
    expect(config.hubIdleTimeout).toBe(0)
  })

  it('parses REMOTE_SESSIONS', () => {
    const config = parseHubConfig({
      ...validEnv,
      REMOTE_SESSIONS: 'vm2@10.0.0.5:4100,staging@10.0.0.6:4200',
    })
    expect(config.remoteSessions).toEqual([
      { name: 'vm2', host: '10.0.0.5', port: 4100 },
      { name: 'staging', host: '10.0.0.6', port: 4200 },
    ])
  })

  it('parses AUTO_APPROVE_TOOLS', () => {
    const config = parseHubConfig({
      ...validEnv,
      AUTO_APPROVE: 'false',
      AUTO_APPROVE_TOOLS: 'Bash,Write,Edit',
    })
    expect(config.autoApprove).toBe(false)
    expect(config.autoApproveTools).toEqual(['Bash', 'Write', 'Edit'])
  })

  it('throws when neither AUTO_APPROVE nor AUTO_APPROVE_TOOLS is set', () => {
    expect(() =>
      parseHubConfig({
        TELEGRAM_BOT_TOKEN: '7123456789:ABCdefGHIjklMNOpqrSTUvwxYZ',
        TELEGRAM_CHAT_ID: '-100123456789',
        ALLOWED_USER_IDS: '123456789',
      }),
    ).toThrow()
  })

  it('throws on invalid bot token', () => {
    expect(() => parseHubConfig({ ...validEnv, TELEGRAM_BOT_TOKEN: 'bad' })).toThrow()
  })

  it('throws on missing TELEGRAM_CHAT_ID', () => {
    const { TELEGRAM_CHAT_ID: _, ...env } = validEnv
    expect(() => parseHubConfig(env)).toThrow()
  })

  it('parses CLAUDE_CWD', () => {
    const config = parseHubConfig({ ...validEnv, CLAUDE_CWD: '/home/user/projects' })
    expect(config.claudeCwd).toBe('/home/user/projects')
  })

  it('parses CLAUDE_TIMEOUT', () => {
    const config = parseHubConfig({ ...validEnv, CLAUDE_TIMEOUT: '600000' })
    expect(config.claudeTimeout).toBe(600000)
  })
})

describe('parseRelayConfig', () => {
  it('parses valid relay config', () => {
    const config = parseRelayConfig({ RELAY_PORT: '4100' })
    expect(config.relayPort).toBe(4100)
    expect(config.claudeCwd).toBe(process.env.HOME ?? '/tmp')
    expect(config.claudeTimeout).toBe(300000)
  })

  it('uses default port', () => {
    const config = parseRelayConfig({})
    expect(config.relayPort).toBe(4100)
  })
})

describe('parseDuration', () => {
  it('parses minutes', () => expect(parseDuration('30m')).toBe(1800000))
  it('parses hours', () => expect(parseDuration('1h')).toBe(3600000))
  it('parses seconds', () => expect(parseDuration('90s')).toBe(90000))
  it('parses 0 as disabled', () => expect(parseDuration('0')).toBe(0))
  it('throws on invalid format', () => expect(() => parseDuration('abc')).toThrow())
})

describe('safeErrorMessage', () => {
  it('redacts bot tokens', () => {
    const err = new Error('failed with token 7123456789:ABCdefGHIjkl')
    expect(safeErrorMessage(err)).toBe('failed with token [REDACTED]')
  })
  it('handles non-Error', () => expect(safeErrorMessage('err')).toBe('err'))
  it('handles null', () => expect(safeErrorMessage(null)).toBe('null'))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/config.test.ts`
Expected: FAIL — `parseRelayConfig` not found, `parseHubConfig` signature changed

- [ ] **Step 3: Rewrite config.ts**

```typescript
// src/shared/config.ts
import { z } from 'zod'
import type { HubConfig, RelayConfig, RemoteSessionConfig } from './types.ts'

const TELEGRAM_BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/
const REMOTE_SESSION_RE = /^([a-zA-Z0-9_-]+)@([^:]+):(\d+)$/

function parseRemoteSessions(s: string | undefined): RemoteSessionConfig[] {
  if (!s) return []
  return s
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(REMOTE_SESSION_RE)
      if (!match?.[1] || !match[2] || !match[3])
        throw new Error(`Invalid REMOTE_SESSIONS entry: "${entry}" (expected name@host:port)`)
      return { name: match[1], host: match[2], port: Number(match[3]) }
    })
}

const HubConfigSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z
      .string()
      .min(1, 'TELEGRAM_BOT_TOKEN is required')
      .regex(TELEGRAM_BOT_TOKEN_RE, 'TELEGRAM_BOT_TOKEN must match format: 123456:ABC-xyz'),
    TELEGRAM_CHAT_ID: z
      .string()
      .min(1, 'TELEGRAM_CHAT_ID is required')
      .transform((s) => {
        const n = Number(s)
        if (!Number.isInteger(n)) throw new Error('TELEGRAM_CHAT_ID must be an integer')
        return n
      }),
    ALLOWED_USER_IDS: z
      .string()
      .min(1, 'ALLOWED_USER_IDS is required')
      .transform((s) =>
        s
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
          .map((id) => {
            const n = Number(id)
            if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid user ID: "${id}"`)
            return n
          }),
      )
      .refine((arr) => arr.length > 0, 'ALLOWED_USER_IDS must contain at least one valid ID'),
    SERVER_NAME: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/, 'SERVER_NAME must be alphanumeric with hyphens/underscores')
      .default('claude'),
    AUTO_APPROVE: z
      .string()
      .default('false')
      .transform((s) => s === 'true'),
    AUTO_APPROVE_TOOLS: z
      .string()
      .optional()
      .transform((s) =>
        s
          ? s
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
      ),
    REMOTE_SESSIONS: z.string().optional(),
    CLAUDE_CWD: z.string().default(process.env.HOME ?? '/tmp'),
    CLAUDE_TIMEOUT: z
      .string()
      .default('300000')
      .transform((s) => Number(s)),
    HUB_IDLE_TIMEOUT: z
      .string()
      .default('0')
      .transform((s) => parseDuration(s)),
  })
  .refine(
    (data) => data.AUTO_APPROVE || data.AUTO_APPROVE_TOOLS.length > 0,
    'Either AUTO_APPROVE=true or AUTO_APPROVE_TOOLS must be set (headless mode requires pre-configured permissions)',
  )

const RelayConfigSchema = z.object({
  RELAY_PORT: z
    .string()
    .default('4100')
    .transform((s) => {
      const n = Number(s)
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('RELAY_PORT must be 1-65535')
      return n
    }),
  CLAUDE_CWD: z.string().default(process.env.HOME ?? '/tmp'),
  CLAUDE_TIMEOUT: z
    .string()
    .default('300000')
    .transform((s) => Number(s)),
})

export function parseDuration(s: string): number {
  if (s === '0') return 0
  const match = s.match(/^(\d+)(s|m|h)$/)
  if (!match?.[1] || !match[2])
    throw new Error(`Invalid duration: "${s}" (expected e.g. 30m, 1h, 90s, or 0)`)
  const value = Number(match[1])
  const unit = match[2]
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000 }
  return value * (multipliers[unit] ?? 0)
}

export function parseHubConfig(env: Record<string, string | undefined>): HubConfig {
  const result = HubConfigSchema.parse(env)
  return {
    telegramBotToken: result.TELEGRAM_BOT_TOKEN,
    telegramChatId: result.TELEGRAM_CHAT_ID,
    allowedUserIds: result.ALLOWED_USER_IDS,
    serverName: result.SERVER_NAME,
    autoApprove: result.AUTO_APPROVE,
    autoApproveTools: result.AUTO_APPROVE_TOOLS,
    remoteSessions: parseRemoteSessions(result.REMOTE_SESSIONS),
    claudeCwd: result.CLAUDE_CWD,
    claudeTimeout: result.CLAUDE_TIMEOUT,
    hubIdleTimeout: result.HUB_IDLE_TIMEOUT,
  }
}

export function parseRelayConfig(env: Record<string, string | undefined>): RelayConfig {
  const result = RelayConfigSchema.parse(env)
  return {
    relayPort: result.RELAY_PORT,
    claudeCwd: result.CLAUDE_CWD,
    claudeTimeout: result.CLAUDE_TIMEOUT,
  }
}

export function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\d+:[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/config.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/config.ts src/__tests__/config.test.ts src/shared/types.ts
git commit -m "feat: update config for subprocess bridge — add REMOTE_SESSIONS, CLAUDE_CWD, require auto-approve"
```

---

### Task 3: Simplified IPC Protocol

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/__tests__/protocol.test.ts`

- [ ] **Step 1: Write the updated test**

```typescript
// src/__tests__/protocol.test.ts
import { describe, expect, it } from 'bun:test'
import {
  type PromptMessage,
  type RelayResponse,
  parsePromptMessage,
  parseRelayResponse,
  serializeMessage,
} from '../shared/protocol.ts'

describe('serializeMessage', () => {
  it('serializes to newline-delimited JSON', () => {
    const msg: PromptMessage = {
      type: 'prompt',
      text: 'hello',
      session_id: 'test',
      auto_approve: true,
    }
    const serialized = serializeMessage(msg)
    expect(serialized).toContain('"type":"prompt"')
    expect(serialized.endsWith('\n')).toBe(true)
  })
})

describe('parsePromptMessage', () => {
  it('parses a valid prompt', () => {
    const result = parsePromptMessage(
      '{"type":"prompt","text":"hello","session_id":"s1","auto_approve":true}',
    )
    expect(result).toEqual({ type: 'prompt', text: 'hello', session_id: 's1', auto_approve: true })
  })

  it('parses prompt with optional fields', () => {
    const result = parsePromptMessage(
      JSON.stringify({
        type: 'prompt',
        text: 'hello',
        session_id: 's1',
        auto_approve: false,
        allowed_tools: ['Bash', 'Write'],
        cwd: '/home/user',
      }),
    )
    expect(result?.allowed_tools).toEqual(['Bash', 'Write'])
    expect(result?.cwd).toBe('/home/user')
  })

  it('returns null for invalid JSON', () => {
    expect(parsePromptMessage('not json')).toBeNull()
  })

  it('returns null for wrong type', () => {
    expect(parsePromptMessage('{"type":"other"}')).toBeNull()
  })
})

describe('parseRelayResponse', () => {
  it('parses a success response', () => {
    const result = parseRelayResponse(
      '{"type":"response","text":"hi","session_id":"s1","conversation_id":"c1"}',
    )
    expect(result).toEqual({
      type: 'response',
      text: 'hi',
      session_id: 's1',
      conversation_id: 'c1',
    })
  })

  it('parses an error response', () => {
    const result = parseRelayResponse(
      '{"type":"error","message":"failed","session_id":"s1"}',
    )
    expect(result).toEqual({ type: 'error', message: 'failed', session_id: 's1' })
  })

  it('returns null for invalid JSON', () => {
    expect(parseRelayResponse('garbage')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/protocol.test.ts`
Expected: FAIL — old exports don't exist

- [ ] **Step 3: Rewrite protocol.ts**

```typescript
// src/shared/protocol.ts
import { z } from 'zod'

// Hub → Relay
const PromptSchema = z.object({
  type: z.literal('prompt'),
  text: z.string(),
  session_id: z.string(),
  auto_approve: z.boolean(),
  allowed_tools: z.array(z.string()).optional(),
  cwd: z.string().optional(),
})

// Relay → Hub
const ResponseSchema = z.object({
  type: z.literal('response'),
  text: z.string(),
  session_id: z.string(),
  conversation_id: z.string(),
})

const ErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  session_id: z.string(),
})

const RelayResponseSchema = z.discriminatedUnion('type', [ResponseSchema, ErrorSchema])

export type PromptMessage = z.infer<typeof PromptSchema>
export type RelayResponse = z.infer<typeof RelayResponseSchema>

export function serializeMessage(msg: PromptMessage | RelayResponse): string {
  return `${JSON.stringify(msg)}\n`
}

export function parsePromptMessage(raw: string): PromptMessage | null {
  try {
    const json = JSON.parse(raw)
    const result = PromptSchema.safeParse(json)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function parseRelayResponse(raw: string): RelayResponse | null {
  try {
    const json = JSON.parse(raw)
    const result = RelayResponseSchema.safeParse(json)
    return result.success ? result.data : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/protocol.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/protocol.ts src/__tests__/protocol.test.ts
git commit -m "feat: simplify IPC protocol to prompt/response for relay"
```

---

### Task 4: Claude Runner

**Files:**
- Create: `src/shared/claude-runner.ts`
- Create: `src/__tests__/claude-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/claude-runner.test.ts
import { describe, expect, it } from 'bun:test'
import { buildClaudeArgs, parseClaudeOutput, splitMessage } from '../shared/claude-runner.ts'

describe('buildClaudeArgs', () => {
  it('builds args for first message with auto-approve', () => {
    const args = buildClaudeArgs({
      text: 'hello',
      autoApprove: true,
      autoApproveTools: [],
    })
    expect(args).toContain('-p')
    expect(args).toContain('hello')
    expect(args).toContain('--output-format')
    expect(args).toContain('json')
    expect(args).toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--resume')
  })

  it('builds args with --resume for continued conversation', () => {
    const args = buildClaudeArgs({
      text: 'follow up',
      autoApprove: true,
      autoApproveTools: [],
      conversationId: 'abc-123',
    })
    expect(args).toContain('--resume')
    expect(args).toContain('abc-123')
  })

  it('builds args with --allowedTools instead of skip-permissions', () => {
    const args = buildClaudeArgs({
      text: 'hello',
      autoApprove: false,
      autoApproveTools: ['Bash', 'Write'],
    })
    expect(args).toContain('--allowedTools')
    expect(args).toContain('Bash,Write')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('includes --cwd when specified', () => {
    const args = buildClaudeArgs({
      text: 'hello',
      autoApprove: true,
      autoApproveTools: [],
      cwd: '/home/user/projects',
    })
    // cwd is handled by spawn options, not CLI args — but let's verify it's not in args
    expect(args).not.toContain('/home/user/projects')
  })
})

describe('parseClaudeOutput', () => {
  it('extracts text and session_id from JSON output', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Hello! How can I help?',
      session_id: 'abc-123',
      is_error: false,
    })
    const parsed = parseClaudeOutput(json)
    expect(parsed.text).toBe('Hello! How can I help?')
    expect(parsed.sessionId).toBe('abc-123')
    expect(parsed.error).toBeUndefined()
  })

  it('handles error output', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'error',
      result: 'Something went wrong',
      session_id: 'abc-123',
      is_error: true,
    })
    const parsed = parseClaudeOutput(json)
    expect(parsed.error).toBe('Something went wrong')
  })

  it('handles non-JSON output gracefully', () => {
    const parsed = parseClaudeOutput('not json at all')
    expect(parsed.text).toBe('not json at all')
    expect(parsed.sessionId).toBeUndefined()
  })
})

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    const chunks = splitMessage('hello', 4096)
    expect(chunks).toEqual(['hello'])
  })

  it('splits at double newlines', () => {
    const long = 'A'.repeat(4000) + '\n\n' + 'B'.repeat(100)
    const chunks = splitMessage(long, 4096)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe('A'.repeat(4000))
    expect(chunks[1]).toBe('B'.repeat(100))
  })

  it('splits at single newlines when no double newlines', () => {
    const long = 'A'.repeat(4000) + '\n' + 'B'.repeat(100)
    const chunks = splitMessage(long, 4096)
    expect(chunks).toHaveLength(2)
  })

  it('hard splits when no newlines', () => {
    const long = 'A'.repeat(8192)
    const chunks = splitMessage(long, 4096)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(4096)
    expect(chunks[1]).toHaveLength(4096)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/claude-runner.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write claude-runner.ts**

```typescript
// src/shared/claude-runner.ts
import { spawn } from 'node:child_process'
import { safeErrorMessage } from './config.ts'

export interface ClaudeRunOptions {
  text: string
  autoApprove: boolean
  autoApproveTools: string[]
  conversationId?: string
  cwd?: string
  timeout?: number
}

export interface ClaudeResult {
  text: string
  sessionId?: string
  error?: string
}

export function buildClaudeArgs(opts: ClaudeRunOptions): string[] {
  const args = ['-p', opts.text, '--output-format', 'json', '--no-session-persistence']

  if (opts.conversationId) {
    args.push('--resume', opts.conversationId)
  }

  if (opts.autoApprove) {
    args.push('--dangerously-skip-permissions')
  } else if (opts.autoApproveTools.length > 0) {
    args.push('--allowedTools', opts.autoApproveTools.join(','))
  }

  return args
}

export function parseClaudeOutput(raw: string): ClaudeResult {
  try {
    const data = JSON.parse(raw)
    if (data.is_error) {
      return { text: '', error: data.result ?? 'Unknown error', sessionId: data.session_id }
    }
    return {
      text: data.result ?? '',
      sessionId: data.session_id,
    }
  } catch {
    // Non-JSON output — return as-is
    return { text: raw.trim() }
  }
}

const TELEGRAM_MAX_LENGTH = 4096

export function splitMessage(text: string, maxLength: number = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLength)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', maxLength)
    if (splitAt <= 0) splitAt = maxLength

    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeResult> {
  const args = buildClaudeArgs(opts)
  const timeout = opts.timeout ?? 300000

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        resolve({
          text: '',
          error: safeErrorMessage(stderr || `claude exited with code ${code}`),
        })
        return
      }
      resolve(parseClaudeOutput(stdout))
    })

    proc.on('error', (err) => {
      resolve({ text: '', error: safeErrorMessage(err) })
    })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/claude-runner.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/claude-runner.ts src/__tests__/claude-runner.test.ts
git commit -m "feat: add claude-runner — spawns claude -p, parses output, splits messages"
```

---

### Task 5: Update Router (No TCP, Session-Based)

**Files:**
- Modify: `src/hub/router.ts`
- Modify: `src/__tests__/router.test.ts`

- [ ] **Step 1: Write the updated test**

```typescript
// src/__tests__/router.test.ts
import { describe, expect, it } from 'bun:test'
import { parsePrefix, SessionRegistry } from '../hub/router.ts'
import type { Session } from '../shared/types.ts'

describe('parsePrefix', () => {
  it('extracts session name and body from @-prefixed message', () => {
    const result = parsePrefix('@web-deploy fix the tests')
    expect(result).toEqual({ name: 'web-deploy', body: 'fix the tests' })
  })

  it('handles underscore in session name', () => {
    const result = parsePrefix('@my_session do something')
    expect(result).toEqual({ name: 'my_session', body: 'do something' })
  })

  it('returns null for messages without @ prefix', () => {
    expect(parsePrefix('hello world')).toBeNull()
  })

  it('returns null for @ without space after name', () => {
    expect(parsePrefix('@session')).toBeNull()
  })

  it('returns null for empty body after prefix', () => {
    expect(parsePrefix('@session ')).toBeNull()
  })

  it('parses first word as session name even with spaces in body', () => {
    const result = parsePrefix('@bad session fix it')
    expect(result).toEqual({ name: 'bad', body: 'session fix it' })
  })

  it('handles plain alphanumeric session names', () => {
    const result = parsePrefix('@claude fix the tests')
    expect(result).toEqual({ name: 'claude', body: 'fix the tests' })
  })
})

describe('SessionRegistry', () => {
  it('starts with configured sessions', () => {
    const registry = new SessionRegistry('claude', [], '/tmp')
    expect(registry.count).toBe(1)
    expect(registry.names).toEqual(['claude'])
  })

  it('includes remote sessions', () => {
    const registry = new SessionRegistry('claude', [
      { name: 'vm2', host: '10.0.0.5', port: 4100 },
    ], '/tmp')
    expect(registry.count).toBe(2)
    expect(registry.names.sort()).toEqual(['claude', 'vm2'])
  })

  it('get returns local session', () => {
    const registry = new SessionRegistry('claude', [], '/tmp')
    const session = registry.get('claude')
    expect(session?.type).toBe('local')
    expect(session?.busy).toBe(false)
  })

  it('get returns remote session', () => {
    const registry = new SessionRegistry('claude', [
      { name: 'vm2', host: '10.0.0.5', port: 4100 },
    ], '/tmp')
    const session = registry.get('vm2')
    expect(session?.type).toBe('remote')
    expect(session?.remoteHost).toBe('10.0.0.5')
    expect(session?.remotePort).toBe(4100)
  })

  it('get returns undefined for unknown session', () => {
    const registry = new SessionRegistry('claude', [], '/tmp')
    expect(registry.get('unknown')).toBeUndefined()
  })

  it('route returns the only session when count is 1 and no prefix', () => {
    const registry = new SessionRegistry('claude', [], '/tmp')
    const result = registry.route(null)
    expect(result.type).toBe('routed')
    if (result.type === 'routed') expect(result.session.name).toBe('claude')
  })

  it('route returns ambiguous when count > 1 and no prefix', () => {
    const registry = new SessionRegistry('claude', [
      { name: 'vm2', host: '10.0.0.5', port: 4100 },
    ], '/tmp')
    const result = registry.route(null)
    expect(result.type).toBe('ambiguous')
  })

  it('route returns routed for valid prefix', () => {
    const registry = new SessionRegistry('claude', [
      { name: 'vm2', host: '10.0.0.5', port: 4100 },
    ], '/tmp')
    const result = registry.route('vm2')
    expect(result.type).toBe('routed')
    if (result.type === 'routed') expect(result.session.name).toBe('vm2')
  })

  it('route returns not_found for unknown prefix', () => {
    const registry = new SessionRegistry('claude', [], '/tmp')
    const result = registry.route('unknown')
    expect(result.type).toBe('not_found')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/router.test.ts`
Expected: FAIL — old API

- [ ] **Step 3: Rewrite router.ts**

```typescript
// src/hub/router.ts
import type { RemoteSessionConfig, Session } from '../shared/types.ts'

const PREFIX_RE = /^@([a-zA-Z0-9_-]+)\s+(.+)$/s

export function parsePrefix(text: string): { name: string; body: string } | null {
  const match = text.match(PREFIX_RE)
  if (!match?.[1] || !match[2]) return null
  const body = match[2].trim()
  if (!body) return null
  return { name: match[1], body }
}

export type RouteResult =
  | { type: 'routed'; session: Session }
  | { type: 'ambiguous'; names: string[] }
  | { type: 'not_found'; name: string; available: string[] }

export class SessionRegistry {
  private sessions = new Map<string, Session>()

  constructor(
    defaultName: string,
    remoteSessions: RemoteSessionConfig[],
    defaultCwd: string,
  ) {
    // Register the default local session
    this.sessions.set(defaultName, {
      name: defaultName,
      type: 'local',
      busy: false,
      cwd: defaultCwd,
      queue: [],
    })

    // Register remote sessions
    for (const rs of remoteSessions) {
      this.sessions.set(rs.name, {
        name: rs.name,
        type: 'remote',
        remoteHost: rs.host,
        remotePort: rs.port,
        busy: false,
        cwd: defaultCwd,
        queue: [],
      })
    }
  }

  get count(): number {
    return this.sessions.size
  }

  get names(): string[] {
    return [...this.sessions.keys()]
  }

  get(name: string): Session | undefined {
    return this.sessions.get(name)
  }

  route(targetName: string | null): RouteResult {
    if (targetName !== null) {
      const session = this.sessions.get(targetName)
      if (session) return { type: 'routed', session }
      return { type: 'not_found', name: targetName, available: this.names }
    }

    if (this.sessions.size === 1) {
      const session = [...this.sessions.values()][0]!
      return { type: 'routed', session }
    }
    return { type: 'ambiguous', names: this.names }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/router.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/hub/router.ts src/__tests__/router.test.ts
git commit -m "feat: rewrite router for session-based routing (no TCP sockets)"
```

---

### Task 6: Rewrite Hub

**Files:**
- Modify: `src/hub/hub.ts`

- [ ] **Step 1: Rewrite hub.ts**

```typescript
#!/usr/bin/env bun
// src/hub/hub.ts
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync, writeFileSync } from 'node:fs'
import { safeErrorMessage, parseHubConfig } from '../shared/config.ts'
import { runClaude, splitMessage } from '../shared/claude-runner.ts'
import {
  type PromptMessage,
  type RelayResponse,
  parseRelayResponse,
  serializeMessage,
} from '../shared/protocol.ts'
import type { Session } from '../shared/types.ts'
import { ThreadTracker } from '../shared/threads.ts'
import { parsePrefix, SessionRegistry } from './router.ts'
import { createTelegramClient } from './telegram-client.ts'

const PID_FILE = join(homedir(), '.claude-telegram-hub.pid')

const config = parseHubConfig(process.env)
const registry = new SessionRegistry(config.serverName, config.remoteSessions, config.claudeCwd)
const threadTrackers = new Map<string, ThreadTracker>()

// Initialize thread trackers for all sessions
for (const name of registry.names) {
  threadTrackers.set(name, new ThreadTracker())
}

let lastActivity = Date.now()
function touch() {
  lastActivity = Date.now()
}

// --- Handle a routed message ---
async function handleMessage(
  session: Session,
  text: string,
  messageId: number,
  bot: ReturnType<typeof createTelegramClient>,
): Promise<void> {
  if (session.busy) {
    session.queue.push({ text, messageId, userId: 0 })
    await bot.api.sendMessage(config.telegramChatId, 'Processing previous message, yours is queued...', {
      reply_to_message_id: messageId,
    })
    return
  }

  session.busy = true
  const tracker = threadTrackers.get(session.name)

  try {
    let responseText: string

    if (session.type === 'local') {
      const result = await runClaude({
        text,
        autoApprove: config.autoApprove,
        autoApproveTools: config.autoApproveTools,
        conversationId: session.conversationId,
        cwd: session.cwd,
        timeout: config.claudeTimeout,
      })

      if (result.error) {
        responseText = `Error: ${result.error}`
      } else {
        responseText = result.text
        if (result.sessionId) {
          session.conversationId = result.sessionId
        }
      }
    } else {
      // Remote session — send to relay via TCP
      responseText = await sendToRelay(session, text)
    }

    // Send response to Telegram
    const prefix = registry.count > 1 ? `[${session.name}] ` : ''
    const chunks = splitMessage(`${prefix}${responseText}`)

    for (const chunk of chunks) {
      const sent = await bot.api.sendMessage(config.telegramChatId, chunk, {
        reply_to_message_id: tracker?.activeMessageId ?? messageId,
      })
      if (!tracker?.activeMessageId) {
        tracker?.startThread(sent.message_id)
      }
    }
  } catch (err) {
    await bot.api.sendMessage(
      config.telegramChatId,
      `Error: ${safeErrorMessage(err)}`,
      { reply_to_message_id: messageId },
    ).catch(() => {})
  } finally {
    session.busy = false

    // Process queued messages
    const next = session.queue.shift()
    if (next) {
      handleMessage(session, next.text, next.messageId, bot).catch((err) => {
        console.error('[hub] queued message failed:', safeErrorMessage(err))
      })
    }
  }
}

// --- Send prompt to remote relay ---
function sendToRelay(session: Session, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(
      { host: session.remoteHost!, port: session.remotePort! },
      () => {
        const msg: PromptMessage = {
          type: 'prompt',
          text,
          session_id: session.name,
          auto_approve: config.autoApprove,
          allowed_tools: config.autoApproveTools.length > 0 ? config.autoApproveTools : undefined,
          cwd: session.cwd,
        }
        socket.write(serializeMessage(msg))
      },
    )

    let buffer = ''
    socket.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const response = parseRelayResponse(line)
        if (!response) continue
        socket.end()
        if (response.type === 'response') {
          if (response.conversation_id) {
            session.conversationId = response.conversation_id
          }
          resolve(response.text)
        } else {
          reject(new Error(response.message))
        }
      }
    })

    socket.on('error', (err) => {
      reject(new Error(`Relay connection failed: ${safeErrorMessage(err)}`))
    })

    socket.setTimeout(300000)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('Relay connection timed out'))
    })
  })
}

// --- Telegram bot ---
const bot = createTelegramClient(
  config.telegramBotToken,
  { chatId: config.telegramChatId, allowedUserIds: config.allowedUserIds },
  async (msg) => {
    touch()

    const prefix = parsePrefix(msg.text)
    const routeResult = registry.route(prefix?.name ?? null)

    switch (routeResult.type) {
      case 'routed': {
        const text = prefix ? prefix.body : msg.text
        const tracker = threadTrackers.get(routeResult.session.name)
        const classification = tracker?.classifyMessage(msg.replyToMessageId) ?? 'new_input'
        if (classification === 'new_input') {
          tracker?.abandon()
        }
        await handleMessage(routeResult.session, text, msg.messageId, bot)
        break
      }
      case 'ambiguous':
        await bot.api.sendMessage(
          config.telegramChatId,
          `Which session? Active: ${routeResult.names.join(', ')}`,
          { reply_to_message_id: msg.messageId },
        )
        break
      case 'not_found':
        await bot.api.sendMessage(
          config.telegramChatId,
          `Session '${routeResult.name}' not connected. Active: ${routeResult.available.join(', ') || 'none'}`,
          { reply_to_message_id: msg.messageId },
        )
        break
    }
  },
)

// --- PID file ---
function writePidFile(): void {
  writeFileSync(PID_FILE, `${process.pid}`)
}

function removePidFile(): void {
  try { unlinkSync(PID_FILE) } catch {}
}

// --- Idle timeout ---
let idleTimer: ReturnType<typeof setInterval> | undefined

if (config.hubIdleTimeout > 0) {
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > config.hubIdleTimeout) {
      console.error('[hub] idle timeout reached, shutting down')
      bot.api.sendMessage(config.telegramChatId, 'Hub shutting down (idle)').catch(() => {})
        .finally(() => shutdown('idle'))
    }
  }, 60_000)
}

// --- Shutdown ---
let shutdownInitiated = false

async function shutdown(signal: string): Promise<void> {
  if (shutdownInitiated) return
  shutdownInitiated = true
  console.error(`[hub] shutdown: ${signal}`)

  if (idleTimer) clearInterval(idleTimer)
  await bot.stop()
  removePidFile()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// --- Start ---
writePidFile()

await bot.init()
console.error('[hub] Telegram bot initialized')

bot.start({
  onStart: () => {
    console.error('[hub] Telegram bot polling started')
    console.error(`[hub] Sessions: ${registry.names.join(', ')}`)
  },
})
```

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors (some may need fixing)

- [ ] **Step 3: Commit**

```bash
git add src/hub/hub.ts
git commit -m "feat: rewrite hub — subprocess-based with local/remote session support"
```

---

### Task 7: Relay

**Files:**
- Create: `src/relay/relay.ts`

- [ ] **Step 1: Create relay.ts**

```typescript
#!/usr/bin/env bun
// src/relay/relay.ts
import { createServer } from 'node:net'
import { parseRelayConfig, safeErrorMessage } from '../shared/config.ts'
import { runClaude } from '../shared/claude-runner.ts'
import { parsePromptMessage, serializeMessage } from '../shared/protocol.ts'

const config = parseRelayConfig(process.env)

const conversationIds = new Map<string, string>()

const server = createServer((socket) => {
  let buffer = ''

  socket.on('data', (data) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      const msg = parsePromptMessage(line)
      if (!msg) {
        console.error('[relay] invalid message:', line.slice(0, 100))
        continue
      }

      const existingConvId = conversationIds.get(msg.session_id)

      runClaude({
        text: msg.text,
        autoApprove: msg.auto_approve,
        autoApproveTools: msg.allowed_tools ?? [],
        conversationId: existingConvId,
        cwd: msg.cwd ?? config.claudeCwd,
        timeout: config.claudeTimeout,
      })
        .then((result) => {
          if (result.sessionId) {
            conversationIds.set(msg.session_id, result.sessionId)
          }
          if (result.error) {
            socket.write(
              serializeMessage({
                type: 'error',
                message: result.error,
                session_id: msg.session_id,
              }),
            )
          } else {
            socket.write(
              serializeMessage({
                type: 'response',
                text: result.text,
                session_id: msg.session_id,
                conversation_id: result.sessionId ?? '',
              }),
            )
          }
        })
        .catch((err) => {
          socket.write(
            serializeMessage({
              type: 'error',
              message: safeErrorMessage(err),
              session_id: msg.session_id,
            }),
          )
        })
    }
  })

  socket.on('error', (err) => {
    console.error('[relay] socket error:', safeErrorMessage(err))
  })
})

server.listen(config.relayPort, '0.0.0.0', () => {
  console.error(`[relay] listening on 0.0.0.0:${config.relayPort}`)
})

process.on('SIGTERM', () => {
  console.error('[relay] shutdown: SIGTERM')
  server.close()
  process.exit(0)
})
process.on('SIGINT', () => {
  console.error('[relay] shutdown: SIGINT')
  server.close()
  process.exit(0)
})
```

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/relay/relay.ts
git commit -m "feat: add relay — TCP server for remote claude-runner execution"
```

---

### Task 8: Update Package.json, Systemd, and README

**Files:**
- Modify: `package.json`
- Modify: `~/.config/systemd/user/claude-telegram-hub.service` (update env file)
- Modify: `~/.config/claude-telegram-hub.env`
- Modify: `README.md`

- [ ] **Step 1: Update package.json bin entries**

Replace the `bin` field:

```json
"bin": {
  "claude-telegram-hub": "src/hub/hub.ts",
  "claude-telegram-relay": "src/relay/relay.ts"
}
```

Remove `@modelcontextprotocol/sdk` from dependencies (no longer needed).

- [ ] **Step 2: Remove MCP SDK dependency**

Run: `bun remove @modelcontextprotocol/sdk`

- [ ] **Step 3: Update systemd env file**

Update `~/.config/claude-telegram-hub.env`:

```bash
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
TELEGRAM_CHAT_ID=YOUR_CHAT_ID
ALLOWED_USER_IDS=YOUR_CHAT_ID
AUTO_APPROVE=true
SERVER_NAME=claude
CLAUDE_CWD=/home/noah
HUB_IDLE_TIMEOUT=0
```

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: all tests PASS

- [ ] **Step 5: Run full lint and typecheck**

Run: `bunx tsc --noEmit && bunx biome check --write .`

- [ ] **Step 6: Update README.md**

Replace the Architecture section and Quick Start to reflect that this is now a standalone hub (not an MCP server), uses `claude -p` under the hood, and runs as a systemd service.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: update package.json, systemd config, README for subprocess bridge"
```

---

### Task 9: Integration Test

**Files:**
- Modify: `src/__tests__/integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// src/__tests__/integration.test.ts
import { describe, expect, it } from 'bun:test'
import { buildClaudeArgs, parseClaudeOutput, splitMessage } from '../shared/claude-runner.ts'
import { SessionRegistry } from '../hub/router.ts'

describe('End-to-end command construction', () => {
  it('builds full command for local session first message', () => {
    const registry = new SessionRegistry('claude', [], '/home/user')
    const result = registry.route(null)
    expect(result.type).toBe('routed')

    if (result.type === 'routed') {
      const args = buildClaudeArgs({
        text: 'fix the tests',
        autoApprove: true,
        autoApproveTools: [],
        conversationId: result.session.conversationId,
        cwd: result.session.cwd,
      })

      expect(args).toContain('-p')
      expect(args).toContain('fix the tests')
      expect(args).toContain('--dangerously-skip-permissions')
      expect(args).not.toContain('--resume')
    }
  })

  it('builds full command with resume for continued conversation', () => {
    const registry = new SessionRegistry('claude', [], '/home/user')
    const session = registry.get('claude')!
    session.conversationId = 'abc-123'

    const args = buildClaudeArgs({
      text: 'follow up',
      autoApprove: true,
      autoApproveTools: [],
      conversationId: session.conversationId,
      cwd: session.cwd,
    })

    expect(args).toContain('--resume')
    expect(args).toContain('abc-123')
  })

  it('routes prefixed message to correct session', () => {
    const registry = new SessionRegistry('claude', [
      { name: 'vm2', host: '10.0.0.5', port: 4100 },
    ], '/tmp')

    const result = registry.route('vm2')
    expect(result.type).toBe('routed')
    if (result.type === 'routed') {
      expect(result.session.type).toBe('remote')
      expect(result.session.remoteHost).toBe('10.0.0.5')
    }
  })

  it('full output parsing and splitting pipeline', () => {
    const json = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'A'.repeat(5000),
      session_id: 'test-session',
      is_error: false,
    })

    const parsed = parseClaudeOutput(json)
    expect(parsed.sessionId).toBe('test-session')
    expect(parsed.text.length).toBe(5000)

    const chunks = splitMessage(parsed.text)
    expect(chunks.length).toBe(2)
    expect(chunks[0]!.length).toBe(4096)
    expect(chunks[1]!.length).toBe(904)
  })
})
```

- [ ] **Step 2: Run integration test**

Run: `bun test src/__tests__/integration.test.ts`
Expected: all tests PASS

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/integration.test.ts
git commit -m "test: add integration tests for subprocess bridge pipeline"
```

---

### Task 10: Live Test

**Files:** None — this is a manual verification task.

- [ ] **Step 1: Restart the hub systemd service**

```bash
systemctl --user restart claude-telegram-hub
```

- [ ] **Step 2: Check hub logs**

```bash
journalctl --user -u claude-telegram-hub -f
```

Expected: `[hub] Telegram bot initialized`, `[hub] Telegram bot polling started`, `[hub] Sessions: claude`

- [ ] **Step 3: Send a test message from Telegram**

Send "hello" to the bot.

Expected: Claude responds in Telegram within a few seconds.

- [ ] **Step 4: Send a follow-up to verify --resume**

Send "what did I just say?"

Expected: Claude remembers the previous message and responds correctly.

- [ ] **Step 5: Commit any fixes**

If anything needed fixing during live test, commit the fixes.

---

## Summary

| Task | What it does | Tests |
|------|-------------|-------|
| 1 | Delete old MCP code, update types | — |
| 2 | Rewrite config for new env vars | ~15 |
| 3 | Simplify IPC protocol | ~8 |
| 4 | Claude runner (spawn + parse + split) | ~12 |
| 5 | Rewrite router (session-based) | ~14 |
| 6 | Rewrite hub (subprocess + relay) | — |
| 7 | Add relay | — |
| 8 | Update package.json, systemd, README | — |
| 9 | Integration tests | ~4 |
| 10 | Live test | — |
| **Total** | | **~53** |
