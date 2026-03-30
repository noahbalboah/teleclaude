#!/usr/bin/env bun
// src/relay/relay.ts
import { createServer } from 'node:net'
import { runClaude } from '../shared/claude-runner.ts'
import { parseRelayConfig, safeErrorMessage } from '../shared/config.ts'
import { parsePromptMessage, serializeMessage } from '../shared/protocol.ts'

const config = parseRelayConfig(process.env)

const conversationIds = new Map<string, string>()

const server = createServer((socket) => {
  let buffer = ''

  socket.on('data', (data) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      const msg = parsePromptMessage(line)
      if (!msg) {
        console.error('[relay] invalid message:', line.slice(0, 100))
        continue
      }

      const existingConvId = conversationIds.get(msg.session_id)

      runClaude({
        text: msg.text,
        autoApprove: msg.auto_approve,
        autoApproveTools: msg.allowed_tools ?? [],
        conversationId: existingConvId,
        cwd: msg.cwd ?? config.claudeCwd,
        timeout: config.claudeTimeout,
      })
        .then((result) => {
          if (result.sessionId) {
            conversationIds.set(msg.session_id, result.sessionId)
          }
          if (result.error) {
            socket.write(
              serializeMessage({
                type: 'error',
                message: result.error,
                session_id: msg.session_id,
              }),
            )
          } else {
            socket.write(
              serializeMessage({
                type: 'response',
                text: result.text,
                session_id: msg.session_id,
                conversation_id: result.sessionId ?? '',
              }),
            )
          }
        })
        .catch((err) => {
          socket.write(
            serializeMessage({
              type: 'error',
              message: safeErrorMessage(err),
              session_id: msg.session_id,
            }),
          )
        })
    }
  })

  socket.on('error', (err) => {
    console.error('[relay] socket error:', safeErrorMessage(err))
  })
})

server.listen(config.relayPort, '0.0.0.0', () => {
  console.error(`[relay] listening on 0.0.0.0:${config.relayPort}`)
})

process.on('SIGTERM', () => {
  console.error('[relay] shutdown: SIGTERM')
  server.close()
  process.exit(0)
})
process.on('SIGINT', () => {
  console.error('[relay] shutdown: SIGINT')
  server.close()
  process.exit(0)
})
