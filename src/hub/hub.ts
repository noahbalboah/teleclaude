#!/usr/bin/env bun
import { unlinkSync, writeFileSync } from 'node:fs'
// src/hub/hub.ts
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runClaude, splitMessage } from '../shared/claude-runner.ts'
import { parseHubConfig, safeErrorMessage } from '../shared/config.ts'
import { type PromptMessage, parseRelayResponse, serializeMessage } from '../shared/protocol.ts'
import { ThreadTracker } from '../shared/threads.ts'
import type { Session } from '../shared/types.ts'
import { parsePrefix, SessionRegistry } from './router.ts'
import { createTelegramClient } from './telegram-client.ts'

const PID_FILE = join(homedir(), '.claude-telegram-hub.pid')

const config = parseHubConfig(process.env)
const registry = new SessionRegistry(
  config.serverName,
  config.remoteSessions,
  config.claudeCwd,
  config.projectsDir,
)
const threadTrackers = new Map<string, ThreadTracker>()

for (const name of registry.names) {
  threadTrackers.set(name, new ThreadTracker())
}

let lastActivity = Date.now()
function touch() {
  lastActivity = Date.now()
}

// Active session — set when user sends a bare /command
let activeSessionName: string | null = null

// Permission mode — changeable at runtime via /mode command
const VALID_MODES = ['bypass', 'auto', 'plan'] as const
type PermissionMode = (typeof VALID_MODES)[number]
let permissionMode: PermissionMode = config.autoApprove ? 'bypass' : 'auto'

async function handleMessage(
  session: Session,
  text: string,
  messageId: number,
  bot: ReturnType<typeof createTelegramClient>,
): Promise<void> {
  if (session.busy) {
    session.queue.push({ text, messageId, userId: 0 })
    await bot.api.sendMessage(
      config.telegramChatId,
      'Processing previous message, yours is queued...',
      {
        reply_to_message_id: messageId,
      },
    )
    return
  }

  session.busy = true
  const tracker = threadTrackers.get(session.name)

  try {
    let responseText: string

    if (session.type === 'local') {
      const result = await runClaude({
        text,
        autoApprove: config.autoApprove,
        autoApproveTools: config.autoApproveTools,
        permissionMode,
        conversationId: session.conversationId,
        cwd: session.cwd,
        timeout: config.claudeTimeout,
      })

      if (result.error) {
        responseText = `Error: ${result.error}`
      } else {
        responseText = result.text
        if (result.sessionId) {
          session.conversationId = result.sessionId
        }
      }
    } else {
      responseText = await sendToRelay(session, text)
    }

    const prefix = registry.count > 1 ? `[${session.name}] ` : ''
    const chunks = splitMessage(`${prefix}${responseText}`)

    for (const chunk of chunks) {
      const sent = await bot.api.sendMessage(config.telegramChatId, chunk, {
        reply_to_message_id: tracker?.activeMessageId ?? messageId,
      })
      if (!tracker?.activeMessageId) {
        tracker?.startThread(sent.message_id)
      }
    }
  } catch (err) {
    await bot.api
      .sendMessage(config.telegramChatId, `Error: ${safeErrorMessage(err)}`, {
        reply_to_message_id: messageId,
      })
      .catch(() => {})
  } finally {
    session.busy = false

    const next = session.queue.shift()
    if (next) {
      handleMessage(session, next.text, next.messageId, bot).catch((err) => {
        console.error('[hub] queued message failed:', safeErrorMessage(err))
      })
    }
  }
}

function sendToRelay(session: Session, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: session.remoteHost!, port: session.remotePort! }, () => {
      const msg: PromptMessage = {
        type: 'prompt',
        text,
        session_id: session.name,
        auto_approve: config.autoApprove,
        allowed_tools: config.autoApproveTools.length > 0 ? config.autoApproveTools : undefined,
        cwd: session.cwd,
      }
      socket.write(serializeMessage(msg))
    })

    let buffer = ''
    socket.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const response = parseRelayResponse(line)
        if (!response) continue
        socket.end()
        if (response.type === 'response') {
          if (response.conversation_id) {
            session.conversationId = response.conversation_id
          }
          resolve(response.text)
        } else {
          reject(new Error(response.message))
        }
      }
    })

    socket.on('error', (err) => {
      reject(new Error(`Relay connection failed: ${safeErrorMessage(err)}`))
    })

    socket.setTimeout(300000)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('Relay connection timed out'))
    })
  })
}

async function registerBotCommands(): Promise<void> {
  const commands = registry.names
    .map((name) => ({
      command: name.replace(/-/g, '_').slice(0, 32).toLowerCase(),
      description: `Send to ${name}`,
    }))
    .concat(
      { command: 'mode', description: 'View or change permission mode' },
      { command: 'refresh', description: 'Rescan projects directory' },
    )
  try {
    await bot.api.setMyCommands(commands)
    console.error(`[hub] Registered ${commands.length} bot commands`)
  } catch (err) {
    console.error('[hub] Failed to register bot commands:', safeErrorMessage(err))
  }
}

const bot = createTelegramClient(
  config.telegramBotToken,
  { chatId: config.telegramChatId, allowedUserIds: config.allowedUserIds },
  async (msg) => {
    touch()

    // Handle /mode command
    const modeMatch = msg.text.trim().match(/^\/mode(?:\s+(\w+))?$/)
    if (modeMatch !== null) {
      const newMode = modeMatch[1]?.toLowerCase()
      if (!newMode) {
        await bot.api.sendMessage(
          config.telegramChatId,
          `Current mode: ${permissionMode}\n\nAvailable:\n/mode bypass — full access, no limits\n/mode auto — Claude decides risk level\n/mode plan — read-only, no writes`,
          { reply_to_message_id: msg.messageId },
        )
        return
      }
      if (VALID_MODES.includes(newMode as PermissionMode)) {
        permissionMode = newMode as PermissionMode
        await bot.api.sendMessage(
          config.telegramChatId,
          `Permission mode set to: ${permissionMode}`,
          { reply_to_message_id: msg.messageId },
        )
        return
      }
      await bot.api.sendMessage(
        config.telegramChatId,
        `Invalid mode "${newMode}". Use: bypass, auto, or plan`,
        { reply_to_message_id: msg.messageId },
      )
      return
    }

    // Handle /refresh command
    if (msg.text.trim() === '/refresh') {
      const added = registry.refresh(config.projectsDir)
      for (const name of added) {
        threadTrackers.set(name, new ThreadTracker())
      }
      await registerBotCommands()
      const text =
        added.length > 0
          ? `Refreshed. New sessions: ${added.join(', ')}\nAll sessions: ${registry.names.join(', ')}`
          : `No new sessions found.\nAll sessions: ${registry.names.join(', ')}`
      await bot.api.sendMessage(config.telegramChatId, text, {
        reply_to_message_id: msg.messageId,
      })
      return
    }

    // Handle bare /command (no message body) — set as active session
    const bareCommandMatch = msg.text.trim().match(/^\/([a-zA-Z0-9_@.-]+)$/)
    if (bareCommandMatch?.[1]) {
      const name = bareCommandMatch[1].replace(/@.*$/, '')
      const session = registry.get(name)
      if (session) {
        activeSessionName = session.name
        await bot.api.sendMessage(
          config.telegramChatId,
          `Switched to ${session.name}. Send your message:`,
          { reply_to_message_id: msg.messageId },
        )
        return
      }
    }

    const prefix = parsePrefix(msg.text)

    // If message has a prefix, use it and update active session
    if (prefix) {
      const session = registry.get(prefix.name)
      if (session) {
        activeSessionName = session.name
        const tracker = threadTrackers.get(session.name)
        const classification = tracker?.classifyMessage(msg.replyToMessageId) ?? 'new_input'
        if (classification === 'new_input') {
          tracker?.abandon()
        }
        await handleMessage(session, prefix.body, msg.messageId, bot)
        return
      }
      // Session not found
      await bot.api.sendMessage(
        config.telegramChatId,
        `Session '${prefix.name}' not found. Active: ${registry.names.join(', ')}`,
        { reply_to_message_id: msg.messageId },
      )
      return
    }

    // No prefix — use active session if set, otherwise smart routing
    if (activeSessionName) {
      const session = registry.get(activeSessionName)
      if (session) {
        const tracker = threadTrackers.get(session.name)
        const classification = tracker?.classifyMessage(msg.replyToMessageId) ?? 'new_input'
        if (classification === 'new_input') {
          tracker?.abandon()
        }
        await handleMessage(session, msg.text, msg.messageId, bot)
        return
      }
    }

    // Fall back to smart routing
    const routeResult = registry.route(null)
    switch (routeResult.type) {
      case 'routed': {
        const tracker = threadTrackers.get(routeResult.session.name)
        const classification = tracker?.classifyMessage(msg.replyToMessageId) ?? 'new_input'
        if (classification === 'new_input') {
          tracker?.abandon()
        }
        await handleMessage(routeResult.session, msg.text, msg.messageId, bot)
        break
      }
      case 'ambiguous':
        await bot.api.sendMessage(
          config.telegramChatId,
          `Which session? Tap a command or type /session_name message\nActive: ${routeResult.names.join(', ')}`,
          { reply_to_message_id: msg.messageId },
        )
        break
      case 'not_found':
        await bot.api.sendMessage(
          config.telegramChatId,
          `Session '${routeResult.name}' not found. Active: ${routeResult.available.join(', ') || 'none'}`,
          { reply_to_message_id: msg.messageId },
        )
        break
    }
  },
)

function writePidFile(): void {
  writeFileSync(PID_FILE, `${process.pid}`)
}

function removePidFile(): void {
  try {
    unlinkSync(PID_FILE)
  } catch {}
}

let idleTimer: ReturnType<typeof setInterval> | undefined

if (config.hubIdleTimeout > 0) {
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > config.hubIdleTimeout) {
      console.error('[hub] idle timeout reached, shutting down')
      bot.api
        .sendMessage(config.telegramChatId, 'Hub shutting down (idle)')
        .catch(() => {})
        .finally(() => shutdown('idle'))
    }
  }, 60_000)
}

let shutdownInitiated = false

async function shutdown(signal: string): Promise<void> {
  if (shutdownInitiated) return
  shutdownInitiated = true
  console.error(`[hub] shutdown: ${signal}`)

  if (idleTimer) clearInterval(idleTimer)
  await bot.stop()
  removePidFile()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

writePidFile()

await bot.init()
console.error('[hub] Telegram bot initialized')

await registerBotCommands()

bot.start({
  onStart: () => {
    console.error('[hub] Telegram bot polling started')
  },
})
