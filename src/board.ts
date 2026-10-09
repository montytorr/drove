import { runDir } from './paths.ts'
import { attentionOf, loadRoster, loadRun } from './roster.ts'
import { readJsonlFrom } from './store.ts'
import type { Attention, Deps, DroveEvent, Roster, RunMeta, Seat, SeatState } from './types.ts'

export const REFRESH_MS = 2_000
export const POLL_MS = 500
export const EVENT_LINES = 8

export type BoardFrame = {
  run: RunMeta
  roster: Roster
  events: readonly DroveEvent[]
  attention: readonly Attention[]
  now: Date
  width: number
  color?: boolean
}

const GLYPH: Record<SeatState, string> = {
  starting: '◌',
  working: '●',
  idle: '○',
  done: '✓',
  blocked: '■',
  'needs-input': '?',
  unknown: '~',
  gone: '✕',
  closing: '·',
  closed: '·',
  down: '↓',
}

const TONE: Record<SeatState, string> = {
  starting: '2',
  working: '36',
  idle: '32',
  done: '32',
  blocked: '31',
  'needs-input': '31',
  unknown: '2',
  gone: '2',
  closing: '2',
  closed: '2',
  down: '2',
}

const OWES: Record<Seat['owes'], string> = { review: 'review', answer: 'answer', none: '-' }

const paint = (text: string, code: string, color: boolean | undefined): string => (color ? `\x1b[${code}m${text}\x1b[0m` : text)

export const fit = (text: string, width: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (width <= 0) return ''
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`
}

const cell = (text: string, width: number): string => fit(text, width).padEnd(width)

export const since = (from: string | undefined, now: Date): string => {
  const at = from === undefined ? Number.NaN : Date.parse(from)
  if (Number.isNaN(at)) return '-'
  const minutes = Math.floor(Math.max(0, now.getTime() - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

export const clockOf = (at: string): string => {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '--:--' : date.toISOString().slice(11, 16)
}

const EFFORT_LETTER: Record<string, string> = { low: 'l', medium: 'm', high: 'h', xhigh: 'x', max: 'M' }

export const effortShort = (effort: string): string => EFFORT_LETTER[effort] ?? effort.charAt(0)

export const shortModel = (model: string): string => {
  const bare = model.replace(/^claude-/, '')
  const family = /^(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/.exec(bare)
  return family === null ? bare.replace(/-codex$/, '') : `${family[1]} ${family[2]}.${family[3]}`
}

export const modelEffort = (model: string, effort: string): string => `${shortModel(model)}·${effortShort(effort)}`

const reportOf = (seat: Seat): string => (seat.lastReport === undefined ? '-' : `${seat.lastReport.kind}: ${seat.lastReport.summary}`)

const eventDetail = (event: DroveEvent): string => {
  const data = event.data ?? {}
  const pick = ['summary', 'reason', 'state', 'kind', 'to'].map((key) => data[key]).find((value) => typeof value === 'string')
  return typeof pick === 'string' ? pick : ''
}

const eventLine = (event: DroveEvent, width: number): string => {
  const head = `${clockOf(event.at)} ${event.type}${event.seat === undefined ? '' : ` ${event.seat}`}`
  const detail = eventDetail(event)
  return fit(detail === '' ? head : `${head} ${detail}`, width)
}

const seatLine = (seat: Seat, now: Date, width: number, modelW: number, color: boolean | undefined): string => {
  const wide = width >= 110
  const seatW = wide ? 14 : 10
  const kindW = wide ? 6 : 1
  const cairnW = wide ? 10 : 8
  const ageW = 5
  const owesW = 6
  const fixed = 2 + seatW + 1 + kindW + 1 + modelW + 1 + cairnW + 1 + ageW + 1 + 1 + owesW
  const reportW = Math.max(20, width - fixed)
  const kind = wide ? seat.kind : seat.kind === 'claude' ? 'C' : 'X'
  const glyph = paint(GLYPH[seat.state], TONE[seat.state], color)
  const body = [cell(seat.name, seatW), cell(kind, kindW), cell(modelEffort(seat.model, seat.effort), modelW), cell(seat.cairn ?? '-', cairnW), cell(since(seat.stateAt, now), ageW), cell(reportOf(seat), reportW), cell(OWES[seat.owes], owesW)]
  return `${glyph} ${body.join(' ')}`.trimEnd()
}

export const renderBoard = (frame: BoardFrame): string => {
  const { run, roster, events, attention, now, width, color } = frame
  const rule = '─'.repeat(width)
  const open = roster.seats.filter((seat) => seat.state !== 'closed').length
  const title = `drove ${run.id} · ${run.status} · ${open}/${run.budget} seats · planner ${run.planner.kind} ${modelEffort(run.planner.model, run.planner.effort)}`
  const lines: string[] = [paint(fit(title, width), '1', color)]
  if (run.goal !== undefined) lines.push(fit(`goal: ${run.goal}`, width))
  lines.push(rule)
  lines.push(paint(fit(attention.length === 0 ? 'ATTENTION none' : `ATTENTION ${attention.length}`, width), attention.length === 0 ? '2' : '1;31', color))
  for (const item of attention) lines.push(`${paint('!', '31', color)} ${fit(`${item.seat} ${item.reason}: ${item.detail}`, width - 2)}`)
  lines.push(rule)
  if (roster.seats.length === 0) lines.push('no seats yet')
  const modelW = Math.max(...roster.seats.map((seat) => [...modelEffort(seat.model, seat.effort)].length), 0)
  for (const seat of roster.seats) lines.push(seatLine(seat, now, width, modelW, color))
  lines.push(rule)
  lines.push(paint('RECENT', '2', color))
  const recent = events.slice(-EVENT_LINES)
  if (recent.length === 0) lines.push('no events yet')
  for (const event of recent) lines.push(eventLine(event, width))
  return lines.join('\n')
}

export type BoardIo = {
  write: (text: string) => void
  width: () => number
  color: boolean
  signal?: AbortSignal
  pollMs?: number
  refreshMs?: number
}

const stdoutIo = (): BoardIo => ({
  write: (text) => void process.stdout.write(text),
  width: () => process.stdout.columns ?? 100,
  color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
})

const CLEAR = '\x1b[H\x1b[2J'

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

export const runBoard = async (deps: Deps, run: string, once: boolean, io: BoardIo = stdoutIo()): Promise<void> => {
  const eventsPath = `${runDir(deps.home, run)}/events.jsonl`
  let events: DroveEvent[] = []
  let cursor = { offset: 0 }
  let lastText = ''
  let lastDrawAt = 0

  const frameText = async (): Promise<string> => {
    const meta = await loadRun(deps.home, run)
    if (meta === undefined) throw new Error(`unknown run: ${run}`)
    const roster = await loadRoster(deps.home, run)
    const read = await readJsonlFrom<DroveEvent>(eventsPath, cursor)
    cursor = read.cursor
    events = [...events, ...read.items].slice(-EVENT_LINES * 4)
    return renderBoard({ run: meta, roster, events, attention: attentionOf(roster), now: deps.clock.now(), width: io.width(), color: io.color })
  }

  if (once) {
    io.write(`${await frameText()}\n`)
    return
  }

  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const signal = io.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, io.signal])
  try {
    while (!signal.aborted) {
      const text = await frameText()
      const nowMs = deps.clock.now().getTime()
      if (text !== lastText || nowMs - lastDrawAt >= (io.refreshMs ?? REFRESH_MS)) {
        io.write(`${CLEAR}${text}\n`)
        lastText = text
        lastDrawAt = nowMs
      }
      await sleep(io.pollMs ?? POLL_MS, signal)
    }
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    io.write('\n')
  }
}
