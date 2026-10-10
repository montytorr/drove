import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readJsonlFrom } from './store.ts'
import type { AgentKind } from './types.ts'

// Tokens the model processed in a session, read from the agent's own transcript: input (cached or not) plus output.
// Claude writes one assistant line per content block, each repeating its message's usage, so a message counts once.
// Codex's rollout carries a running total in each token_count event.
export type TokenCounter = { path: string; offset: number; total: number; byMessage: Record<string, number> }

type TranscriptLine = {
  type?: string
  uuid?: string
  message?: { id?: string; usage?: Record<string, unknown> }
  payload?: { type?: string; info?: { total_token_usage?: { total_tokens?: unknown } } }
}

const whole = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

export const claudeMessageTokens = (line: TranscriptLine): { id: string; tokens: number } | undefined => {
  const usage = line.type === 'assistant' ? line.message?.usage : undefined
  const id = line.message?.id ?? line.uuid
  if (!usage || !id) return undefined
  return { id, tokens: whole(usage.input_tokens) + whole(usage.cache_creation_input_tokens) + whole(usage.cache_read_input_tokens) + whole(usage.output_tokens) }
}

export const codexTotalTokens = (line: TranscriptLine): number | undefined =>
  line.type === 'event_msg' && line.payload?.type === 'token_count' ? whole(line.payload.info?.total_token_usage?.total_tokens) || undefined : undefined

export const advanceTokens = async (kind: AgentKind, path: string, previous?: TokenCounter): Promise<TokenCounter> => {
  const counter: TokenCounter = previous?.path === path ? { ...previous, byMessage: { ...previous.byMessage } } : { path, offset: 0, total: 0, byMessage: {} }
  const read = await readJsonlFrom<TranscriptLine>(path, { offset: counter.offset })
  counter.offset = read.cursor.offset
  for (const line of read.items) {
    if (kind === 'codex') counter.total = Math.max(counter.total, codexTotalTokens(line) ?? 0)
    else {
      const message = claudeMessageTokens(line)
      if (!message) continue
      counter.total += message.tokens - (counter.byMessage[message.id] ?? 0)
      counter.byMessage[message.id] = message.tokens
    }
  }
  return counter
}

// A Codex hook may carry no transcript path, but its rollout is sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl
// in the CODEX_HOME the seat started with.
export const findRollout = async (codexHome: string, sessionId: string): Promise<string | undefined> => {
  const names = await readdir(join(codexHome, 'sessions'), { recursive: true }).catch(() => [] as string[])
  const found = names.find(name => basename(name).startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`))
  return found ? join(codexHome, 'sessions', found) : undefined
}
