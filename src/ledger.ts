import { readJsonlFrom } from './store.ts'
import { commandOf, EDIT_TOOLS, editPathsOf, SHELL_TOOLS } from './guard.ts'
import type { AgentKind } from './types.ts'

// DROVE-127: the tool ledger of a seat, read from the agent's own transcript (Strands' steering handlers read the same
// thing: every tool call with its name, inputs, time and status). One entry per call that has an answer, in the order the
// answers came. The transcript is read from a byte offset on, so a tick costs what the transcript grew by.
// Claude writes a `tool_use` block in an assistant line and its `tool_result` (with `is_error`) in a later user line.
// Codex writes a `function_call` and a `function_call_output` whose text carries the exit code; its `exec` wrapper (a
// script that calls several tools) has no one command or exit code to read, so it is not in the ledger.

export type LedgerEntry = { at: string; tool: string; command?: string; paths?: string[]; ok: boolean }

type Call = Omit<LedgerEntry, 'ok'>

export type Ledger = {
  path: string
  offset: number
  // Entries ever made: the newest of `entries` is number `count`, so a rule can tell a new entry from one it has seen.
  count: number
  entries: LedgerEntry[]
  // Calls with no answer yet, by the id the answer names.
  pending: Map<string, Call>
  // The last edit that succeeded: kept apart because `entries` forgets.
  lastEdit?: LedgerEntry
}

export const MAX_ENTRIES = 400
const MAX_PENDING = 200
// A first read of a long session starts this far from the end: the rules look at what the seat did lately.
export const INITIAL_BYTES = 4 * 1024 * 1024
const COMMAND_MAX = 2000

type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean }
type Line = {
  type?: string
  timestamp?: string
  isSidechain?: boolean
  message?: { content?: unknown }
  payload?: { type?: string; name?: string; arguments?: unknown; input?: unknown; call_id?: string; output?: unknown }
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

const callOf = (at: string, tool: string, input: unknown): Call => {
  const record = asRecord(input)
  const command = SHELL_TOOLS.has(tool) ? commandOf(record) : undefined
  const paths = tool === 'apply_patch' || EDIT_TOOLS.has(tool) ? editPathsOf(tool, record) : [record.file_path, record.notebook_path, record.path].filter((path): path is string => typeof path === 'string')
  return { at, tool, ...(command !== undefined ? { command: command.slice(0, COMMAND_MAX) } : {}), ...(paths.length > 0 ? { paths } : {}) }
}

export const newLedger = (path: string, offset = 0): Ledger => ({ path, offset, count: 0, entries: [], pending: new Map() })

const settle = (ledger: Ledger, call: Call, ok: boolean): void => {
  const entry: LedgerEntry = { ...call, ok }
  ledger.entries.push(entry)
  ledger.count += 1
  if (ledger.entries.length > MAX_ENTRIES) ledger.entries.splice(0, ledger.entries.length - MAX_ENTRIES)
  if (ok && EDIT_TOOLS.has(entry.tool)) ledger.lastEdit = entry
}

const hold = (ledger: Ledger, id: string, call: Call): void => {
  ledger.pending.set(id, call)
  if (ledger.pending.size > MAX_PENDING) ledger.pending.delete(ledger.pending.keys().next().value as string)
}

const absorbClaude = (ledger: Ledger, line: Line): void => {
  if (line.isSidechain) return
  const content = line.message?.content
  if (!Array.isArray(content)) return
  for (const block of content as Block[]) {
    if (line.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') hold(ledger, block.id, callOf(line.timestamp ?? '', block.name, block.input))
    else if (line.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const call = ledger.pending.get(block.tool_use_id)
      if (!call) continue
      ledger.pending.delete(block.tool_use_id)
      settle(ledger, call, block.is_error !== true)
    }
  }
}

// The text of a Codex output: a string, or a list of `input_text` parts.
const outputText = (output: unknown): string => {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output.map(part => (typeof asRecord(part).text === 'string' ? (asRecord(part).text as string) : '')).join('\n')
}

// A Codex shell result is `Process exited with code N` ahead of the output (exec_command), `Exit code: N` (older), or JSON
// with `metadata.exit_code` (shell, apply_patch). No code means the command is still running, which is not a failure.
export const exitCodeOf = (output: unknown): number | undefined => {
  const text = outputText(output)
  try {
    const code = asRecord(asRecord(JSON.parse(text)).metadata).exit_code
    if (typeof code === 'number') return code
  } catch {
    // plain text
  }
  const found = /Process exited with code (-?\d+)/.exec(text) ?? /^Exit code: (-?\d+)/m.exec(text)
  return found ? Number(found[1]) : undefined
}

const absorbCodex = (ledger: Ledger, line: Line): void => {
  const payload = line.payload
  if (line.type !== 'response_item' || !payload || typeof payload.call_id !== 'string') return
  if ((payload.type === 'function_call' || payload.type === 'custom_tool_call') && typeof payload.name === 'string') {
    let input: unknown = payload.arguments ?? payload.input
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input)
      } catch {
        input = { input }
      }
    }
    hold(ledger, payload.call_id, callOf(line.timestamp ?? '', payload.name, input))
  } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const call = ledger.pending.get(payload.call_id)
    if (!call) return
    ledger.pending.delete(payload.call_id)
    const code = exitCodeOf(payload.output)
    settle(ledger, call, code === undefined || code === 0)
  }
}

// Reads what the transcript gained since `previous` was made and returns the ledger (the same object when it continues).
// `size` is the file's size from the caller's stat: a file that shrank is a new transcript, and a first read of a long one
// starts near its end.
export const advanceLedger = async (kind: AgentKind, path: string, size: number, previous: Ledger | undefined, read: typeof readJsonlFrom = readJsonlFrom): Promise<Ledger> => {
  const ledger = previous?.path === path && size >= previous.offset ? previous : newLedger(path, Math.max(0, size - INITIAL_BYTES))
  if (size <= ledger.offset) return ledger
  const batch = await read<Line>(path, { offset: ledger.offset })
  ledger.offset = batch.cursor.offset
  for (const line of batch.items) {
    if (kind === 'codex') absorbCodex(ledger, line)
    else absorbClaude(ledger, line)
  }
  return ledger
}
