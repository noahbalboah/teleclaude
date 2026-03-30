// src/shared/types.ts
export interface HubConfig {
  telegramBotToken: string
  telegramChatId: number
  allowedUserIds: number[]
  serverName: string
  autoApprove: boolean
  autoApproveTools: string[]
  remoteSessions: RemoteSessionConfig[]
  projectsDir?: string
  claudeCwd: string
  claudeTimeout: number
  hubIdleTimeout: number
}

export interface RemoteSessionConfig {
  name: string
  host: string
  port: number
}

export interface RelayConfig {
  relayPort: number
  claudeCwd: string
  claudeTimeout: number
}

export interface Session {
  name: string
  type: 'local' | 'remote'
  conversationId?: string
  remoteHost?: string
  remotePort?: number
  busy: boolean
  cwd: string
  queue: QueuedMessage[]
}

export interface QueuedMessage {
  text: string
  messageId: number
  userId: number
}
