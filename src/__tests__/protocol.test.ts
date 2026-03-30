import { describe, expect, it } from 'bun:test'
import {
  type PromptMessage,
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
    const result = parseRelayResponse('{"type":"error","message":"failed","session_id":"s1"}')
    expect(result).toEqual({ type: 'error', message: 'failed', session_id: 's1' })
  })

  it('returns null for invalid JSON', () => {
    expect(parseRelayResponse('garbage')).toBeNull()
  })
})
