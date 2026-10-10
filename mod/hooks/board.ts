import type { OrchEffort, OrchFeedEntry, OrchLead, OrchOrchestrator, OrchWorker, OrchWorkerStatus } from '../types'
import { shortModel } from './protocol'
import { openWorkers, statusGlyph } from './roster'

export const BOARD_ID = 'orchestra'

export type Tone = 'lead' | 'working' | 'good' | 'warn' | 'alert' | 'muted' | 'dim' | 'text' | 'you'

export type Cell = { text: string; tone: Tone; width?: number; isBold?: boolean }

export type BoardRow = { key: string; cells: Cell[]; id?: string; lines?: string[]; isExpanded?: boolean }

export type BoardModel = {
  title: Cell[]
  progress: Cell[]
  lead: BoardRow
  workers: BoardRow[]
  feedTitle: string
  feed: BoardRow[]
  empty?: string
}

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export const PULSE_MS = 6_000
const GAUGE = { full: '▰', empty: '▱' }

const STATUS_TONE: Record<OrchWorkerStatus, Tone> = {
  starting: 'muted',
  working: 'working',
  idle: 'good',
  done: 'good',
  blocked: 'alert',
  unknown: 'muted',
  closed: 'dim',
  gone: 'dim',
}

const FEED_ICON: Record<string, string> = {
  brief: '➤',
  done: '✓',
  verdict: '✎',
  question: '?',
  asking: '?',
  answered: '↩',
  promote: '⇡',
  demote: '⇣',
  blocked: '⛔',
  progress: '·',
  hello: '⏵',
  message: '✉',
  nudge: '⟳',
  close: '⏻',
  gone: '✕',
}

const FEED_TONE: Record<string, Tone> = {
  done: 'good',
  verdict: 'good',
  answered: 'good',
  question: 'alert',
  asking: 'alert',
  blocked: 'alert',
  gone: 'alert',
  promote: 'warn',
  demote: 'warn',
}

const effortShort = (effort: OrchEffort | undefined): string => (effort === undefined ? '' : effort === 'xhigh' ? 'xh' : effort.charAt(0))

export const since = (ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

export const clockOf = (at: number, offsetMinutes: number): string => {
  const local = new Date(at - offsetMinutes * 60_000)
  return `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
}

export const gauge = (percent: number, cells: number): string => {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return `${GAUGE.full.repeat(filled)}${GAUGE.empty.repeat(cells - filled)}`
}

const ctxTone = (percent: number): Tone => (percent > 70 ? 'alert' : percent >= 50 ? 'warn' : 'good')

const isBusy = (activity: string | undefined): boolean => activity !== undefined && !/^(idle|waiting)/.test(activity)

export const needsAnimation = (lead: OrchLead | null, workers: readonly OrchWorker[], now: number): boolean =>
  isBusy(lead?.activity) ||
  openWorkers(workers).some(({ status, asksAt }) => status === 'working' || status === 'starting' || (asksAt !== undefined && now - asksAt < PULSE_MS))

const personOf = (name: string): { text: string; tone: Tone } =>
  name === '⌘' ? { text: '⌘', tone: 'lead' } : name === 'Cal' ? { text: 'you', tone: 'you' } : { text: name, tone: 'working' }

export const clip = (text: string, width: number): string => (width <= 0 ? '' : text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`)

export const wrapLines = (text: string, width: number, maxLines: number): string[] => {
  const size = Math.max(10, width)
  const lines = text.split('\n').flatMap(line => {
    if (line.length === 0) return ['']
    const parts: string[] = []
    for (let at = 0; at < line.length; at += size) parts.push(line.slice(at, at + size))
    return parts
  })
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, Math.max(0, maxLines - 1)), '… (cut to fit; widen or heighten the board to see more)']
}

export const EXPAND_INDENT = 8

// header, gap, lead, workers, the empty note, gap, rule
export const fixedRows = (openCount: number): number => 5 + Math.max(openCount, 1)

export const timelineRoom = (rows: number, openCount: number): number => Math.max(1, rows - fixedRows(openCount))

export const progressOf = (workers: readonly OrchWorker[]): { done: number; total: number } => {
  const counted = workers.filter(({ status, lastReport }) => status !== 'gone' || lastReport?.kind === 'done')
  return { done: counted.filter(({ lastReport, status }) => lastReport?.kind === 'done' || status === 'done').length, total: counted.length }
}

const workerDoing = (worker: OrchWorker, spin: string): Cell => {
  if (worker.isAsking) return { text: worker.activity ?? 'waiting for you in its pane', tone: 'alert' }
  if (worker.status === 'blocked') return { text: 'waiting on a dialog in its pane', tone: 'alert' }
  if (worker.status === 'starting') return { text: `${spin} starting`, tone: 'muted' }
  if (worker.status === 'done' && worker.lastReport) return { text: worker.lastReport.summary, tone: 'text' }
  const doing = worker.activity ?? worker.lastReport?.summary ?? ''
  return { text: worker.status === 'working' && doing ? `${spin} ${doing}` : doing, tone: 'text' }
}

export const buildBoard = (input: {
  orchestrator: OrchOrchestrator
  workers: readonly OrchWorker[]
  feed: readonly OrchFeedEntry[]
  lead: OrchLead | null
  leadModel: string
  leadEffort: OrchEffort
  maxWorkers: number
  now: number
  frame: number
  scrollBack?: number
  expanded?: string | null
  offsetMinutes: number
  columns: number
  rows: number
}): BoardModel => {
  const { orchestrator, workers, feed, lead, now, columns, frame } = input
  const open = openWorkers(workers).sort((a, b) => a.spawnedAt - b.spawnedAt)
  const isWide = columns >= 70
  const names = [...workers.map(({ name }) => name), ...feed.flatMap(({ from, to }) => [from, to])]
  const nameWidth = Math.min(16, Math.max(8, ...names.map(name => name.length + 1)))
  const spin = SPINNER[frame % SPINNER.length] ?? '⠋'
  const isPulseOn = frame % 2 === 0
  const { done, total } = progressOf(workers)
  const isAllDone = total > 0 && done === total && open.every(({ status }) => status === 'done' || status === 'idle')

  const title: Cell[] = [
    { text: '◆ orchestra', tone: 'lead', isBold: true },
    { text: orchestrator.goal ?? 'waiting for a goal', tone: orchestrator.goal ? 'text' : 'muted', isBold: Boolean(orchestrator.goal) },
  ]
  const elapsed = since(now - orchestrator.startedAt)
  const progress: Cell[] = isAllDone
    ? [{ text: `✓ all done · ${elapsed}`, tone: 'good', isBold: true }]
    : [
        ...(total > 0 ? [{ text: gauge((done / total) * 100, Math.min(10, Math.max(5, total))), tone: 'good' as const }] : []),
        { text: `${total > 0 ? `${done}/${total} done · ` : ''}${open.length}/${input.maxWorkers} open · ${elapsed}`, tone: 'muted' },
      ]

  const leadBusy = isBusy(lead?.activity)
  const leadRow: BoardRow = {
    key: 'lead',
    cells: [
      { text: '⌘', tone: 'lead', width: 2 },
      { text: 'lead', tone: 'lead', width: nameWidth + 3, isBold: true },
      ...(isWide ? [{ text: `${shortModel(input.leadModel)} · ${effortShort(input.leadEffort)}`, tone: 'muted' as const, width: 13 }] : []),
      { text: `${leadBusy ? `${spin} ` : ''}${lead?.activity ?? 'idle'}`, tone: leadBusy ? 'text' : 'muted' },
      ...(lead ? [{ text: since(now - lead.since), tone: 'dim' as const, width: 5 }] : []),
    ],
  }

  const workerRows: BoardRow[] = open.map((worker, index) => {
    const isPulsing = worker.isAsking === true && worker.asksAt !== undefined && now - worker.asksAt < PULSE_MS
    const stripeTone: Tone = isPulsing ? (isPulseOn ? 'alert' : 'dim') : STATUS_TONE[worker.status]
    return {
      key: `w:${worker.name}`,
      cells: [
        { text: index === open.length - 1 ? '└─' : '├─', tone: 'dim', width: 2 },
        { text: '▌', tone: stripeTone, width: 1 },
        { text: worker.isAsking ? '?' : statusGlyph(worker.status), tone: STATUS_TONE[worker.status], width: 2 },
        { text: worker.name, tone: STATUS_TONE[worker.status], width: nameWidth, isBold: true },
        ...(isWide ? [{ text: `${shortModel(worker.model).split(' ')[0] ?? ''}·${effortShort(worker.effort)}`, tone: 'muted' as const, width: 9 }] : []),
        ...(isWide && worker.cairnRef ? [{ text: worker.cairnRef, tone: 'dim' as const, width: 8 }] : []),
        workerDoing(worker, spin),
        ...(isWide && worker.ctx !== undefined ? [{ text: `${gauge(worker.ctx, 4)} ${String(worker.ctx).padStart(2)}%`, tone: ctxTone(worker.ctx), width: 9 }] : []),
        { text: since(now - (worker.lastReport?.at ?? worker.spawnedAt)), tone: 'dim', width: 5 },
      ],
    }
  })

  const baseRoom = timelineRoom(input.rows, open.length)
  const back = Math.max(0, Math.min(input.scrollBack ?? 0, feed.length - baseRoom))
  const end = feed.length - back
  const opened = feed.slice(Math.max(0, end - baseRoom), end).find(entry => entry.id !== undefined && entry.id === input.expanded)
  const openedLines = opened ? wrapLines(opened.full ?? opened.summary, columns - EXPAND_INDENT, Math.max(1, baseRoom - 1)) : []
  const room = Math.max(1, baseRoom - openedLines.length)
  const start = Math.max(0, end - room)
  const shown = feed.slice(start, end)
  const fixedWidth = 5 + 2 + nameWidth + 1 + nameWidth + (isWide ? 9 : 0)
  const fixedGaps = isWide ? 6 : 5
  const summaryWidth = Math.max(8, columns - fixedWidth - fixedGaps)
  const feedRows: BoardRow[] = shown.map((entry, index) => {
    const from = personOf(entry.from)
    const to = personOf(entry.to)
    const tone = entry.isHidden ? 'dim' : (FEED_TONE[entry.kind] ?? 'muted')
    const hasMore = (entry.full ?? entry.summary).length > entry.summary.length || /\n/.test(entry.full ?? '')
    const isExpanded = entry.id !== undefined && entry.id === input.expanded
    return {
      key: `f:${entry.id ?? `${entry.at}:${index}`}`,
      id: entry.id,
      lines: isExpanded ? openedLines : undefined,
      isExpanded,
      cells: [
        { text: clockOf(entry.at, input.offsetMinutes), tone: 'dim', width: 5 },
        { text: FEED_ICON[entry.kind] ?? '•', tone, width: 2 },
        { text: from.text, tone: entry.isHidden ? 'dim' : from.tone, width: nameWidth },
        { text: '→', tone: 'dim', width: 1 },
        { text: to.text, tone: entry.isHidden ? 'dim' : to.tone, width: nameWidth },
        ...(isWide ? [{ text: entry.kind, tone, width: 9 }] : []),
        { text: clip(`${hasMore ? (isExpanded ? '▾ ' : '▸ ') : ''}${entry.summary}${entry.isHidden ? ' (not shown to the lead)' : ''}`, summaryWidth), tone: entry.isHidden ? 'dim' : 'text', width: summaryWidth },
      ],
    }
  })

  return {
    title,
    progress,
    lead: leadRow,
    workers: workerRows,
    feedTitle:
      back > 0
        ? `timeline · ${start + 1}–${end} of ${feed.length} · ↓ ${back} newer`
        : feed.length > shown.length
          ? `timeline · last ${shown.length} of ${feed.length} · scroll for more`
          : 'timeline',
    feed: feedRows,
    empty: open.length === 0 ? (orchestrator.goal ? 'No workers yet: the lead is planning.' : 'Give the lead a goal in your next prompt.') : undefined,
  }
}
