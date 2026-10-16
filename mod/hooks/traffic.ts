import { NAME_RE, oneLine } from './protocol.ts'

// What the transcript draws of the planner's worker traffic, so its own text to the person stands apart (DROVE-172): a call to a worker is
// one `→` line, a wake one `←` line per report. Only the drawing changes; the model reads the call and the wake as before.

export type Outgoing = { names: string[]; tag: string; text: string }

export type Incoming = { seat: string; tag: string; summary: string }

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export const recipientsOf = (input: Record<string, unknown>): string[] => {
  const also = Array.isArray(input.also) ? input.also.map(str) : []
  return [...new Set([str(input.name), ...also].filter(Boolean))]
}

export const outgoingOf = (tool: string, input: unknown): Outgoing | undefined => {
  if (!input || typeof input !== 'object') return undefined
  const fields = input as Record<string, unknown>
  const names = recipientsOf(fields)
  if (names.length === 0) return undefined
  switch (tool) {
    case 'mcp__orchestrator__message_worker':
      return { names, tag: `expects ${str(fields.expects) || 'none'}`, text: str(fields.text) }
    case 'mcp__orchestrator__spawn_worker':
      return { names, tag: ['brief', str(fields.kind), str(fields.role)].filter(Boolean).join(' · '), text: str(fields.brief) }
    case 'mcp__orchestrator__review_verdict':
      return { names, tag: str(fields.verdict) || 'verdict', text: str(fields.notes) }
    default:
      return undefined
  }
}

const FRAMING_HEAD = /^The orchestrator plugin sent a message:\s*/
const FRAMING_TAIL = /\n\s*This is how Claude Code surfaces a prompt[\s\S]*$/
const HEADLINE = /^(\S+) · (.+?)(?: — (.*))?$/

// A wake's headlines (bridge.ts wakeHeadlines), or undefined for any text that is not only headlines, which keeps the engine's own row.
export const incomingOf = (text: string): Incoming[] | undefined => {
  const lines = text.replace(FRAMING_HEAD, '').replace(FRAMING_TAIL, '').split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length === 0) return undefined
  const parsed = lines.map(line => {
    const match = HEADLINE.exec(line)
    return match && NAME_RE.test(match[1] ?? '') ? { seat: match[1] ?? '', tag: match[2] ?? '', summary: match[3] ?? '' } : undefined
  })
  return parsed.every(entry => entry !== undefined) ? (parsed as Incoming[]) : undefined
}

export const TRAFFIC_COLUMNS = 120

// The room left for a line's text once its head is drawn, never under 20 columns.
export const fitText = (text: string, columns: number | undefined, head: number): string => oneLine(text, Math.max(20, (columns ?? TRAFFIC_COLUMNS) - head - 4))
