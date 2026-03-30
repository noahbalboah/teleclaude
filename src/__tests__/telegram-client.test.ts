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
    expect(shouldProcessMessage({ chat: { id: -100123456789 }, text: 'hello' }, filter)).toBe(false)
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
