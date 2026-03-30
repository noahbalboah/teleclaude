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
    PROJECTS_DIR: z.string().optional(),
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
    projectsDir: result.PROJECTS_DIR,
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
