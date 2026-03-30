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

  it('does not include cwd in args (handled by spawn options)', () => {
    const args = buildClaudeArgs({
      text: 'hello',
      autoApprove: true,
      autoApproveTools: [],
      cwd: '/home/user/projects',
    })
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
