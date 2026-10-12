import { join } from 'node:path'
import { buildBoard, needsAnimation } from '../mod/hooks/board.ts'
import type { BoardModel, Cell, Tone } from '../mod/hooks/board.ts'
import { feedOf } from '../mod/hooks/bridge.ts'
import { FEED_MAX, openSeats } from '../mod/hooks/roster.ts'
import type { OrchBridge, OrchFeedEntry, OrchLead, OrchModStatus } from '../mod/types/index.d.ts'
import { modelLabelOf } from './agents.ts'
import { plannerDir, runDir, seatDir } from './paths.ts'
import { loadRoster, loadRun } from './roster.ts'
import { readJson, readJsonlFrom } from './store.ts'
import type { Deps, DroveEvent, Roster, RunMeta, Seat } from './types.ts'

// The mod's board model (mod/hooks/board.ts) drawn in a terminal, in the terminal's own background.

export const POLL_MS = 500
export const FRAME_MS = 200
export const ONCE_COLUMNS = 100
export const ONCE_ROWS = 40
const NARROW = 80

// The mod's palette (mod/hooks/register.tsx COLOR and TONE), as foreground colours only.
export const TONE_COLOR: Record<Tone, string> = {
  lead: '#cba6f7',
  working: '#89b4fa',
  good: '#a6e3a1',
  warn: '#f9e2af',
  alert: '#f38ba8',
  muted: '#7f849c',
  dim: '#585b70',
  text: '#cdd6f4',
  you: '#fab387',
}

export type ColorDepth = 0 | 8 | 24

export type BoardData = {
  run: RunMeta
  roster: Roster
  status: Record<string, OrchModStatus>
  feed: OrchFeedEntry[]
  bridgeHeld: boolean
}

export type FrameInput = BoardData & { now: number; frame: number; columns: number; rows: number; offsetMinutes: number }

export const colorDepthOf = (env: NodeJS.ProcessEnv, isTTY: boolean): ColorDepth => {
  if (env.NO_COLOR) return 0
  const force = env.FORCE_COLOR
  const rich: ColorDepth = env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' ? 24 : 8
  if (force !== undefined && force !== '') return force === '0' || force === 'false' ? 0 : force === '3' ? 24 : force === '2' ? 8 : rich
  if (!isTTY || env.TERM === 'dumb') return 0
  return rich
}

// ---------- text width ----------

const WIDE_BMP = new Set([...'⌚⌛⏩⏪⏫⏬⏰⏳◽◾☔☕♈♉♊♋♌♍♎♏♐♑♒♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓❔❕❗➕➖➗➰➿⬛⬜⭐⭕'].map(char => char.codePointAt(0)))

const charWidth = (code: number): number => {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0
  if (WIDE_BMP.has(code)) return 2
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2
  return 1
}

export const widthOf = (text: string): number => [...text].reduce((sum, char) => sum + charWidth(char.codePointAt(0) ?? 0), 0)

// Untrusted text (summaries, activities) loses control characters, so it can never carry an escape sequence.
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')

export const fitWidth = (text: string, width: number): string => {
  if (width <= 0) return ''
  if (widthOf(text) <= width) return text
  let out = ''
  let used = 0
  for (const char of text) {
    const size = charWidth(char.codePointAt(0) ?? 0)
    if (used + size > width - 1) break
    out += char
    used += size
  }
  return `${out}…`
}

const padTo = (text: string, width: number): string => `${text}${' '.repeat(Math.max(0, width - widthOf(text)))}`

// ---------- lines ----------

type Seg = { text: string; tone?: Tone; isBold?: boolean }

const segWidth = (segs: readonly Seg[]): number => segs.reduce((sum, { text }) => sum + widthOf(text), 0)

const clipSegs = (segs: readonly Seg[], columns: number): Seg[] => {
  if (segWidth(segs) <= columns) return [...segs]
  const out: Seg[] = []
  let room = columns
  for (const seg of segs) {
    const size = widthOf(seg.text)
    if (size < room) {
      out.push(seg)
      room -= size
      continue
    }
    out.push({ ...seg, text: fitWidth(seg.text, room) })
    break
  }
  return out
}

const cellText = (cell: Cell): string => clean(cell.text)

const rowSegs = (cells: readonly Cell[], columns: number): Seg[] => {
  const flexible = cells.findIndex(cell => cell.width === undefined)
  const fixed = cells.reduce((sum, cell, at) => sum + (at === flexible ? 0 : (cell.width ?? 0)), 0) + Math.max(0, cells.length - 1)
  const flexWidth = Math.max(0, columns - fixed)
  const segs: Seg[] = []
  cells.forEach((cell, at) => {
    if (at > 0) segs.push({ text: ' ' })
    const width = at === flexible ? flexWidth : (cell.width ?? 0)
    const text = fitWidth(cellText(cell), width)
    segs.push({ text, tone: cell.tone, isBold: cell.isBold })
    if (at < cells.length - 1) segs.push({ text: ' '.repeat(Math.max(0, width - widthOf(text))) })
  })
  return clipSegs(segs, columns)
}

const headSegs = (model: BoardModel, columns: number): Seg[] => {
  const [brand, goal] = model.title
  let progress = model.progress
  const progressWidth = (cells: readonly Cell[]) => widthOf(cells.map(cellText).join(' '))
  const brandWidth = brand ? widthOf(brand.text) : 0
  if (progress.length > 1 && (columns < NARROW || columns - progressWidth(progress) - 2 < brandWidth + 20)) progress = progress.slice(1)
  const right: Seg[] = progress.flatMap((cell, at) => [...(at > 0 ? [{ text: ' ' }] : []), { text: cellText(cell), tone: cell.tone, isBold: cell.isBold }])
  const leftRoom = Math.max(0, columns - segWidth(right) - 2)
  const left = clipSegs(
    [
      ...(brand ? [{ text: cellText(brand), tone: brand.tone, isBold: brand.isBold }] : []),
      ...(goal ? [{ text: ' ' }, { text: fitWidth(cellText(goal), Math.max(0, leftRoom - brandWidth - 1)), tone: goal.tone, isBold: goal.isBold }] : []),
    ],
    leftRoom,
  )
  return clipSegs([...left, { text: ' '.repeat(Math.max(2, columns - segWidth(left) - segWidth(right))) }, ...right], columns)
}

const ruleSegs = (title: string, run: string, columns: number): Seg[] => {
  const head = `── ${title} `
  const tail = ` ${run} ──`
  const fill = columns - widthOf(head) - widthOf(tail)
  return clipSegs(fill >= 3 ? [{ text: `${head}${'─'.repeat(fill)}`, tone: 'dim' }, { text: ` ${run}`, tone: 'muted' }, { text: ' ──', tone: 'dim' }] : [{ text: `${head}${'─'.repeat(Math.max(0, columns - widthOf(head)))}`, tone: 'dim' }], columns)
}

export const boardLines = (model: BoardModel, run: string, columns: number, rows: number): Seg[][] => {
  const lines: Seg[][] = [headSegs(model, columns), [], rowSegs(model.lead.cells, columns), ...model.workers.map(row => rowSegs(row.cells, columns))]
  if (model.empty) lines.push([{ text: fitWidth(model.empty, columns), tone: 'muted' }])
  lines.push([], ruleSegs(model.feedTitle, run, columns))
  if (model.feed.length === 0) lines.push([{ text: fitWidth('Briefs, reports and verdicts appear here.', columns), tone: 'muted' }])
  for (const row of model.feed) lines.push(rowSegs(row.cells, columns))
  return lines.slice(0, Math.max(1, rows))
}

// ---------- colour ----------

const rgbOf = (hex: string): [number, number, number] => [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number]

const CUBE = [0, 95, 135, 175, 215, 255]

export const ansi256 = (hex: string): number => {
  const rgb = rgbOf(hex)
  const level = (value: number) => (value < 48 ? 0 : value < 115 ? 1 : Math.floor((value - 35) / 40))
  const [r, g, b] = rgb.map(level) as [number, number, number]
  const cube = 16 + 36 * r + 6 * g + b
  const gray = Math.max(0, Math.min(23, Math.round((rgb.reduce((sum, value) => sum + value, 0) / 3 - 8) / 10)))
  const distance = (other: readonly number[]) => other.reduce((sum, value, at) => sum + (value - (rgb[at] ?? 0)) ** 2, 0)
  return distance([CUBE[r] ?? 0, CUBE[g] ?? 0, CUBE[b] ?? 0]) <= distance([8 + gray * 10, 8 + gray * 10, 8 + gray * 10]) ? cube : 232 + gray
}

export const sgrOf = (tone: Tone, isBold: boolean | undefined, depth: ColorDepth): string => {
  const hex = TONE_COLOR[tone]
  const color = depth === 24 ? `38;2;${rgbOf(hex).join(';')}` : `38;5;${ansi256(hex)}`
  return `\x1b[${isBold ? '1;' : ''}${color}m`
}

const paintLine = (segs: readonly Seg[], depth: ColorDepth): string => {
  const kept = [...segs]
  while (kept.length > 0 && (kept.at(-1)?.text.trim() ?? '') === '') kept.pop()
  const last = kept.at(-1)
  if (last) kept[kept.length - 1] = { ...last, text: last.text.trimEnd() }
  return kept.map(({ text, tone, isBold }) => (depth === 0 || tone === undefined || text.trim() === '' ? text : `${sgrOf(tone, isBold, depth)}${text}\x1b[0m`)).join('')
}

// ---------- model ----------

const ownedOf = (seats: readonly Seat[]): string => {
  const reviews = seats.filter(({ owes }) => owes === 'review').length
  const answers = seats.filter(({ owes }) => owes === 'answer').length
  return [reviews ? `${reviews} review${reviews === 1 ? '' : 's'}` : '', answers ? `${answers} answer${answers === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')
}

// What the lead is doing, as far as Drove can see from outside its pane: what it owes the workers, and since when it last sent.
export const leadOf = (data: BoardData): OrchLead => {
  const owed = ownedOf(openSeats(data.roster.seats))
  const sent = data.feed.filter(({ from }) => from === '⌘').at(-1)?.at
  const activity = data.run.status === 'down' ? 'idle · the run is down; drove up resumes it' : owed ? `waiting · owes ${owed}` : 'waiting on the workers'
  return { activity, since: sent ?? (Date.parse(data.run.createdAt) || 0) }
}

const bridgeOf = (data: BoardData, now: number): OrchBridge | null =>
  data.run.status === 'up' && data.run.planner.viaMod && !data.bridgeHeld ? { state: 'stopped', detail: 'no planner session holds it', since: now } : null

export const asksAtOf = (seats: readonly Seat[], status: Readonly<Record<string, OrchModStatus>>): Record<string, number> =>
  Object.fromEntries(
    openSeats(seats).flatMap(seat => {
      const mine = status[seat.name]
      const at = mine?.asking ? Date.parse(mine.at ?? '') : seat.state === 'needs-input' ? Date.parse(seat.stateAt) : Number.NaN
      return Number.isNaN(at) ? [] : [[seat.name, at] as const]
    }),
  )

export const modelOf = (input: FrameInput): BoardModel => {
  const model = buildBoard({
    orchestrator: { run: input.run.id, repo: input.run.repo, goal: input.run.goal, startedAt: Date.parse(input.run.createdAt) || input.now, budget: input.run.budget },
    seats: input.roster.seats.map(seat => ({ ...seat, model: modelLabelOf(seat.kind, seat.model, input.run.agents) })),
    status: input.status,
    asksAt: asksAtOf(input.roster.seats, input.status),
    bridge: bridgeOf(input, input.now),
    feed: input.feed,
    lead: leadOf(input),
    leadModel: modelLabelOf(input.run.planner.kind, input.run.planner.model, input.run.agents),
    leadEffort: input.run.planner.effort,
    now: input.now,
    frame: input.frame,
    offsetMinutes: input.offsetMinutes,
    columns: input.columns,
    rows: input.rows,
    viewer: 'human',
  })
  const [brand, ...rest] = model.title
  return { ...model, title: [{ ...(brand ?? { tone: 'lead', isBold: true }), text: '◆ drove' }, ...rest], feedTitle: model.feedTitle.replace(' · scroll for more', '') }
}

export const isAnimated = (input: FrameInput): boolean => needsAnimation(leadOf(input), input.roster.seats, asksAtOf(input.roster.seats, input.status), input.now)

export const renderFrame = (input: FrameInput, depth: ColorDepth): string[] =>
  boardLines(modelOf(input), input.run.id, input.columns, input.rows).map(line => paintLine(line, depth))

// ---------- reading the run ----------

// Control bodies are not kept on disk, so a brief or a verdict shows its kind, not its text.
export const feedFrom = (events: readonly DroveEvent[], first = 0): OrchFeedEntry[] =>
  events.flatMap((event, at) => {
    const draft = feedOf(event, new Map())
    return draft ? [{ ...draft, id: event.id ?? `e${first + at}` }] : []
  })

const isAlive = (pid: number | undefined): boolean => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export const boardSource = (deps: Deps, run: string): (() => Promise<BoardData>) => {
  const eventsPath = join(runDir(deps.home, run), 'events.jsonl')
  let cursor = { offset: 0 }
  let feed: OrchFeedEntry[] = []
  let seen = 0
  return async () => {
    const meta = await loadRun(deps.home, run)
    if (meta === undefined) throw new Error(`unknown run: ${run}`)
    const roster = await loadRoster(deps.home, run)
    const read = await readJsonlFrom<DroveEvent>(eventsPath, cursor)
    cursor = read.cursor
    feed = [...feed, ...feedFrom(read.items, seen)].slice(-FEED_MAX)
    seen += read.items.length
    const status = Object.fromEntries(
      (
        await Promise.all(
          openSeats(roster.seats).map(async seat => [seat.name, await readJson<OrchModStatus>(join(seatDir(deps.home, run, seat.name), 'mod.json')).catch(() => undefined)] as const),
        )
      ).filter((entry): entry is readonly [string, OrchModStatus] => entry[1] !== undefined),
    )
    const lock = await readJson<{ pid?: number }>(join(plannerDir(deps.home, run), 'bridge.json')).catch(() => undefined)
    return { run: meta, roster, status, feed, bridgeHeld: isAlive(lock?.pid) }
  }
}

// ---------- drawing ----------

export type BoardInput = {
  setRawMode: (raw: boolean) => void
  resume: () => void
  pause: () => void
  onData: (listener: (chunk: Buffer | string) => void) => () => void
}

export type BoardIo = {
  write: (text: string) => void
  columns: () => number | undefined
  rows: () => number | undefined
  isTTY: boolean
  depth: ColorDepth
  offsetMinutes?: number
  signal?: AbortSignal
  onResize?: (listener: () => void) => () => void
  pollMs?: number
  frameMs?: number
  input?: BoardInput
}

const stdinInput = (): BoardInput | undefined =>
  process.stdin.isTTY === true
    ? {
        setRawMode: raw => void process.stdin.setRawMode(raw),
        resume: () => void process.stdin.resume(),
        pause: () => void process.stdin.pause(),
        onData: listener => {
          process.stdin.on('data', listener)
          return () => void process.stdin.off('data', listener)
        },
      }
    : undefined

const QUIT_KEYS = new Set(['q', 'Q', '\x03'])

const stdoutIo = (): BoardIo => ({
  write: text => void process.stdout.write(text),
  columns: () => process.stdout.columns,
  rows: () => process.stdout.rows,
  isTTY: process.stdout.isTTY === true,
  depth: colorDepthOf(process.env, process.stdout.isTTY === true),
  onResize: listener => {
    process.stdout.on('resize', listener)
    return () => void process.stdout.off('resize', listener)
  },
  input: stdinInput(),
})

export const ENTER = '\x1b[?1049h\x1b[?25l'
export const LEAVE = '\x1b[?25h\x1b[?1049l'
const SYNC_ON = '\x1b[?2026h'
const SYNC_OFF = '\x1b[?2026l'

// Home, each line then clear to its end, clear below: the old frame is overwritten in place, never blanked first.
export const paintFrame = (lines: readonly string[]): string => `${SYNC_ON}\x1b[H${lines.map(line => `${line}\x1b[K`).join('\r\n')}\x1b[J${SYNC_OFF}`

export const runBoard = async (deps: Deps, run: string, once: boolean, io: BoardIo = stdoutIo()): Promise<void> => {
  const load = boardSource(deps, run)
  const offsetOf = (now: number) => io.offsetMinutes ?? new Date(now).getTimezoneOffset()
  const frameOf = (data: BoardData, frame: number, live: boolean): FrameInput => {
    const now = deps.clock.now().getTime()
    return { ...data, now, frame, offsetMinutes: offsetOf(now), columns: io.columns() || ONCE_COLUMNS, rows: io.rows() || (live ? 24 : ONCE_ROWS) }
  }

  if (once || !io.isTTY) {
    io.write(`${renderFrame(frameOf(await load(), 0, false), io.depth).join('\n')}\n`)
    return
  }

  const controller = new AbortController()
  const stop = () => controller.abort()
  const signal = io.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, io.signal])
  let wake: (() => void) | undefined
  let last = ''
  const resized = () => {
    last = ''
    wake?.()
  }
  let rawOn = false
  const restore = () => {
    if (rawOn) {
      rawOn = false
      io.input?.setRawMode(false)
      io.input?.pause()
    }
    io.write(LEAVE)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  process.once('exit', restore)
  const offResize = io.onResize?.(resized)
  io.write(ENTER)
  let offInput: (() => void) | undefined
  try {
    if (io.input) {
      io.input.setRawMode(true)
      rawOn = true
      io.input.resume()
      offInput = io.input.onData(chunk => {
        if (QUIT_KEYS.has(chunk.toString())) stop()
      })
    }
    let data = await load()
    let loadedAt = deps.clock.now().getTime()
    let frame = 0
    while (!signal.aborted) {
      const now = deps.clock.now().getTime()
      if (now - loadedAt >= (io.pollMs ?? POLL_MS)) {
        data = await load().catch(() => data)
        loadedAt = now
      }
      const input = frameOf(data, frame, true)
      const moving = isAnimated(input)
      const text = paintFrame(renderFrame(input, io.depth))
      if (text !== last) {
        io.write(text)
        last = text
      }
      if (moving) frame = (frame + 1) % 1000
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          wake = undefined
          resolve()
        }
        const timer = setTimeout(done, moving ? (io.frameMs ?? FRAME_MS) : (io.pollMs ?? POLL_MS))
        wake = done
        signal.addEventListener('abort', done, { once: true })
      })
    }
  } finally {
    offResize?.()
    offInput?.()
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    process.off('exit', restore)
    restore()
  }
}
