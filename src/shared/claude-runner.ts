import { spawn } from 'node:child_process'
import { safeErrorMessage } from './config.ts'

export interface ClaudeRunOptions {
  text: string
  autoApprove: boolean
  autoApproveTools: string[]
  permissionMode?: string // 'bypass' | 'auto' | 'plan'
  conversationId?: string
  cwd?: string
  timeout?: number
}

export interface ClaudeResult {
  text: string
  sessionId?: string
  error?: string
}

export function buildClaudeArgs(opts: ClaudeRunOptions): string[] {
  const args = ['-p', opts.text, '--output-format', 'json']

  if (opts.conversationId) {
    args.push('--resume', opts.conversationId)
  }

  if (opts.permissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions')
  } else if (opts.permissionMode === 'plan') {
    args.push('--permission-mode', 'plan')
  } else if (opts.permissionMode === 'auto') {
    args.push('--permission-mode', 'auto')
  } else if (opts.autoApprove) {
    args.push('--dangerously-skip-permissions')
  } else if (opts.autoApproveTools.length > 0) {
    args.push('--allowedTools', opts.autoApproveTools.join(','))
  }

  return args
}

export function parseClaudeOutput(raw: string): ClaudeResult {
  try {
    const data = JSON.parse(raw)
    if (data.is_error) {
      return { text: '', error: data.result ?? 'Unknown error', sessionId: data.session_id }
    }
    return {
      text: data.result ?? '',
      sessionId: data.session_id,
    }
  } catch {
    return { text: raw.trim() }
  }
}

const TELEGRAM_MAX_LENGTH = 4096

export function splitMessage(text: string, maxLength: number = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLength)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', maxLength)
    if (splitAt <= 0) splitAt = maxLength

    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeResult> {
  const args = buildClaudeArgs(opts)
  const timeout = opts.timeout ?? 300000

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        resolve({
          text: '',
          error: safeErrorMessage(stderr || `claude exited with code ${code}`),
        })
        return
      }
      resolve(parseClaudeOutput(stdout))
    })

    proc.on('error', (err) => {
      resolve({ text: '', error: safeErrorMessage(err) })
    })
  })
}
