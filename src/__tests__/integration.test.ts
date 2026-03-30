import { describe, expect, it } from 'bun:test'
import { SessionRegistry } from '../hub/router.ts'
import { buildClaudeArgs, parseClaudeOutput, splitMessage } from '../shared/claude-runner.ts'

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
    const registry = new SessionRegistry(
      'claude',
      [{ name: 'vm2', host: '10.0.0.5', port: 4100 }],
      '/tmp',
    )

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
