import { z } from 'zod'

const PromptSchema = z.object({
  type: z.literal('prompt'),
  text: z.string(),
  session_id: z.string(),
  auto_approve: z.boolean(),
  allowed_tools: z.array(z.string()).optional(),
  cwd: z.string().optional(),
})

const ResponseSchema = z.object({
  type: z.literal('response'),
  text: z.string(),
  session_id: z.string(),
  conversation_id: z.string(),
})

const ErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  session_id: z.string(),
})

const RelayResponseSchema = z.discriminatedUnion('type', [ResponseSchema, ErrorSchema])

export type PromptMessage = z.infer<typeof PromptSchema>
export type RelayResponse = z.infer<typeof RelayResponseSchema>

export function serializeMessage(msg: PromptMessage | RelayResponse): string {
  return `${JSON.stringify(msg)}\n`
}

export function parsePromptMessage(raw: string): PromptMessage | null {
  try {
    const json = JSON.parse(raw)
    const result = PromptSchema.safeParse(json)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export function parseRelayResponse(raw: string): RelayResponse | null {
  try {
    const json = JSON.parse(raw)
    const result = RelayResponseSchema.safeParse(json)
    return result.success ? result.data : null
  } catch {
    return null
  }
}
