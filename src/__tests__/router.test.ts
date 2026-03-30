import { describe, expect, it } from 'bun:test'
import { parsePrefix, SessionRegistry } from '../hub/router.ts'

describe('parsePrefix', () => {
  it('extracts session name and body from /-prefixed message', () => {
    const result = parsePrefix('/web-deploy fix the tests')
    expect(result).toEqual({ name: 'web-deploy', body: 'fix the tests' })
  })

  it('handles underscore in session name', () => {
    const result = parsePrefix('/my_session do something')
    expect(result).toEqual({ name: 'my_session', body: 'do something' })
  })

  it('returns null for messages without / prefix', () => {
    expect(parsePrefix('hello world')).toBeNull()
  })

  it('returns null for / without space after name', () => {
    expect(parsePrefix('/session')).toBeNull()
  })

  it('returns null for empty body after prefix', () => {
    expect(parsePrefix('/session ')).toBeNull()
  })

  it('parses first word as session name even with spaces in body', () => {
    const result = parsePrefix('/bad session fix it')
    expect(result).toEqual({ name: 'bad', body: 'session fix it' })
  })

  it('handles plain alphanumeric session names', () => {
    const result = parsePrefix('/claude fix the tests')
    expect(result).toEqual({ name: 'claude', body: 'fix the tests' })
  })

  it('strips @botname suffix from commands in group chats', () => {
    const result = parsePrefix('/web-deploy@mybot fix the tests')
    expect(result).toEqual({ name: 'web-deploy', body: 'fix the tests' })
  })
})

describe('SessionRegistry', () => {
  it('starts with configured sessions', () => {
    const registry = new SessionRegistry('claude', [], '/tmp')
    expect(registry.count).toBe(1)
    expect(registry.names).toEqual(['claude'])
  })

  it('includes remote sessions', () => {
    const registry = new SessionRegistry(
      'claude',
      [{ name: 'vm2', host: '10.0.0.5', port: 4100 }],
      '/tmp',
    )
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
    const registry = new SessionRegistry(
      'claude',
      [{ name: 'vm2', host: '10.0.0.5', port: 4100 }],
      '/tmp',
    )
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
    const registry = new SessionRegistry(
      'claude',
      [{ name: 'vm2', host: '10.0.0.5', port: 4100 }],
      '/tmp',
    )
    const result = registry.route(null)
    expect(result.type).toBe('ambiguous')
  })

  it('route returns routed for valid prefix', () => {
    const registry = new SessionRegistry(
      'claude',
      [{ name: 'vm2', host: '10.0.0.5', port: 4100 }],
      '/tmp',
    )
    const result = registry.route('vm2')
    expect(result.type).toBe('routed')
    if (result.type === 'routed') expect(result.session.name).toBe('vm2')
  })

  it('route returns not_found for unknown prefix', () => {
    const registry = new SessionRegistry('claude', [], '/tmp')
    const result = registry.route('unknown')
    expect(result.type).toBe('not_found')
  })

  it('auto-discovers projects from projectsDir', () => {
    const registry = new SessionRegistry('claude', [], '/tmp', '/home/noah/claude-projects')
    expect(registry.count).toBeGreaterThanOrEqual(2)
    expect(registry.names).toContain('slack-telegram-claude')
    const session = registry.get('slack-telegram-claude')
    expect(session?.cwd).toBe('/home/noah/claude-projects/slack-telegram-claude')
    expect(session?.type).toBe('local')
  })

  it('falls back to default session when projectsDir is empty', () => {
    const registry = new SessionRegistry('claude', [], '/tmp', '/nonexistent/path')
    expect(registry.count).toBe(1)
    expect(registry.names).toEqual(['claude'])
  })
})
