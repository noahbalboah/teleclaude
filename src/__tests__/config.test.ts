import { describe, expect, it } from 'bun:test'
import {
  parseDuration,
  parseHubConfig,
  parseRelayConfig,
  safeErrorMessage,
} from '../shared/config.ts'

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
