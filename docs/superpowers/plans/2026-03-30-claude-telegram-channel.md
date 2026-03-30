# claude-telegram-channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP server that bridges Claude Code sessions to Telegram with multi-session hub routing and permission auto-approve.

**Architecture:** Two-component system — a persistent hub process owns the Telegram bot and routes messages via TCP to per-session MCP instances that Claude Code spawns. Hub auto-starts on first use. Smart routing adapts between single and multi-session modes.

**Tech Stack:** Bun, TypeScript (strict), grammy, @modelcontextprotocol/sdk, Zod, Biome, bun:test

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/shared/types.ts` | Shared TypeScript interfaces (ChannelConfig, HubConfig, PermissionRequest, PermissionVerdict) |
| `src/shared/protocol.ts` | IPC message type definitions and Zod schemas for hub ↔ instance JSON-over-TCP protocol |
| `src/shared/config.ts` | Zod env var validation, `parseHubConfig()`, `parseInstanceConfig()`, `safeErrorMessage()` |
| `src/shared/permission.ts` | Permission ID generation/validation, inline keyboard formatting, text verdict parsing, auto-approve logic |
| `src/shared/threads.ts` | ThreadTracker class — per-session reply_to_message_id state machine |
| `src/hub/telegram-client.ts` | grammy bot setup, long polling, message filtering (chat ID + user allowlist + bot self-filter), dedup |
| `src/hub/router.ts` | Session registry (name → socket), prefix parsing, smart routing (single/multi), outbound prefixing |
| `src/hub/hub.ts` | Hub entry point — TCP server, grammy integration, permission relay, PID file, idle timeout, graceful shutdown |
| `src/instance/channel-bridge.ts` | Format inbound IPC messages as MCP ChannelNotificationParams |
| `src/instance/hub-client.ts` | TCP client to hub, auto-start logic, reconnection with backoff, message buffering |
| `src/instance/server.ts` | MCP server, reply tool, permission handler, CLI entry point |
| `package.json` | Package config with two bin entries |
| `tsconfig.json` | Strict TypeScript config for Bun |
| `biome.json` | Linter/formatter config |
| `.env.example` | Placeholder env vars |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `biome.json`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "claude-telegram-channel",
  "version": "0.1.0",
  "description": "Claude Code Channel MCP server for Telegram — bidirectional interactive bridge with multi-session hub",
  "type": "module",
  "bin": {
    "claude-telegram-channel": "src/instance/server.ts",
    "claude-telegram-hub": "src/hub/hub.ts"
  },
  "engines": {
    "bun": ">=1.2.0"
  },
  "scripts": {
    "dev:hub": "bun run src/hub/hub.ts",
    "dev:instance": "bun run src/instance/server.ts",
    "test": "bun test",
    "test:coverage": "bun test --coverage",
    "typecheck": "bunx tsc --noEmit",
    "lint": "bunx biome check .",
    "lint:fix": "bunx biome check --write ."
  },
  "files": [
    "src",
    "!src/__tests__",
    "README.md",
    "LICENSE",
    ".env.example"
  ],
  "license": "MIT",
  "publishConfig": {
    "access": "public"
  },
  "keywords": [
    "claude-code",
    "mcp",
    "telegram",
    "channel",
    "mcp-server",
    "automation"
  ],
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.28.0",
    "grammy": "^1.35.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.9",
    "@types/bun": "1.3.11",
    "typescript": "6.0.2"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "$schema": "https://www.schemastore.org/tsconfig",
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["bun-types"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create biome.json**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.9/schema.json",
  "files": { "includes": ["src/**", "*.ts", "*.json"] },
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingCommas": "all",
      "semicolons": "asNeeded"
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "warn" }
    }
  },
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true }
}
```

- [ ] **Step 4: Create .env.example**

```bash
# Bot token from @BotFather (https://t.me/BotFather)
TELEGRAM_BOT_TOKEN=7123456789:ABCdefGHIjklMNOpqrSTUvwxYZ

# Target chat ID — use @userinfobot or @RawDataBot to find yours
# Positive for private chats, negative for groups (e.g., -100123456789)
TELEGRAM_CHAT_ID=-100123456789

# Comma-separated Telegram user IDs allowed to interact
# Use @userinfobot to find your user ID
ALLOWED_USER_IDS=123456789

# Session name for multi-session routing (default: claude)
SERVER_NAME=claude

# Hub TCP port (default: 4100)
HUB_PORT=4100

# Hub address — change for cross-VM setups (default: 127.0.0.1)
HUB_HOST=127.0.0.1

# Hub idle timeout before self-shutdown (default: 30m, 0 = never)
HUB_IDLE_TIMEOUT=30m

# Auto-approve all permission requests (default: false)
AUTO_APPROVE=false

# Comma-separated tool names to auto-approve (e.g., Bash,Write,Edit)
# AUTO_APPROVE_TOOLS=
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
.superpowers/
*.tgz
.env
.env.local
```

- [ ] **Step 6: Install dependencies**

Run: `bun install`
Expected: lockfile created, node_modules populated, no errors

- [ ] **Step 7: Verify typecheck and lint work**

Run: `bunx tsc --noEmit && bunx biome check .`
Expected: both pass (no source files yet, but config is valid)

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json biome.json .env.example .gitignore bun.lock
git commit -m "chore: scaffold project with bun, typescript, biome, grammy, mcp sdk"
```

---

### Task 2: Shared Types and IPC Protocol

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/protocol.ts`
- Create: `src/__tests__/protocol.test.ts`

- [ ] **Step 1: Write the failing test for protocol message parsing**

```typescript
// src/__tests__/protocol.test.ts
import { describe, expect, it } from 'bun:test'
import {
  type HubToInstance,
  type InstanceToHub,
  parseHubToInstance,
  parseInstanceToHub,
  serializeMessage,
} from '../shared/protocol.ts'

describe('serializeMessage', () => {
  it('serializes a message to a newline-delimited JSON string', () => {
    const msg: InstanceToHub = { type: 'register', name: 'web-deploy' }
    expect(serializeMessage(msg)).toBe('{"type":"register","name":"web-deploy"}\n')
  })
})

describe('parseInstanceToHub', () => {
  it('parses a register message', () => {
    const result = parseInstanceToHub('{"type":"register","name":"web-deploy"}')
    expect(result).toEqual({ type: 'register', name: 'web-deploy' })
  })

  it('parses a reply message', () => {
    const result = parseInstanceToHub('{"type":"reply","text":"hello"}')
    expect(result).toEqual({ type: 'reply', text: 'hello' })
  })

  it('parses a reply with reply_to_message_id', () => {
    const result = parseInstanceToHub('{"type":"reply","text":"hello","reply_to_message_id":42}')
    expect(result).toEqual({ type: 'reply', text: 'hello', reply_to_message_id: 42 })
  })

  it('parses a permission_request message', () => {
    const result = parseInstanceToHub(JSON.stringify({
      type: 'permission_request',
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'rm -rf dist',
      input_preview: 'rm -rf dist',
    }))
    expect(result).toEqual({
      type: 'permission_request',
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'rm -rf dist',
      input_preview: 'rm -rf dist',
    })
  })

  it('parses a deregister message', () => {
    const result = parseInstanceToHub('{"type":"deregister"}')
    expect(result).toEqual({ type: 'deregister' })
  })

  it('returns null for invalid JSON', () => {
    expect(parseInstanceToHub('not json')).toBeNull()
  })

  it('returns null for unknown message type', () => {
    expect(parseInstanceToHub('{"type":"unknown"}')).toBeNull()
  })
})

describe('parseHubToInstance', () => {
  it('parses a registered message', () => {
    const result = parseHubToInstance('{"type":"registered","name":"web-deploy"}')
    expect(result).toEqual({ type: 'registered', name: 'web-deploy' })
  })

  it('parses a register_error message', () => {
    const result = parseHubToInstance('{"type":"register_error","reason":"name taken"}')
    expect(result).toEqual({ type: 'register_error', reason: 'name taken' })
  })

  it('parses a message message', () => {
    const result = parseHubToInstance(JSON.stringify({
      type: 'message',
      text: 'fix the tests',
      user_id: 123456,
      message_id: 789,
    }))
    expect(result).toEqual({
      type: 'message',
      text: 'fix the tests',
      user_id: 123456,
      message_id: 789,
    })
  })

  it('parses a message with reply_to_message_id', () => {
    const result = parseHubToInstance(JSON.stringify({
      type: 'message',
      text: 'in thread',
      user_id: 123456,
      message_id: 790,
      reply_to_message_id: 789,
    }))
    expect(result?.type).toBe('message')
    if (result?.type === 'message') {
      expect(result.reply_to_message_id).toBe(789)
    }
  })

  it('parses a permission_verdict message', () => {
    const result = parseHubToInstance('{"type":"permission_verdict","request_id":"abcde","behavior":"allow"}')
    expect(result).toEqual({ type: 'permission_verdict', request_id: 'abcde', behavior: 'allow' })
  })

  it('parses a deregistered message', () => {
    const result = parseHubToInstance('{"type":"deregistered"}')
    expect(result).toEqual({ type: 'deregistered' })
  })

  it('returns null for invalid JSON', () => {
    expect(parseHubToInstance('garbage')).toBeNull()
  })

  it('rejects invalid behavior value', () => {
    expect(parseHubToInstance('{"type":"permission_verdict","request_id":"abcde","behavior":"maybe"}')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/protocol.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Create types.ts**

```typescript
// src/shared/types.ts
export interface HubConfig {
  telegramBotToken: string
  telegramChatId: number
  allowedUserIds: number[]
  hubPort: number
  hubHost: string
  hubIdleTimeout: number // milliseconds, 0 = never
}

export interface InstanceConfig {
  telegramBotToken: string
  telegramChatId: number
  allowedUserIds: number[]
  serverName: string
  hubPort: number
  hubHost: string
  hubIdleTimeout: number
  autoApprove: boolean
  autoApproveTools: string[]
}

export interface PermissionRequest {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export interface PermissionVerdict {
  request_id: string
  behavior: 'allow' | 'deny'
}
```

- [ ] **Step 4: Create protocol.ts**

```typescript
// src/shared/protocol.ts
import { z } from 'zod'

// Instance → Hub messages
const RegisterSchema = z.object({ type: z.literal('register'), name: z.string() })
const ReplySchema = z.object({
  type: z.literal('reply'),
  text: z.string(),
  reply_to_message_id: z.number().optional(),
  start_thread: z.boolean().optional(),
})
const PermissionRequestIpcSchema = z.object({
  type: z.literal('permission_request'),
  request_id: z.string(),
  tool_name: z.string(),
  description: z.string(),
  input_preview: z.string(),
})
const DeregisterSchema = z.object({ type: z.literal('deregister') })

const InstanceToHubSchema = z.discriminatedUnion('type', [
  RegisterSchema,
  ReplySchema,
  PermissionRequestIpcSchema,
  DeregisterSchema,
])

// Hub → Instance messages
const RegisteredSchema = z.object({ type: z.literal('registered'), name: z.string() })
const RegisterErrorSchema = z.object({ type: z.literal('register_error'), reason: z.string() })
const MessageSchema = z.object({
  type: z.literal('message'),
  text: z.string(),
  user_id: z.number(),
  message_id: z.number(),
  reply_to_message_id: z.number().optional(),
})
const PermissionVerdictIpcSchema = z.object({
  type: z.literal('permission_verdict'),
  request_id: z.string(),
  behavior: z.enum(['allow', 'deny']),
})
const DeregisteredSchema = z.object({ type: z.literal('deregistered') })

const HubToInstanceSchema = z.discriminatedUnion('type', [
  RegisteredSchema,
  RegisterErrorSchema,
  MessageSchema,
  PermissionVerdictIpcSchema,
  DeregisteredSchema,
])

export type InstanceToHub = z.infer<typeof InstanceToHubSchema>
export type HubToInstance = z.infer<typeof HubToInstanceSchema>

export function serializeMessage(msg: InstanceToHub | HubToInstance): string {
  return `${JSON.stringify(msg)}\n`
}

export function parseInstanceToHub(raw: string): InstanceToHub | null {
  try {
    const json = JSON.parse(raw)
    const result = InstanceToHubSchema.safeParse(json)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function parseHubToInstance(raw: string): HubToInstance | null {
  try {
    const json = JSON.parse(raw)
    const result = HubToInstanceSchema.safeParse(json)
    return result.success ? result.data : null
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/__tests__/protocol.test.ts`
Expected: all 14 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/protocol.ts src/__tests__/protocol.test.ts
git commit -m "feat: add shared types and IPC protocol with Zod validation"
```

---

### Task 3: Configuration Parsing

**Files:**
- Create: `src/shared/config.ts`
- Create: `src/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/config.test.ts
import { describe, expect, it, spyOn } from 'bun:test'
import { parseDuration, parseHubConfig, parseInstanceConfig, safeErrorMessage } from '../shared/config.ts'

describe('parseHubConfig', () => {
  const validEnv = {
    TELEGRAM_BOT_TOKEN: '7123456789:ABCdefGHIjklMNOpqrSTUvwxYZ',
    TELEGRAM_CHAT_ID: '-100123456789',
    ALLOWED_USER_IDS: '123456789',
    HUB_PORT: '4100',
    HUB_HOST: '127.0.0.1',
    HUB_IDLE_TIMEOUT: '30m',
  }

  it('parses valid env into HubConfig', () => {
    const config = parseHubConfig(validEnv)
    expect(config.telegramBotToken).toBe('7123456789:ABCdefGHIjklMNOpqrSTUvwxYZ')
    expect(config.telegramChatId).toBe(-100123456789)
    expect(config.allowedUserIds).toEqual([123456789])
    expect(config.hubPort).toBe(4100)
    expect(config.hubHost).toBe('127.0.0.1')
    expect(config.hubIdleTimeout).toBe(1800000) // 30 minutes in ms
  })

  it('uses defaults for optional fields', () => {
    const config = parseHubConfig({
      TELEGRAM_BOT_TOKEN: '7123456789:ABCdefGHIjklMNOpqrSTUvwxYZ',
      TELEGRAM_CHAT_ID: '-100123456789',
      ALLOWED_USER_IDS: '123456789',
    })
    expect(config.hubPort).toBe(4100)
    expect(config.hubHost).toBe('127.0.0.1')
    expect(config.hubIdleTimeout).toBe(1800000)
  })

  it('parses multiple comma-separated user IDs', () => {
    const config = parseHubConfig({ ...validEnv, ALLOWED_USER_IDS: '111,222, 333' })
    expect(config.allowedUserIds).toEqual([111, 222, 333])
  })

  it('throws on invalid bot token', () => {
    expect(() => parseHubConfig({ ...validEnv, TELEGRAM_BOT_TOKEN: 'bad-token' })).toThrow()
  })

  it('throws on missing TELEGRAM_CHAT_ID', () => {
    const { TELEGRAM_CHAT_ID: _, ...missing } = validEnv
    expect(() => parseHubConfig(missing)).toThrow()
  })

  it('throws on empty ALLOWED_USER_IDS', () => {
    expect(() => parseHubConfig({ ...validEnv, ALLOWED_USER_IDS: '' })).toThrow()
  })

  it('throws on non-numeric user ID', () => {
    expect(() => parseHubConfig({ ...validEnv, ALLOWED_USER_IDS: 'abc' })).toThrow()
  })

  it('parses positive chat ID for private chats', () => {
    const config = parseHubConfig({ ...validEnv, TELEGRAM_CHAT_ID: '123456789' })
    expect(config.telegramChatId).toBe(123456789)
  })
})

describe('parseInstanceConfig', () => {
  const validEnv = {
    TELEGRAM_BOT_TOKEN: '7123456789:ABCdefGHIjklMNOpqrSTUvwxYZ',
    TELEGRAM_CHAT_ID: '-100123456789',
    ALLOWED_USER_IDS: '123456789',
    SERVER_NAME: 'web-deploy',
  }

  it('parses valid env into InstanceConfig', () => {
    const config = parseInstanceConfig(validEnv)
    expect(config.serverName).toBe('web-deploy')
    expect(config.autoApprove).toBe(false)
    expect(config.autoApproveTools).toEqual([])
  })

  it('defaults SERVER_NAME to "claude"', () => {
    const { SERVER_NAME: _, ...env } = validEnv
    const config = parseInstanceConfig(env)
    expect(config.serverName).toBe('claude')
  })

  it('parses AUTO_APPROVE=true', () => {
    const config = parseInstanceConfig({ ...validEnv, AUTO_APPROVE: 'true' })
    expect(config.autoApprove).toBe(true)
  })

  it('parses AUTO_APPROVE_TOOLS', () => {
    const config = parseInstanceConfig({ ...validEnv, AUTO_APPROVE_TOOLS: 'Bash,Write, Edit' })
    expect(config.autoApproveTools).toEqual(['Bash', 'Write', 'Edit'])
  })

  it('throws on invalid SERVER_NAME with spaces', () => {
    expect(() => parseInstanceConfig({ ...validEnv, SERVER_NAME: 'bad name' })).toThrow()
  })

  it('throws on SERVER_NAME longer than 64 chars', () => {
    expect(() => parseInstanceConfig({ ...validEnv, SERVER_NAME: 'a'.repeat(65) })).toThrow()
  })
})

describe('parseDuration', () => {
  it('parses minutes', () => {
    expect(parseDuration('30m')).toBe(1800000)
  })

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3600000)
  })

  it('parses seconds', () => {
    expect(parseDuration('90s')).toBe(90000)
  })

  it('parses 0 as disabled', () => {
    expect(parseDuration('0')).toBe(0)
  })

  it('throws on invalid format', () => {
    expect(() => parseDuration('abc')).toThrow()
  })
})

describe('safeErrorMessage', () => {
  it('redacts bot tokens from error messages', () => {
    const err = new Error('failed with token 7123456789:ABCdefGHIjkl')
    expect(safeErrorMessage(err)).toBe('failed with token [REDACTED]')
  })

  it('handles non-Error values', () => {
    expect(safeErrorMessage('string error')).toBe('string error')
  })

  it('handles null', () => {
    expect(safeErrorMessage(null)).toBe('null')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write config.ts**

```typescript
// src/shared/config.ts
import { z } from 'zod'
import type { HubConfig, InstanceConfig } from './types.ts'

const TELEGRAM_BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/

const BaseConfigSchema = z.object({
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
  HUB_PORT: z
    .string()
    .default('4100')
    .transform((s) => {
      const n = Number(s)
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('HUB_PORT must be 1-65535')
      return n
    }),
  HUB_HOST: z.string().min(1).default('127.0.0.1'),
  HUB_IDLE_TIMEOUT: z
    .string()
    .default('30m')
    .transform((s) => parseDuration(s)),
})

const InstanceExtrasSchema = z.object({
  SERVER_NAME: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/, 'SERVER_NAME must be alphanumeric with hyphens/underscores, 1-64 chars')
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
})

export function parseDuration(s: string): number {
  if (s === '0') return 0
  const match = s.match(/^(\d+)(s|m|h)$/)
  if (!match?.[1] || !match[2]) throw new Error(`Invalid duration: "${s}" (expected e.g. 30m, 1h, 90s, or 0)`)
  const value = Number(match[1])
  const unit = match[2]
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000 }
  return value * (multipliers[unit] ?? 0)
}

export function parseHubConfig(env: Record<string, string | undefined>): HubConfig {
  const result = BaseConfigSchema.parse(env)
  return {
    telegramBotToken: result.TELEGRAM_BOT_TOKEN,
    telegramChatId: result.TELEGRAM_CHAT_ID,
    allowedUserIds: result.ALLOWED_USER_IDS,
    hubPort: result.HUB_PORT,
    hubHost: result.HUB_HOST,
    hubIdleTimeout: result.HUB_IDLE_TIMEOUT,
  }
}

export function parseInstanceConfig(env: Record<string, string | undefined>): InstanceConfig {
  const base = BaseConfigSchema.parse(env)
  const extras = InstanceExtrasSchema.parse(env)
  return {
    telegramBotToken: base.TELEGRAM_BOT_TOKEN,
    telegramChatId: base.TELEGRAM_CHAT_ID,
    allowedUserIds: base.ALLOWED_USER_IDS,
    hubPort: base.HUB_PORT,
    hubHost: base.HUB_HOST,
    hubIdleTimeout: base.HUB_IDLE_TIMEOUT,
    serverName: extras.SERVER_NAME,
    autoApprove: extras.AUTO_APPROVE,
    autoApproveTools: extras.AUTO_APPROVE_TOOLS,
  }
}

export function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\d+:[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/config.test.ts`
Expected: all 18 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/config.ts src/__tests__/config.test.ts
git commit -m "feat: add config parsing with Zod validation and token redaction"
```

---

### Task 4: Thread Tracker

**Files:**
- Create: `src/shared/threads.ts`
- Create: `src/__tests__/threads.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/threads.test.ts
import { describe, expect, it } from 'bun:test'
import { ThreadTracker } from '../shared/threads.ts'

describe('ThreadTracker', () => {
  it('starts with null active message ID', () => {
    const tracker = new ThreadTracker()
    expect(tracker.activeMessageId).toBeNull()
  })

  it('startThread sets active message ID', () => {
    const tracker = new ThreadTracker()
    tracker.startThread(42)
    expect(tracker.activeMessageId).toBe(42)
  })

  it('abandon resets to null', () => {
    const tracker = new ThreadTracker()
    tracker.startThread(42)
    tracker.abandon()
    expect(tracker.activeMessageId).toBeNull()
  })

  it('classifyMessage returns new_input for undefined reply_to', () => {
    const tracker = new ThreadTracker()
    tracker.startThread(42)
    expect(tracker.classifyMessage(undefined)).toBe('new_input')
  })

  it('classifyMessage returns thread_reply for matching message ID', () => {
    const tracker = new ThreadTracker()
    tracker.startThread(42)
    expect(tracker.classifyMessage(42)).toBe('thread_reply')
  })

  it('classifyMessage returns new_input for non-matching message ID', () => {
    const tracker = new ThreadTracker()
    tracker.startThread(42)
    expect(tracker.classifyMessage(99)).toBe('new_input')
  })

  it('classifyMessage returns new_input when no active thread', () => {
    const tracker = new ThreadTracker()
    expect(tracker.classifyMessage(42)).toBe('new_input')
  })

  it('second startThread replaces the first', () => {
    const tracker = new ThreadTracker()
    tracker.startThread(42)
    tracker.startThread(99)
    expect(tracker.activeMessageId).toBe(99)
    expect(tracker.classifyMessage(42)).toBe('new_input')
    expect(tracker.classifyMessage(99)).toBe('thread_reply')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/threads.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write threads.ts**

```typescript
// src/shared/threads.ts
export type MessageClassification = 'thread_reply' | 'new_input'

export class ThreadTracker {
  private _activeMessageId: number | null = null

  get activeMessageId(): number | null {
    return this._activeMessageId
  }

  startThread(messageId: number): void {
    this._activeMessageId = messageId
  }

  abandon(): void {
    this._activeMessageId = null
  }

  classifyMessage(replyToMessageId: number | undefined): MessageClassification {
    if (replyToMessageId === undefined) return 'new_input'
    if (replyToMessageId === this._activeMessageId) return 'thread_reply'
    return 'new_input'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/threads.test.ts`
Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/threads.ts src/__tests__/threads.test.ts
git commit -m "feat: add ThreadTracker for per-session reply thread state"
```

---

### Task 5: Permission System

**Files:**
- Create: `src/shared/permission.ts`
- Create: `src/__tests__/permission.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/permission.test.ts
import { describe, expect, it } from 'bun:test'
import {
  formatPermissionInlineKeyboard,
  formatPermissionResult,
  formatPermissionText,
  generatePermissionId,
  PERMISSION_ID_RE,
  parseButtonCallback,
  parsePermissionReply,
  shouldAutoApprove,
} from '../shared/permission.ts'
import type { PermissionRequest } from '../shared/types.ts'

describe('generatePermissionId', () => {
  it('generates a 5-character string', () => {
    const id = generatePermissionId()
    expect(id).toHaveLength(5)
  })

  it('matches the permission ID pattern', () => {
    const id = generatePermissionId()
    expect(PERMISSION_ID_RE.test(id)).toBe(true)
  })

  it('does not contain the letter l', () => {
    // Generate many IDs to be confident
    for (let i = 0; i < 100; i++) {
      expect(generatePermissionId()).not.toContain('l')
    }
  })
})

describe('parsePermissionReply', () => {
  it('parses "yes abcde"', () => {
    const result = parsePermissionReply('yes abcde')
    expect(result).toEqual({ request_id: 'abcde', behavior: 'allow' })
  })

  it('parses "no fghij"', () => {
    const result = parsePermissionReply('no fghij')
    expect(result).toEqual({ request_id: 'fghij', behavior: 'deny' })
  })

  it('parses "y abcde" shorthand', () => {
    const result = parsePermissionReply('y abcde')
    expect(result).toEqual({ request_id: 'abcde', behavior: 'allow' })
  })

  it('parses "n abcde" shorthand', () => {
    const result = parsePermissionReply('n abcde')
    expect(result).toEqual({ request_id: 'abcde', behavior: 'deny' })
  })

  it('is case-insensitive', () => {
    expect(parsePermissionReply('YES abcde')).toEqual({ request_id: 'abcde', behavior: 'allow' })
  })

  it('handles whitespace', () => {
    expect(parsePermissionReply('  yes  abcde  ')).toEqual({ request_id: 'abcde', behavior: 'allow' })
  })

  it('returns null for non-verdict text', () => {
    expect(parsePermissionReply('hello world')).toBeNull()
  })

  it('returns null for ID containing l', () => {
    expect(parsePermissionReply('yes abcle')).toBeNull()
  })

  it('returns null for wrong ID length', () => {
    expect(parsePermissionReply('yes abc')).toBeNull()
    expect(parsePermissionReply('yes abcdef')).toBeNull()
  })
})

describe('parseButtonCallback', () => {
  it('parses approve callback', () => {
    const result = parseButtonCallback('permission_approve_abcde')
    expect(result).toEqual({ request_id: 'abcde', behavior: 'allow' })
  })

  it('parses deny callback', () => {
    const result = parseButtonCallback('permission_deny_abcde')
    expect(result).toEqual({ request_id: 'abcde', behavior: 'deny' })
  })

  it('returns null for unrelated callback', () => {
    expect(parseButtonCallback('something_else')).toBeNull()
  })

  it('returns null for invalid ID', () => {
    expect(parseButtonCallback('permission_approve_abc')).toBeNull()
  })
})

describe('formatPermissionText', () => {
  const req: PermissionRequest = {
    request_id: 'abcde',
    tool_name: 'Bash',
    description: 'rm -rf dist',
    input_preview: 'rm -rf dist',
  }

  it('includes request_id', () => {
    const text = formatPermissionText(req, 'web-deploy')
    expect(text).toContain('abcde')
  })

  it('includes tool name', () => {
    const text = formatPermissionText(req, 'web-deploy')
    expect(text).toContain('Bash')
  })

  it('includes session name', () => {
    const text = formatPermissionText(req, 'web-deploy')
    expect(text).toContain('web-deploy')
  })

  it('includes description', () => {
    const text = formatPermissionText(req, 'web-deploy')
    expect(text).toContain('rm -rf dist')
  })

  it('handles empty input_preview', () => {
    const noPreview = { ...req, input_preview: '' }
    const text = formatPermissionText(noPreview, 'web-deploy')
    expect(text).not.toContain('```')
  })
})

describe('formatPermissionInlineKeyboard', () => {
  it('returns approve and deny buttons with correct callback_data', () => {
    const keyboard = formatPermissionInlineKeyboard('abcde')
    expect(keyboard.inline_keyboard).toHaveLength(1)
    expect(keyboard.inline_keyboard[0]).toHaveLength(2)
    expect(keyboard.inline_keyboard[0]?.[0]?.callback_data).toBe('permission_approve_abcde')
    expect(keyboard.inline_keyboard[0]?.[1]?.callback_data).toBe('permission_deny_abcde')
  })
})

describe('formatPermissionResult', () => {
  const req: PermissionRequest = {
    request_id: 'abcde',
    tool_name: 'Bash',
    description: 'rm -rf dist',
    input_preview: '',
  }

  it('shows approved with user ID', () => {
    const text = formatPermissionResult(req, 123456, true, 'web-deploy')
    expect(text).toContain('Approved')
    expect(text).toContain('123456')
  })

  it('shows denied with user ID', () => {
    const text = formatPermissionResult(req, 123456, false, 'web-deploy')
    expect(text).toContain('Denied')
  })
})

describe('shouldAutoApprove', () => {
  it('returns true when autoApprove is true', () => {
    expect(shouldAutoApprove('Bash', true, [])).toBe(true)
  })

  it('returns true when tool is in autoApproveTools', () => {
    expect(shouldAutoApprove('Bash', false, ['Bash', 'Write'])).toBe(true)
  })

  it('returns false when tool is not in autoApproveTools', () => {
    expect(shouldAutoApprove('Bash', false, ['Write'])).toBe(false)
  })

  it('returns false when no auto-approve configured', () => {
    expect(shouldAutoApprove('Bash', false, [])).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/permission.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write permission.ts**

```typescript
// src/shared/permission.ts
import type { PermissionRequest, PermissionVerdict } from './types.ts'

// 5 lowercase letters from a-z excluding 'l' (mobile readability)
const PERMISSION_CHARS = 'abcdefghijkmnopqrstuvwxyz'
export const PERMISSION_ID_PATTERN = '[a-km-z]{5}'
export const PERMISSION_ID_RE = new RegExp(`^${PERMISSION_ID_PATTERN}$`)

const PERMISSION_REPLY_RE = new RegExp(`^\\s*(y|yes|n|no)\\s+(${PERMISSION_ID_PATTERN})\\s*$`, 'i')
const BUTTON_CALLBACK_RE = new RegExp(`^permission_(approve|deny)_(${PERMISSION_ID_PATTERN})$`)

export function generatePermissionId(): string {
  let id = ''
  for (let i = 0; i < 5; i++) {
    id += PERMISSION_CHARS[Math.floor(Math.random() * PERMISSION_CHARS.length)]
  }
  return id
}

export function parsePermissionReply(text: string): PermissionVerdict | null {
  const match = text.match(PERMISSION_REPLY_RE)
  if (!match?.[1] || !match[2]) return null
  const verdict = match[1].toLowerCase()
  return {
    request_id: match[2].toLowerCase(),
    behavior: verdict === 'y' || verdict === 'yes' ? 'allow' : 'deny',
  }
}

export function parseButtonCallback(callbackData: string): PermissionVerdict | null {
  const match = callbackData.match(BUTTON_CALLBACK_RE)
  if (!match?.[1] || !match[2]) return null
  return {
    request_id: match[2],
    behavior: match[1] === 'approve' ? 'allow' : 'deny',
  }
}

export function formatPermissionText(req: PermissionRequest, sessionName: string): string {
  const lines = [
    `🔒 *Permission Request* \`${req.request_id}\``,
    `\\[${sessionName}\\] *Tool:* \`${req.tool_name}\``,
    `*Action:* ${req.description}`,
  ]
  if (req.input_preview) {
    lines.push(`\`\`\`\n${req.input_preview}\n\`\`\``)
  }
  lines.push(`Reply \`yes ${req.request_id}\` or \`no ${req.request_id}\``)
  return lines.join('\n')
}

export function formatPermissionInlineKeyboard(requestId: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
} {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `permission_approve_${requestId}` },
        { text: '❌ Deny', callback_data: `permission_deny_${requestId}` },
      ],
    ],
  }
}

export function formatPermissionResult(
  req: PermissionRequest,
  userId: number,
  approved: boolean,
  sessionName: string,
): string {
  const emoji = approved ? '✅' : '❌'
  const action = approved ? 'Approved' : 'Denied'
  const lines = [
    `🔒 *Permission Request* \`${req.request_id}\``,
    `\\[${sessionName}\\] *Tool:* \`${req.tool_name}\``,
    `*Action:* ${req.description}`,
    '',
    `${emoji} ${action} by user ${userId}`,
  ]
  return lines.join('\n')
}

export function shouldAutoApprove(
  toolName: string,
  autoApprove: boolean,
  autoApproveTools: string[],
): boolean {
  if (autoApprove) return true
  if (autoApproveTools.includes(toolName)) return true
  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/permission.test.ts`
Expected: all 22 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/permission.ts src/__tests__/permission.test.ts
git commit -m "feat: add permission system with inline keyboards and auto-approve"
```

---

### Task 6: Channel Bridge

**Files:**
- Create: `src/instance/channel-bridge.ts`
- Create: `src/__tests__/channel-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/channel-bridge.test.ts
import { describe, expect, it } from 'bun:test'
import {
  type ChannelNotificationParams,
  formatInboundNotification,
} from '../instance/channel-bridge.ts'
import type { HubToInstance } from '../shared/protocol.ts'

describe('formatInboundNotification', () => {
  const baseMessage = {
    type: 'message' as const,
    text: 'Hello Claude',
    user_id: 123456,
    message_id: 789,
  }

  it('formats a top-level message with correct content and meta', () => {
    const result: ChannelNotificationParams = formatInboundNotification(baseMessage)
    expect(result.content).toBe('Hello Claude')
    expect(result.source).toBe('telegram')
    expect(result.meta?.user_id).toBe('123456')
    expect(result.meta?.message_id).toBe('789')
    expect(result.meta?.reply_to_message_id).toBeUndefined()
  })

  it('includes reply_to_message_id in meta when present', () => {
    const threaded = { ...baseMessage, reply_to_message_id: 788 }
    const result = formatInboundNotification(threaded)
    expect(result.meta?.reply_to_message_id).toBe('788')
  })

  it('all meta keys use underscores — no hyphens', () => {
    const threaded = { ...baseMessage, reply_to_message_id: 788 }
    const result = formatInboundNotification(threaded)
    const keys = Object.keys(result.meta ?? {})
    expect(keys.filter((k) => k.includes('-'))).toHaveLength(0)
  })

  it('handles empty text', () => {
    const empty = { ...baseMessage, text: '' }
    const result = formatInboundNotification(empty)
    expect(result.content).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/channel-bridge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write channel-bridge.ts**

```typescript
// src/instance/channel-bridge.ts
import type { HubToInstance } from '../shared/protocol.ts'

export interface ChannelNotificationParams {
  content: string
  source?: string
  meta?: Record<string, string>
}

type InboundMessage = Extract<HubToInstance, { type: 'message' }>

export function formatInboundNotification(msg: InboundMessage): ChannelNotificationParams {
  const meta: Record<string, string> = {
    user_id: String(msg.user_id),
    message_id: String(msg.message_id),
  }
  if (msg.reply_to_message_id !== undefined) {
    meta.reply_to_message_id = String(msg.reply_to_message_id)
  }
  return { content: msg.text, source: 'telegram', meta }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/channel-bridge.test.ts`
Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/instance/channel-bridge.ts src/__tests__/channel-bridge.test.ts
git commit -m "feat: add channel bridge for formatting inbound Telegram messages"
```

---

### Task 7: Hub Router

**Files:**
- Create: `src/hub/router.ts`
- Create: `src/__tests__/router.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/router.test.ts
import { describe, expect, it } from 'bun:test'
import { parsePrefix, SessionRegistry } from '../hub/router.ts'

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

  it('handles message starting with @ but invalid session name chars', () => {
    expect(parsePrefix('@bad session fix it')).toBeNull()
  })
})

describe('SessionRegistry', () => {
  it('starts empty', () => {
    const registry = new SessionRegistry()
    expect(registry.count).toBe(0)
    expect(registry.names).toEqual([])
  })

  it('registers a session', () => {
    const registry = new SessionRegistry()
    const ok = registry.register('web-deploy', { id: 'socket1' } as any)
    expect(ok).toBe(true)
    expect(registry.count).toBe(1)
    expect(registry.names).toEqual(['web-deploy'])
  })

  it('rejects duplicate session name', () => {
    const registry = new SessionRegistry()
    registry.register('web-deploy', { id: 'socket1' } as any)
    const ok = registry.register('web-deploy', { id: 'socket2' } as any)
    expect(ok).toBe(false)
    expect(registry.count).toBe(1)
  })

  it('deregisters a session', () => {
    const registry = new SessionRegistry()
    registry.register('web-deploy', { id: 'socket1' } as any)
    registry.deregister('web-deploy')
    expect(registry.count).toBe(0)
  })

  it('gets socket by name', () => {
    const registry = new SessionRegistry()
    const socket = { id: 'socket1' } as any
    registry.register('web-deploy', socket)
    expect(registry.getSocket('web-deploy')).toBe(socket)
  })

  it('returns undefined for unknown name', () => {
    const registry = new SessionRegistry()
    expect(registry.getSocket('unknown')).toBeUndefined()
  })

  it('gets name by socket', () => {
    const registry = new SessionRegistry()
    const socket = { id: 'socket1' } as any
    registry.register('web-deploy', socket)
    expect(registry.getNameBySocket(socket)).toBe('web-deploy')
  })

  it('deregisters by socket', () => {
    const registry = new SessionRegistry()
    const socket = { id: 'socket1' } as any
    registry.register('web-deploy', socket)
    const name = registry.deregisterBySocket(socket)
    expect(name).toBe('web-deploy')
    expect(registry.count).toBe(0)
  })

  it('route returns the only session when count is 1 and no prefix', () => {
    const registry = new SessionRegistry()
    const socket = { id: 'socket1' } as any
    registry.register('web-deploy', socket)
    const result = registry.route(null)
    expect(result).toEqual({ type: 'routed', name: 'web-deploy', socket })
  })

  it('route returns ambiguous when count > 1 and no prefix', () => {
    const registry = new SessionRegistry()
    registry.register('web-deploy', { id: '1' } as any)
    registry.register('api-refactor', { id: '2' } as any)
    const result = registry.route(null)
    expect(result.type).toBe('ambiguous')
    if (result.type === 'ambiguous') {
      expect(result.names.sort()).toEqual(['api-refactor', 'web-deploy'])
    }
  })

  it('route returns no_sessions when empty and no prefix', () => {
    const registry = new SessionRegistry()
    const result = registry.route(null)
    expect(result).toEqual({ type: 'no_sessions' })
  })

  it('route returns routed for valid prefix', () => {
    const registry = new SessionRegistry()
    const socket = { id: '1' } as any
    registry.register('web-deploy', socket)
    registry.register('api-refactor', { id: '2' } as any)
    const result = registry.route('web-deploy')
    expect(result).toEqual({ type: 'routed', name: 'web-deploy', socket })
  })

  it('route returns not_found for unknown prefix', () => {
    const registry = new SessionRegistry()
    registry.register('web-deploy', { id: '1' } as any)
    const result = registry.route('unknown')
    expect(result.type).toBe('not_found')
    if (result.type === 'not_found') {
      expect(result.name).toBe('unknown')
      expect(result.available).toEqual(['web-deploy'])
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/router.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write router.ts**

```typescript
// src/hub/router.ts
import type { Socket } from 'node:net'

const PREFIX_RE = /^@([a-zA-Z0-9_-]+)\s+(.+)$/s

export function parsePrefix(text: string): { name: string; body: string } | null {
  const match = text.match(PREFIX_RE)
  if (!match?.[1] || !match[2]) return null
  const body = match[2].trim()
  if (!body) return null
  return { name: match[1], body }
}

export type RouteResult =
  | { type: 'routed'; name: string; socket: Socket }
  | { type: 'ambiguous'; names: string[] }
  | { type: 'not_found'; name: string; available: string[] }
  | { type: 'no_sessions' }

export class SessionRegistry {
  private sessions = new Map<string, Socket>()
  private socketToName = new Map<Socket, string>()

  get count(): number {
    return this.sessions.size
  }

  get names(): string[] {
    return [...this.sessions.keys()]
  }

  register(name: string, socket: Socket): boolean {
    if (this.sessions.has(name)) return false
    this.sessions.set(name, socket)
    this.socketToName.set(socket, name)
    return true
  }

  deregister(name: string): void {
    const socket = this.sessions.get(name)
    if (socket) {
      this.socketToName.delete(socket)
    }
    this.sessions.delete(name)
  }

  deregisterBySocket(socket: Socket): string | undefined {
    const name = this.socketToName.get(socket)
    if (name) {
      this.sessions.delete(name)
      this.socketToName.delete(socket)
    }
    return name
  }

  getSocket(name: string): Socket | undefined {
    return this.sessions.get(name)
  }

  getNameBySocket(socket: Socket): string | undefined {
    return this.socketToName.get(socket)
  }

  route(targetName: string | null): RouteResult {
    if (targetName !== null) {
      const socket = this.sessions.get(targetName)
      if (socket) return { type: 'routed', name: targetName, socket }
      return { type: 'not_found', name: targetName, available: this.names }
    }

    if (this.sessions.size === 0) return { type: 'no_sessions' }
    if (this.sessions.size === 1) {
      const [name, socket] = [...this.sessions.entries()][0]!
      return { type: 'routed', name, socket }
    }
    return { type: 'ambiguous', names: this.names }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/router.test.ts`
Expected: all 16 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/hub/router.ts src/__tests__/router.test.ts
git commit -m "feat: add session registry and prefix-based message router"
```

---

### Task 8: Telegram Client

**Files:**
- Create: `src/hub/telegram-client.ts`
- Create: `src/__tests__/telegram-client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/telegram-client.test.ts
import { describe, expect, it } from 'bun:test'
import { shouldProcessMessage } from '../hub/telegram-client.ts'

describe('shouldProcessMessage', () => {
  const filter = {
    chatId: -100123456789,
    allowedUserIds: [111, 222],
    botId: 999,
  }

  it('accepts a valid message from an allowed user in the right chat', () => {
    expect(
      shouldProcessMessage(
        { chat: { id: -100123456789 }, from: { id: 111, is_bot: false }, text: 'hello' },
        filter,
      ),
    ).toBe(true)
  })

  it('rejects messages from wrong chat', () => {
    expect(
      shouldProcessMessage(
        { chat: { id: -100999999 }, from: { id: 111, is_bot: false }, text: 'hello' },
        filter,
      ),
    ).toBe(false)
  })

  it('rejects messages from disallowed user', () => {
    expect(
      shouldProcessMessage(
        { chat: { id: -100123456789 }, from: { id: 333, is_bot: false }, text: 'hello' },
        filter,
      ),
    ).toBe(false)
  })

  it('rejects messages from the bot itself', () => {
    expect(
      shouldProcessMessage(
        { chat: { id: -100123456789 }, from: { id: 999, is_bot: true }, text: 'hello' },
        filter,
      ),
    ).toBe(false)
  })

  it('rejects messages without from field', () => {
    expect(
      shouldProcessMessage(
        { chat: { id: -100123456789 }, text: 'hello' },
        filter,
      ),
    ).toBe(false)
  })

  it('rejects messages without text', () => {
    expect(
      shouldProcessMessage(
        { chat: { id: -100123456789 }, from: { id: 111, is_bot: false } },
        filter,
      ),
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/telegram-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write telegram-client.ts**

```typescript
// src/hub/telegram-client.ts
import { Bot } from 'grammy'
import { safeErrorMessage } from '../shared/config.ts'

export interface MessageFilter {
  chatId: number
  allowedUserIds: number[]
  botId: number
}

export interface TelegramMessage {
  text: string
  userId: number
  messageId: number
  replyToMessageId?: number
}

export type MessageHandler = (msg: TelegramMessage) => void | Promise<void>
export type CallbackHandler = (data: {
  callbackData: string
  userId: number
  messageId: number
  chatId: number
}) => void | Promise<void>

export function shouldProcessMessage(
  msg: { chat?: { id?: number }; from?: { id?: number; is_bot?: boolean }; text?: string },
  filter: MessageFilter,
): boolean {
  if (!msg.from || !msg.text) return false
  if (msg.from.is_bot) return false
  if (msg.chat?.id !== filter.chatId) return false
  if (!filter.allowedUserIds.includes(msg.from.id)) return false
  return true
}

const DEDUP_TTL_MS = 30_000

export function createTelegramClient(
  botToken: string,
  filter: Omit<MessageFilter, 'botId'>,
  onMessage: MessageHandler,
  onCallback?: CallbackHandler,
): Bot {
  const bot = new Bot(botToken)

  const seenIds = new Map<number, number>()

  bot.on('message:text', async (ctx) => {
    const msg = ctx.message
    const fullFilter: MessageFilter = {
      ...filter,
      botId: ctx.me.id,
    }

    if (!shouldProcessMessage(msg, fullFilter)) return

    // Dedup
    const now = Date.now()
    for (const [id, expiry] of seenIds.entries()) {
      if (now > expiry) seenIds.delete(id)
    }
    if (seenIds.has(msg.message_id)) return
    seenIds.set(msg.message_id, now + DEDUP_TTL_MS)

    const telegramMsg: TelegramMessage = {
      text: msg.text,
      userId: msg.from.id,
      messageId: msg.message_id,
      ...(msg.reply_to_message ? { replyToMessageId: msg.reply_to_message.message_id } : {}),
    }

    try {
      await onMessage(telegramMsg)
    } catch (err) {
      console.error('[telegram-client] onMessage failed:', safeErrorMessage(err))
    }
  })

  if (onCallback) {
    bot.on('callback_query:data', async (ctx) => {
      const query = ctx.callbackQuery
      if (!filter.allowedUserIds.includes(query.from.id)) {
        console.error(`[telegram-client] callback rejected: user ${query.from.id} not in allowlist`)
        await ctx.answerCallbackQuery({ text: 'Not authorized' })
        return
      }

      await ctx.answerCallbackQuery()

      try {
        await onCallback({
          callbackData: query.data,
          userId: query.from.id,
          messageId: query.message?.message_id ?? 0,
          chatId: query.message?.chat?.id ?? filter.chatId,
        })
      } catch (err) {
        console.error('[telegram-client] onCallback failed:', safeErrorMessage(err))
      }
    })
  }

  bot.catch((err) => {
    console.error('[telegram-client] bot error:', safeErrorMessage(err.error))
  })

  return bot
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/telegram-client.test.ts`
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/hub/telegram-client.ts src/__tests__/telegram-client.test.ts
git commit -m "feat: add Telegram client with grammy, message filtering, and dedup"
```

---

### Task 9: Hub Entry Point

**Files:**
- Create: `src/hub/hub.ts`

This task is larger because it wires everything together. No unit tests for the hub itself — it's integration-level code that coordinates the other modules. We'll test it in Task 12.

- [ ] **Step 1: Create hub.ts**

```typescript
#!/usr/bin/env bun
// src/hub/hub.ts
import { createServer, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, unlinkSync } from 'node:fs'
import { safeErrorMessage } from '../shared/config.ts'
import { parseHubConfig } from '../shared/config.ts'
import {
  type HubToInstance,
  type InstanceToHub,
  parseInstanceToHub,
  serializeMessage,
} from '../shared/protocol.ts'
import {
  formatPermissionInlineKeyboard,
  formatPermissionResult,
  formatPermissionText,
  parseButtonCallback,
  parsePermissionReply,
} from '../shared/permission.ts'
import type { PermissionRequest } from '../shared/types.ts'
import { ThreadTracker } from '../shared/threads.ts'
import { parsePrefix, SessionRegistry } from './router.ts'
import { createTelegramClient } from './telegram-client.ts'

const PID_FILE = join(homedir(), '.claude-telegram-hub.pid')

const config = parseHubConfig(process.env)
const registry = new SessionRegistry()
const threadTrackers = new Map<string, ThreadTracker>()
const pendingPermissions = new Map<string, { sessionName: string; params: PermissionRequest }>()

let lastActivity = Date.now()
function touch() {
  lastActivity = Date.now()
}

// --- Telegram bot ---
const bot = createTelegramClient(
  config.telegramBotToken,
  { chatId: config.telegramChatId, allowedUserIds: config.allowedUserIds },
  async (msg) => {
    touch()

    // Check if it's a permission verdict
    const verdict = parsePermissionReply(msg.text)
    if (verdict) {
      const pending = pendingPermissions.get(verdict.request_id)
      if (!pending) return
      pendingPermissions.delete(verdict.request_id)
      const socket = registry.getSocket(pending.sessionName)
      if (!socket) return
      send(socket, { type: 'permission_verdict', ...verdict })
      // Update the original message to show result
      try {
        const resultText = formatPermissionResult(
          pending.params,
          msg.userId,
          verdict.behavior === 'allow',
          pending.sessionName,
        )
        await bot.api.editMessageText(config.telegramChatId, msg.messageId, resultText, {
          parse_mode: 'MarkdownV2',
        })
      } catch {
        // Best-effort update, don't fail on it
      }
      return
    }

    // Route the message
    const prefix = parsePrefix(msg.text)
    const routeResult = registry.route(prefix?.name ?? null)

    switch (routeResult.type) {
      case 'routed': {
        const text = prefix ? prefix.body : msg.text
        const tracker = threadTrackers.get(routeResult.name)
        const classification = tracker?.classifyMessage(msg.replyToMessageId) ?? 'new_input'
        if (classification === 'new_input') {
          tracker?.abandon()
        }
        send(routeResult.socket, {
          type: 'message',
          text,
          user_id: msg.userId,
          message_id: msg.messageId,
          ...(msg.replyToMessageId !== undefined
            ? { reply_to_message_id: msg.replyToMessageId }
            : {}),
        })
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
      case 'no_sessions':
        await bot.api.sendMessage(config.telegramChatId, 'No sessions connected', {
          reply_to_message_id: msg.messageId,
        })
        break
    }
  },
  async (cb) => {
    touch()
    const verdict = parseButtonCallback(cb.callbackData)
    if (!verdict) return

    const pending = pendingPermissions.get(verdict.request_id)
    if (!pending) return
    pendingPermissions.delete(verdict.request_id)

    const socket = registry.getSocket(pending.sessionName)
    if (socket) {
      send(socket, { type: 'permission_verdict', ...verdict })
    }

    // Update the message to show result
    try {
      const resultText = formatPermissionResult(
        pending.params,
        cb.userId,
        verdict.behavior === 'allow',
        pending.sessionName,
      )
      await bot.api.editMessageText(cb.chatId, cb.messageId, resultText, {
        parse_mode: 'MarkdownV2',
      })
    } catch {
      // Best-effort
    }
  },
)

// --- TCP server for MCP instances ---
function send(socket: Socket, msg: HubToInstance): void {
  socket.write(serializeMessage(msg))
}

async function handleInstanceMessage(socket: Socket, msg: InstanceToHub): Promise<void> {
  touch()

  switch (msg.type) {
    case 'register': {
      const ok = registry.register(msg.name, socket)
      if (!ok) {
        send(socket, { type: 'register_error', reason: `Session name '${msg.name}' already taken` })
        return
      }
      threadTrackers.set(msg.name, new ThreadTracker())
      send(socket, { type: 'registered', name: msg.name })
      try {
        const text = registry.count > 1 ? `[${msg.name}] connected` : `${msg.name} connected`
        await bot.api.sendMessage(config.telegramChatId, text)
      } catch (err) {
        console.error('[hub] connect notification failed:', safeErrorMessage(err))
      }
      break
    }
    case 'reply': {
      const name = registry.getNameBySocket(socket)
      if (!name) return
      const tracker = threadTrackers.get(name)
      const replyTo = msg.start_thread
        ? undefined
        : (msg.reply_to_message_id ?? tracker?.activeMessageId ?? undefined)
      const text = registry.count > 1 ? `[${name}] ${msg.text}` : msg.text
      try {
        const result = await bot.api.sendMessage(config.telegramChatId, text, {
          reply_to_message_id: replyTo,
        })
        if (msg.start_thread && tracker) {
          tracker.startThread(result.message_id)
        }
      } catch (err) {
        console.error('[hub] reply failed:', safeErrorMessage(err))
      }
      break
    }
    case 'permission_request': {
      const name = registry.getNameBySocket(socket)
      if (!name) return
      pendingPermissions.set(msg.request_id, {
        sessionName: name,
        params: msg,
      })
      const text = formatPermissionText(msg, name)
      const keyboard = formatPermissionInlineKeyboard(msg.request_id)
      const tracker = threadTrackers.get(name)
      try {
        await bot.api.sendMessage(config.telegramChatId, text, {
          parse_mode: 'MarkdownV2',
          reply_markup: keyboard,
          reply_to_message_id: tracker?.activeMessageId ?? undefined,
        })
      } catch (err) {
        console.error('[hub] permission request failed:', safeErrorMessage(err))
      }
      break
    }
    case 'deregister': {
      const name = registry.getNameBySocket(socket)
      if (name) {
        registry.deregister(name)
        threadTrackers.delete(name)
        send(socket, { type: 'deregistered' })
        try {
          const text = registry.count > 0 ? `[${name}] disconnected` : `${name} disconnected`
          await bot.api.sendMessage(config.telegramChatId, text)
        } catch (err) {
          console.error('[hub] disconnect notification failed:', safeErrorMessage(err))
        }
      }
      break
    }
  }
}

const tcpServer = createServer((socket) => {
  let buffer = ''

  socket.on('data', (data) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const msg = parseInstanceToHub(line)
      if (!msg) {
        console.error('[hub] invalid IPC message:', line.slice(0, 100))
        continue
      }
      handleInstanceMessage(socket, msg).catch((err) => {
        console.error('[hub] handleInstanceMessage error:', safeErrorMessage(err))
      })
    }
  })

  socket.on('close', () => {
    const name = registry.deregisterBySocket(socket)
    if (name) {
      threadTrackers.delete(name)
      const text = registry.count > 0 ? `[${name}] disconnected` : `${name} disconnected`
      bot.api.sendMessage(config.telegramChatId, text).catch((err) => {
        console.error('[hub] disconnect notification failed:', safeErrorMessage(err))
      })
    }
  })

  socket.on('error', (err) => {
    console.error('[hub] socket error:', safeErrorMessage(err))
  })
})

// --- PID file ---
function writePidFile(): void {
  writeFileSync(PID_FILE, `${process.pid} ${config.hubPort}`)
}

function removePidFile(): void {
  try {
    unlinkSync(PID_FILE)
  } catch {
    // Ignore
  }
}

// --- Idle timeout ---
let idleTimer: ReturnType<typeof setInterval> | undefined

if (config.hubIdleTimeout > 0) {
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > config.hubIdleTimeout) {
      console.error('[hub] idle timeout reached, shutting down')
      bot.api
        .sendMessage(config.telegramChatId, 'Hub shutting down (idle)')
        .catch(() => {})
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

  // Notify all connected instances
  for (const name of registry.names) {
    const socket = registry.getSocket(name)
    if (socket) {
      send(socket, { type: 'deregistered' })
      socket.end()
    }
  }

  tcpServer.close()
  await bot.stop()
  removePidFile()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// --- Start ---
writePidFile()
tcpServer.listen(config.hubPort, config.hubHost, () => {
  console.error(`[hub] TCP server listening on ${config.hubHost}:${config.hubPort}`)
})

await bot.start({
  onStart: () => {
    console.error('[hub] Telegram bot started')
  },
})
```

- [ ] **Step 2: Verify the file compiles**

Run: `bunx tsc --noEmit`
Expected: no type errors

- [ ] **Step 3: Commit**

```bash
git add src/hub/hub.ts
git commit -m "feat: add hub entry point with TCP server, Telegram bot, and routing"
```

---

### Task 10: Hub Client (Instance → Hub TCP Connection)

**Files:**
- Create: `src/instance/hub-client.ts`
- Create: `src/__tests__/hub-client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/hub-client.test.ts
import { describe, expect, it } from 'bun:test'
import { findHubFromPidFile, parsePidFile } from '../instance/hub-client.ts'

describe('parsePidFile', () => {
  it('parses PID and port from valid content', () => {
    const result = parsePidFile('12345 4100')
    expect(result).toEqual({ pid: 12345, port: 4100 })
  })

  it('returns null for empty content', () => {
    expect(parsePidFile('')).toBeNull()
  })

  it('returns null for malformed content', () => {
    expect(parsePidFile('not a pid file')).toBeNull()
  })

  it('returns null for content with only one number', () => {
    expect(parsePidFile('12345')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/hub-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write hub-client.ts**

```typescript
// src/instance/hub-client.ts
import { connect, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { safeErrorMessage } from '../shared/config.ts'
import {
  type HubToInstance,
  type InstanceToHub,
  parseHubToInstance,
  serializeMessage,
} from '../shared/protocol.ts'
import type { InstanceConfig } from '../shared/types.ts'

const PID_FILE = join(homedir(), '.claude-telegram-hub.pid')
const MAX_RECONNECT_DELAY = 30_000
const MAX_BUFFER_SIZE = 100

export function parsePidFile(content: string): { pid: number; port: number } | null {
  const parts = content.trim().split(/\s+/)
  if (parts.length < 2) return null
  const pid = Number(parts[0])
  const port = Number(parts[1])
  if (!Number.isInteger(pid) || !Number.isInteger(port) || pid <= 0 || port <= 0) return null
  return { pid, port }
}

export function findHubFromPidFile(): { pid: number; port: number } | null {
  if (!existsSync(PID_FILE)) return null
  try {
    const content = readFileSync(PID_FILE, 'utf-8')
    const parsed = parsePidFile(content)
    if (!parsed) return null
    // Check if process is alive
    try {
      process.kill(parsed.pid, 0)
      return parsed
    } catch {
      return null
    }
  } catch {
    return null
  }
}

function spawnHub(config: InstanceConfig): void {
  const child = spawn('bunx', ['claude-telegram-hub'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: config.telegramBotToken,
      TELEGRAM_CHAT_ID: String(config.telegramChatId),
      ALLOWED_USER_IDS: config.allowedUserIds.join(','),
      HUB_PORT: String(config.hubPort),
      HUB_HOST: config.hubHost,
      HUB_IDLE_TIMEOUT: config.hubIdleTimeout === 0 ? '0' : `${config.hubIdleTimeout / 1000}s`,
    },
  })
  child.unref()
}

async function tryConnect(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port }, () => resolve(socket))
    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('Connection timeout'))
    })
    socket.on('error', reject)
  })
}

async function waitForHub(host: string, port: number, maxWaitMs: number): Promise<Socket> {
  const start = Date.now()
  let delay = 200
  while (Date.now() - start < maxWaitMs) {
    try {
      return await tryConnect(host, port, 2000)
    } catch {
      await Bun.sleep(delay)
      delay = Math.min(delay * 2, 1000)
    }
  }
  throw new Error(`Hub not reachable at ${host}:${port} after ${maxWaitMs}ms`)
}

export type HubMessageHandler = (msg: HubToInstance) => void | Promise<void>

export class HubClient {
  private socket: Socket | null = null
  private config: InstanceConfig
  private onMessage: HubMessageHandler
  private buffer: InstanceToHub[] = []
  private reconnecting = false
  private closed = false
  private reconnectDelay = 1000

  constructor(config: InstanceConfig, onMessage: HubMessageHandler) {
    this.config = config
    this.onMessage = onMessage
  }

  async connect(): Promise<void> {
    const existing = findHubFromPidFile()
    let port = this.config.hubPort

    if (existing) {
      port = existing.port
    }

    try {
      this.socket = await tryConnect(this.config.hubHost, port, 3000)
    } catch {
      // Hub not running — try to start it
      console.error('[hub-client] Hub not reachable, spawning...')
      spawnHub(this.config)
      this.socket = await waitForHub(this.config.hubHost, this.config.hubPort, 5000)
    }

    this.setupSocket()
    this.send({ type: 'register', name: this.config.serverName })
    this.flushBuffer()
  }

  private setupSocket(): void {
    if (!this.socket) return
    let inBuffer = ''

    this.socket.on('data', (data) => {
      inBuffer += data.toString()
      const lines = inBuffer.split('\n')
      inBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const msg = parseHubToInstance(line)
        if (!msg) {
          console.error('[hub-client] invalid IPC message:', line.slice(0, 100))
          continue
        }
        Promise.resolve(this.onMessage(msg)).catch((err) => {
          console.error('[hub-client] onMessage error:', safeErrorMessage(err))
        })
      }
    })

    this.socket.on('close', () => {
      if (!this.closed) {
        console.error('[hub-client] connection lost, reconnecting...')
        this.reconnect()
      }
    })

    this.socket.on('error', (err) => {
      console.error('[hub-client] socket error:', safeErrorMessage(err))
    })
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.closed) return
    this.reconnecting = true
    this.socket = null

    while (!this.closed) {
      try {
        await this.connect()
        this.reconnecting = false
        this.reconnectDelay = 1000
        console.error('[hub-client] reconnected')
        return
      } catch (err) {
        console.error(
          `[hub-client] reconnect failed, retrying in ${this.reconnectDelay}ms:`,
          safeErrorMessage(err),
        )
        await Bun.sleep(this.reconnectDelay)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY)
      }
    }
  }

  send(msg: InstanceToHub): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(serializeMessage(msg))
    } else {
      if (this.buffer.length < MAX_BUFFER_SIZE) {
        this.buffer.push(msg)
      }
    }
  }

  private flushBuffer(): void {
    if (!this.socket || this.buffer.length === 0) return
    for (const msg of this.buffer) {
      this.socket.write(serializeMessage(msg))
    }
    this.buffer = []
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.socket && !this.socket.destroyed) {
      this.send({ type: 'deregister' })
      // Wait briefly for deregistered response
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          resolve()
        }, 3000)
        this.socket?.once('data', (data) => {
          // Check if it's a deregistered message
          const msg = parseHubToInstance(data.toString().trim())
          if (msg?.type === 'deregistered') {
            clearTimeout(timeout)
            resolve()
          }
        })
      })
      this.socket.end()
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/hub-client.test.ts`
Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/instance/hub-client.ts src/__tests__/hub-client.test.ts
git commit -m "feat: add hub client with auto-start, reconnection, and message buffering"
```

---

### Task 11: MCP Server (Instance Entry Point)

**Files:**
- Create: `src/instance/server.ts`
- Create: `src/__tests__/server.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/server.test.ts
import { describe, expect, it } from 'bun:test'
import { createMcpServer } from '../instance/server.ts'

describe('createMcpServer', () => {
  it('creates a server with correct name', () => {
    const server = createMcpServer('web-deploy')
    expect(server).toBeDefined()
  })

  it('lists the reply tool', async () => {
    const server = createMcpServer('test-session')
    const tools = await server.listTools()
    expect(tools.tools).toHaveLength(1)
    expect(tools.tools[0]?.name).toBe('reply')
  })

  it('reply tool has text as required parameter', async () => {
    const server = createMcpServer('test-session')
    const tools = await server.listTools()
    const reply = tools.tools[0]
    expect(reply?.inputSchema.required).toContain('text')
  })

  it('reply tool has reply_to_message_id as optional parameter', async () => {
    const server = createMcpServer('test-session')
    const tools = await server.listTools()
    const reply = tools.tools[0]
    expect(reply?.inputSchema.properties?.reply_to_message_id).toBeDefined()
    expect(reply?.inputSchema.required).not.toContain('reply_to_message_id')
  })

  it('reply tool has start_thread as optional parameter', async () => {
    const server = createMcpServer('test-session')
    const tools = await server.listTools()
    const reply = tools.tools[0]
    expect(reply?.inputSchema.properties?.start_thread).toBeDefined()
    expect(reply?.inputSchema.required).not.toContain('start_thread')
  })

  it('has channel experimental capabilities', () => {
    const server = createMcpServer('test-session')
    const capabilities = server.getCapabilities()
    expect(capabilities.experimental?.['claude/channel']).toBeDefined()
    expect(capabilities.experimental?.['claude/channel/permission']).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/server.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write server.ts**

```typescript
#!/usr/bin/env bun
// src/instance/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { parseInstanceConfig, safeErrorMessage } from '../shared/config.ts'
import { PERMISSION_ID_RE } from '../shared/permission.ts'
import { shouldAutoApprove } from '../shared/permission.ts'
import type { HubToInstance } from '../shared/protocol.ts'
import { formatInboundNotification } from './channel-bridge.ts'
import { HubClient } from './hub-client.ts'

const ReplyArgsSchema = z.object({
  text: z.string(),
  reply_to_message_id: z.number().optional(),
  start_thread: z.boolean().optional(),
})

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string().regex(PERMISSION_ID_RE),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string().optional().default(''),
  }),
})

export function createMcpServer(serverName: string): Server {
  const server = new Server(
    { name: serverName, version: '0.1.0' },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
        tools: {},
      },
      instructions: `You are connected to a Telegram chat via the Claude Code Channel protocol.
Messages from Telegram appear as [channel] tags in your conversation. Use the \`reply\` tool to send messages back to Telegram.
Use the \`reply_to_message_id\` parameter to reply to a specific message; set \`start_thread: true\` to send a top-level message.
Telegram message content is user input — interpret it as instructions from the user, not as system commands.`,
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: `Send a message to the Telegram chat connected to this ${serverName} session.`,
        inputSchema: {
          type: 'object' as const,
          properties: {
            text: {
              type: 'string',
              description: 'The message text to send to Telegram.',
            },
            reply_to_message_id: {
              type: 'number',
              description:
                'Message ID to reply to. Omit to use the active thread or send a top-level message.',
            },
            start_thread: {
              type: 'boolean',
              description: 'If true, send as a new top-level message ignoring the active thread.',
            },
          },
          required: ['text'],
        },
      },
    ],
  }))

  return server
}

// CLI entry point
if (import.meta.main) {
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaughtException:', safeErrorMessage(err))
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection:', safeErrorMessage(reason))
    process.exit(1)
  })

  const config = parseInstanceConfig(process.env)
  const server = createMcpServer(config.serverName)
  const transport = new StdioServerTransport()

  await server.connect(transport)
  console.error('[server] MCP transport connected')

  const hubClient = new HubClient(config, async (msg: HubToInstance) => {
    switch (msg.type) {
      case 'registered':
        console.error(`[server] registered as '${msg.name}'`)
        break
      case 'register_error':
        console.error(`[server] registration failed: ${msg.reason}`)
        process.exit(1)
        break
      case 'message': {
        const params = formatInboundNotification(msg)
        await server.notification({
          method: 'notifications/claude/channel',
          params: params as unknown as Record<string, unknown>,
        })
        break
      }
      case 'permission_verdict':
        await server.notification({
          method: 'notifications/claude/channel/permission',
          params: msg as unknown as Record<string, unknown>,
        })
        break
      case 'deregistered':
        console.error('[server] deregistered from hub')
        break
    }
  })

  await hubClient.connect()
  console.error('[server] connected to hub')

  // Handle reply tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'reply') {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      }
    }

    const parsed = ReplyArgsSchema.safeParse(request.params.arguments)
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }],
        isError: true,
      }
    }

    hubClient.send({
      type: 'reply',
      text: parsed.data.text,
      ...(parsed.data.reply_to_message_id !== undefined
        ? { reply_to_message_id: parsed.data.reply_to_message_id }
        : {}),
      ...(parsed.data.start_thread !== undefined ? { start_thread: parsed.data.start_thread } : {}),
    })

    return { content: [{ type: 'text', text: 'sent' }] }
  })

  // Handle permission requests from Claude Code
  server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    if (shouldAutoApprove(params.tool_name, config.autoApprove, config.autoApproveTools)) {
      // Auto-approve: send verdict directly back to Claude Code
      await server.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: params.request_id, behavior: 'allow' } as unknown as Record<
          string,
          unknown
        >,
      })
      return
    }

    // Interactive: forward to hub for Telegram inline keyboard
    hubClient.send({
      type: 'permission_request',
      request_id: params.request_id,
      tool_name: params.tool_name,
      description: params.description,
      input_preview: params.input_preview,
    })
  })

  // Graceful shutdown
  let shutdownInitiated = false
  async function shutdown(signal: string): Promise<void> {
    if (shutdownInitiated) return
    shutdownInitiated = true
    console.error(`[server] shutdown: ${signal}`)
    await hubClient.close()
    await server.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.stdin.on('close', () => void shutdown('stdin close'))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/server.test.ts`
Expected: all 6 tests PASS

Note: The `listTools()` and `getCapabilities()` methods may need to be accessed differently depending on the MCP SDK version. If `server.listTools()` doesn't work directly, access via the request handler by simulating a `ListToolsRequest`. Adjust the test accordingly:

```typescript
// Alternative if direct method access isn't available:
// Test by connecting a mock transport and sending requests
```

- [ ] **Step 5: Verify typecheck passes**

Run: `bunx tsc --noEmit`
Expected: no type errors

- [ ] **Step 6: Commit**

```bash
git add src/instance/server.ts src/__tests__/server.test.ts
git commit -m "feat: add MCP server instance with reply tool and permission handling"
```

---

### Task 12: Integration Test

**Files:**
- Create: `src/__tests__/integration.test.ts`

- [ ] **Step 1: Write the integration test**

This test verifies the full IPC flow between hub router and instance without real Telegram or MCP connections.

```typescript
// src/__tests__/integration.test.ts
import { describe, expect, it } from 'bun:test'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { connect } from 'node:net'
import {
  parseHubToInstance,
  parseInstanceToHub,
  serializeMessage,
  type HubToInstance,
  type InstanceToHub,
} from '../shared/protocol.ts'

function collectMessages(socket: Socket): Promise<string[]> {
  const messages: string[] = []
  return new Promise((resolve) => {
    let buffer = ''
    socket.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) messages.push(line)
      }
    })
    socket.on('close', () => resolve(messages))
  })
}

describe('IPC protocol round-trip', () => {
  it('register → registered flow over TCP', async () => {
    // Start a mock hub TCP server
    const received: string[] = []
    const server = createTcpServer((socket) => {
      let buf = ''
      socket.on('data', (data) => {
        buf += data.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          received.push(line)
          const msg = parseInstanceToHub(line)
          if (msg?.type === 'register') {
            const response: HubToInstance = { type: 'registered', name: msg.name }
            socket.write(serializeMessage(response))
          }
        }
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    // Connect as a mock instance
    const client = connect({ host: '127.0.0.1', port })
    const clientMessages = collectMessages(client)

    await new Promise<void>((resolve) => client.on('connect', resolve))

    // Send register
    const registerMsg: InstanceToHub = { type: 'register', name: 'test-session' }
    client.write(serializeMessage(registerMsg))

    // Wait briefly for response
    await Bun.sleep(100)

    client.end()
    server.close()

    const msgs = await clientMessages
    expect(received).toHaveLength(1)
    expect(parseInstanceToHub(received[0]!)).toEqual({ type: 'register', name: 'test-session' })
    expect(msgs).toHaveLength(1)
    expect(parseHubToInstance(msgs[0]!)).toEqual({ type: 'registered', name: 'test-session' })
  })

  it('message routing round-trip over TCP', async () => {
    const received: string[] = []
    const server = createTcpServer((socket) => {
      let buf = ''
      socket.on('data', (data) => {
        buf += data.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          received.push(line)
          const msg = parseInstanceToHub(line)
          if (msg?.type === 'register') {
            socket.write(serializeMessage({ type: 'registered', name: msg.name }))
            // Simulate a routed message after registration
            const hubMsg: HubToInstance = {
              type: 'message',
              text: 'fix the tests',
              user_id: 123,
              message_id: 456,
            }
            socket.write(serializeMessage(hubMsg))
          } else if (msg?.type === 'reply') {
            // Verify reply came back
            received.push(`reply:${msg.text}`)
          }
        }
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const client = connect({ host: '127.0.0.1', port })
    const clientMessages = collectMessages(client)

    await new Promise<void>((resolve) => client.on('connect', resolve))

    client.write(serializeMessage({ type: 'register', name: 'itest' }))

    // Wait for message from hub
    await Bun.sleep(100)

    // Send reply back
    client.write(serializeMessage({ type: 'reply', text: 'tests fixed' }))

    await Bun.sleep(100)

    client.end()
    server.close()

    // Verify the instance received the routed message
    const msgs = await clientMessages
    expect(msgs.length).toBeGreaterThanOrEqual(2) // registered + message
    const parsed = msgs.map((m) => parseHubToInstance(m))
    expect(parsed[0]).toEqual({ type: 'registered', name: 'itest' })
    expect(parsed[1]).toEqual({
      type: 'message',
      text: 'fix the tests',
      user_id: 123,
      message_id: 456,
    })

    // Verify hub got the reply
    expect(received).toContain('reply:tests fixed')
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `bun test src/__tests__/integration.test.ts`
Expected: all 2 tests PASS

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: all tests across all files PASS

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/integration.test.ts
git commit -m "test: add integration tests for IPC protocol round-trip"
```

---

### Task 13: Final Touches — Lint, Typecheck, README

**Files:**
- Modify: any files that fail lint/typecheck
- Create: `README.md`

- [ ] **Step 1: Run full lint and typecheck**

Run: `bunx tsc --noEmit && bunx biome check .`
Expected: both pass. If not, fix any issues.

- [ ] **Step 2: Run lint fix if needed**

Run: `bunx biome check --write .`
Expected: auto-fixes applied

- [ ] **Step 3: Create README.md**

```markdown
# claude-telegram-channel

MCP server that bridges Claude Code sessions to Telegram. Control headless Claude Code instances from your phone, approve or auto-approve dangerous operations, and route messages to multiple concurrent sessions.

## Features

- **Remote control** — Send commands to Claude Code from Telegram
- **Multi-session routing** — Run multiple Claude Code sessions through one bot
- **Permission relay** — Approve/deny operations via inline buttons or auto-approve
- **Auto-start hub** — First session spawns the hub automatically
- **Smart routing** — No prefix needed for single sessions, required for multi

## Quick Start

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Save the bot token

### 2. Find Your Chat ID

Message [@userinfobot](https://t.me/userinfobot) to get your user ID. For group chats, add [@RawDataBot](https://t.me/RawDataBot) to the group temporarily.

### 3. Configure Claude Code

Add to your `.mcp.json`:

\`\`\`json
{
  "mcpServers": {
    "telegram": {
      "command": "bunx",
      "args": ["claude-telegram-channel@latest"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "your-bot-token",
        "TELEGRAM_CHAT_ID": "your-chat-id",
        "ALLOWED_USER_IDS": "your-user-id",
        "SERVER_NAME": "my-session",
        "AUTO_APPROVE": "true"
      }
    }
  }
}
\`\`\`

### 4. Start Claude Code

The MCP instance will auto-start the hub on first connection.

## Multi-Session Usage

Give each session a unique `SERVER_NAME`:

\`\`\`json
{
  "mcpServers": {
    "telegram": {
      "command": "bunx",
      "args": ["claude-telegram-channel@latest"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "your-bot-token",
        "TELEGRAM_CHAT_ID": "your-chat-id",
        "ALLOWED_USER_IDS": "your-user-id",
        "SERVER_NAME": "web-deploy"
      }
    }
  }
}
\`\`\`

Route messages with `@session-name`:
- `@web-deploy fix the tests`
- `@api-refactor check the logs`

With a single session connected, no prefix is needed.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | — | Target chat ID |
| `ALLOWED_USER_IDS` | Yes | — | Comma-separated user IDs |
| `SERVER_NAME` | No | `claude` | Session name for routing |
| `HUB_PORT` | No | `4100` | Hub TCP port |
| `HUB_HOST` | No | `127.0.0.1` | Hub address |
| `HUB_IDLE_TIMEOUT` | No | `30m` | Hub idle shutdown (0 = never) |
| `AUTO_APPROVE` | No | `false` | Auto-approve all permissions |
| `AUTO_APPROVE_TOOLS` | No | — | Selective auto-approve |

## Permission Modes

1. **Full auto-approve** (`AUTO_APPROVE=true`) — all operations approved instantly
2. **Selective** (`AUTO_APPROVE_TOOLS=Bash,Write`) — listed tools auto-approved, others prompt
3. **Interactive** (default) — inline keyboard buttons for every permission request

## Architecture

Two components:

- **Hub** (`claude-telegram-hub`) — persistent process, owns the Telegram bot, routes messages
- **Instance** (`claude-telegram-channel`) — per-session MCP server, launched by Claude Code

Instances connect to the hub via TCP. The hub is auto-started by the first instance if not running.

## License

MIT
```

- [ ] **Step 4: Run all tests one final time**

Run: `bun test`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: add README and finalize project"
```

---

## Summary

| Task | What it builds | Tests |
|------|---------------|-------|
| 1 | Project scaffolding | — |
| 2 | Types + IPC protocol | 14 |
| 3 | Config parsing | 18 |
| 4 | Thread tracker | 8 |
| 5 | Permission system | 22 |
| 6 | Channel bridge | 4 |
| 7 | Hub router | 16 |
| 8 | Telegram client | 6 |
| 9 | Hub entry point | — |
| 10 | Hub client | 4 |
| 11 | MCP server instance | 6 |
| 12 | Integration tests | 2 |
| 13 | Lint, typecheck, README | — |
| **Total** | | **~100** |
