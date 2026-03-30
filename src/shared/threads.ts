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
