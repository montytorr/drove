import type { DroveEvent, OrchFeedEntry, OrchModStatus, Roster, RunMeta } from '../types'
import { oneLine } from './protocol'

// What `drove mod bridge` writes, one JSON object per line (src/modhost.ts BridgeLine).
export type BridgeLine =
  | { t: 'ready'; run: string; pid: number }
  | { t: 'busy'; pid: number; sessionId?: string }
  | { t: 'fatal'; code: string; text: string }
  | { t: 'run'; run: RunMeta }
  | { t: 'roster'; roster: Roster; status: Record<string, OrchModStatus> }
  | { t: 'events'; events: DroveEvent[]; isInitial: boolean }
  | { t: 'wake'; text: string }
  | { t: 'error'; step: string; message: string }

export const BRIDGE_EXIT = { ok: 0, fatal: 2, busy: 3, detached: 4 } as const

export const splitLines = (buffer: string): { lines: string[]; rest: string } => {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter(line => line.trim()), rest }
}

export const parseLine = (line: string): BridgeLine | undefined => {
  try {
    const parsed = JSON.parse(line) as BridgeLine
    return typeof parsed === 'object' && parsed !== null && typeof parsed.t === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

// Restart delay after the bridge exits: quick for a crash, slow while another session holds the run.
export const backoffMs = (tries: number, isBusy: boolean): number => (isBusy ? 30_000 : Math.min(30_000, 1_000 * 2 ** Math.max(0, tries)))

export type FeedDraft = Omit<OrchFeedEntry, 'id' | 'at'> & { at: number }

const text = (value: unknown): string => (typeof value === 'string' ? value : value === undefined ? '' : String(value))

const BLOCKED: Record<string, string> = { blocked: 'waiting on a dialog in its pane', 'needs-input': 'needs an approval in its pane' }

// Drove's event log, as the board's timeline. `bodies` holds the full text the lead sent, keyed `<seat>:<kind>`.
export const feedOf = (event: DroveEvent, bodies: Map<string, string[]>): FeedDraft | undefined => {
  const at = Date.parse(event.at) || 0
  const seat = event.seat ?? '?'
  const data = event.data ?? {}
  const kind = text(data.kind)
  const takeBody = (): string | undefined => bodies.get(`${seat}:${kind}`)?.shift()
  switch (event.type) {
    case 'report': {
      const expects = text(data.expects)
      return { at, from: seat, to: '⌘', kind, summary: `${expects && expects !== 'none' ? `expects ${expects} · ` : ''}${text(data.summary)}`, isHidden: kind === 'progress' }
    }
    case 'control.sent': {
      const full = kind === 'nudge' ? undefined : takeBody()
      const label = kind === 'verdict' ? text(data.verdict) : ''
      const summary = kind === 'nudge' ? 'stopped without a report' : full ?? (kind === 'promote' || kind === 'demote' ? `${text(data.model)} ${text(data.effort)}`.trim() : kind)
      return { at, from: '⌘', to: seat, kind, summary: `${label ? `${label}: ` : ''}${summary}${data.unconfirmed ? ' (typed, unconfirmed)' : ''}`, ...(full ? { full } : {}) }
    }
    case 'control.queued':
      return { at, from: '⌘', to: seat, kind: 'queued', summary: `${kind} waits: ${text(data.reason)}` }
    case 'control.failed':
      return { at, from: '⌘', to: seat, kind: 'failed', summary: `${kind} not delivered: ${text(data.reason)}` }
    case 'seat.state': {
      const to = text(data.to)
      if (to === 'gone') return { at, from: seat, to: '⌘', kind: 'gone', summary: 'its pane closed' }
      if (BLOCKED[to]) return { at, from: seat, to: 'Cal', kind: 'blocked', summary: BLOCKED[to] ?? to }
      return undefined
    }
    case 'seat.close':
      return { at, from: '⌘', to: seat, kind: 'close', summary: 'pane closed' }
    case 'seat.start_failed':
      return { at, from: seat, to: '⌘', kind: 'failed', summary: `did not start (${text(data.code)})${data.reason ? `: ${text(data.reason)}` : ''}` }
    case 'seat.relaunch':
      return data.ok === false
        ? { at, from: '⌘', to: seat, kind: 'failed', summary: `relaunch failed: ${text(data.error)}` }
        : { at, from: '⌘', to: seat, kind: 'relaunch', summary: `relaunched${data.resumed ? ' (resumed)' : ''}${data.pane ? ` in pane ${text(data.pane)}` : ''}` }
    case 'attention':
      return text(data.reason) === 'report-rejected' ? { at, from: seat, to: '⌘', kind: 'attention', summary: `report rejected: ${text(data.why)}` } : { at, from: seat, to: 'Cal', kind: 'attention', summary: `${text(data.reason)}${data.detail ? `: ${text(data.detail)}` : ''}` }
    default:
      return undefined
  }
}

export type WakeBlock = { seat: string; kind: string; text: string }

// A wake carries one rendered block per report: `[worker <seat> · <kind> … · expects …]` and its lines.
export const splitWake = (wake: string): WakeBlock[] =>
  wake
    .split(/\n\n(?=\[worker )/)
    .map(block => {
      const match = /^\[worker (\S+) · (\w+)/.exec(block.trim())
      return match ? { seat: match[1] ?? '', kind: match[2] ?? '', text: block.trim() } : undefined
    })
    .filter((block): block is WakeBlock => block !== undefined)

export const toastOf = (blocks: readonly WakeBlock[]): string => oneLine(blocks.map(({ seat, kind }) => `${seat}: ${kind}`).join(', '), 80)
