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
  if (msg.from.id === undefined || !filter.allowedUserIds.includes(msg.from.id)) return false
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
