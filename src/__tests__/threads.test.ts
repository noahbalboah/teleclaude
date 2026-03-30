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
