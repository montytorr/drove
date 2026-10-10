import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PULSE_MS, STATUS_TONE } from '../mod/hooks/board.ts'
import { statusGlyph } from '../mod/hooks/roster.ts'
import * as board from '../src/board.ts'
import { runDir, seatDir } from '../src/paths.ts'
import { saveRun } from '../src/roster.ts'
import { appendJsonl, writeJsonAtomic } from '../src/store.ts'
import type { Deps, DroveEvent, Roster, RunMeta, Seat, SeatState } from '../src/types.ts'
import { assertExports } from './helpers.ts'

const NOW = Date.parse('2026-10-09T10:42:00.000Z')
const ESC = /\x1b/
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

const RUN: RunMeta = {
  v: 1,
  id: 'drove-20261009-1000-a3f1',
  repo: '/Users/test/src/drove',
  base: 'main',
  hasRemote: false,
  createdAt: '2026-10-09T10:00:00.000Z',
  status: 'up',
  goal: 'Build Drove v1 pieces P1 to P5 in parallel',
  budget: 5,
  planner: { kind: 'claude', model: 'claude-opus-5-5', effort: 'high', viaMod: false },
}

const seat = (overrides: Partial<Seat> & Pick<Seat, 'name'>): Seat => ({
  kind: 'claude',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  worktree: `/tmp/wt/${overrides.name}`,
  branch: `drove/${overrides.name}`,
  state: 'working',
  stateAt: '2026-10-09T10:30:00.000Z',
  spawnedAt: '2026-10-09T10:00:00.000Z',
  owes: 'none',
  attention: [],
  ...overrides,
})

const ROSTER: Roster = {
  v: 1,
  run: RUN.id,
  updatedAt: '2026-10-09T10:41:00.000Z',
  seats: [
    seat({ name: 'w-core', cairn: 'DROVE-3', state: 'done', spawnedAt: '2026-10-09T10:01:00.000Z', owes: 'review', lastReport: { id: 'r1', kind: 'done', expects: 'review', summary: 'P1 core state and protocol finished, 48 tests green', at: '2026-10-09T10:35:00.000Z' } }),
    seat({ name: 'w-guard', kind: 'codex', model: 'gpt-5.5-codex', effort: 'xhigh', cairn: 'DROVE-4', state: 'blocked', spawnedAt: '2026-10-09T10:02:00.000Z', attention: [{ seat: 'w-guard', reason: 'dialog', detail: 'a trust dialog waits in its pane', at: '2026-10-09T10:38:00.000Z' }] }),
    seat({ name: 'w-runtime', cairn: 'DROVE-5', state: 'working', spawnedAt: '2026-10-09T10:03:00.000Z' }),
    seat({ name: 'w-store', cairn: 'DROVE-6', state: 'idle', spawnedAt: '2026-10-09T10:04:00.000Z', lastReport: { id: 'r2', kind: 'progress', expects: 'none', summary: 'store written', at: '2026-10-09T10:20:00.000Z' } }),
    seat({ name: 'w-board', cairn: 'DROVE-7', state: 'working', spawnedAt: '2026-10-09T10:05:00.000Z' }),
    seat({ name: 'w-old', state: 'gone', stateAt: '2026-10-09T09:00:00.000Z' }),
  ],
}

const EVENTS: DroveEvent[] = [
  { at: '2026-10-09T10:01:00.000Z', type: 'control.sent', seat: 'w-core', id: 'c1', data: { kind: 'brief' } },
  { at: '2026-10-09T10:35:00.000Z', type: 'report', seat: 'w-core', id: 'r1', data: { kind: 'done', expects: 'review', summary: 'P1 core state and protocol finished, 48 tests green' } },
  { at: '2026-10-09T10:36:00.000Z', type: 'seat.state', seat: 'w-old', data: { from: 'idle', to: 'gone' } },
  { at: '2026-10-09T10:38:00.000Z', type: 'attention', seat: 'w-guard', data: { reason: 'dialog', detail: 'a trust dialog waits in its pane' } },
]

const STATUS = {
  'w-runtime': { activity: 'editing src/herdr.ts', ctx: 31, at: '2026-10-09T10:41:00.000Z' },
  'w-board': { asking: 'Which width is the minimum?', at: '2026-10-09T10:41:58.000Z' },
}

const DATA: board.BoardData = { run: RUN, roster: ROSTER, status: STATUS, feed: board.feedFrom(EVENTS), bridgeHeld: false }

const input = (columns: number, rows = 30, overrides: Partial<board.FrameInput> = {}): board.FrameInput => ({ ...DATA, now: NOW, frame: 0, columns, rows, offsetMinutes: 0, ...overrides })

const lineOf = (lines: readonly string[], name: string): string => lines.find(line => line.includes(name)) ?? assert.fail(`no line for ${name}`)

const golden = (name: string, actual: string) => {
  const path = new URL(`./fixtures/board/${name}`, import.meta.url)
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(new URL('./fixtures/board/', import.meta.url), { recursive: true })
    writeFileSync(path, `${actual}\n`)
  }
  assert.equal(`${actual}\n`, readFileSync(path, 'utf8'))
}

test('board exports its interface', () => {
  assertExports(board, ['runBoard', 'renderFrame', 'modelOf', 'colorDepthOf', 'feedFrom', 'boardSource', 'widthOf'])
})

test('golden plain frame at 60 columns', () => golden('board-60.txt', board.renderFrame(input(60), 0).join('\n')))
test('golden plain frame at 120 columns', () => golden('board-120.txt', board.renderFrame(input(120), 0).join('\n')))

test('every line fits the width, in colour or not, at 60 and 120 columns', () => {
  for (const columns of [60, 120])
    for (const depth of [0, 8, 24] as const)
      for (const line of board.renderFrame(input(columns), depth)) assert.ok(board.widthOf(stripAnsi(line)) <= columns, `${columns}/${depth}: ${stripAnsi(line)}`)
})

test('the frame never outgrows the pane height', () => {
  for (const rows of [4, 9, 12]) assert.ok(board.renderFrame(input(120, rows), 0).length <= rows)
  assert.equal(board.renderFrame(input(120, 40), 0).length, 5 + 5 + DATA.feed.length)
})

test('the narrow frame drops the wide columns and the gauge but keeps the goal', () => {
  const lines = board.renderFrame(input(60), 0)
  assert.match(lines[0] ?? '', /^◆ drove Build Drove/)
  assert.doesNotMatch(lines[0] ?? '', /▰/)
  assert.doesNotMatch(lineOf(lines, 'w-core'), /DROVE-3/)
  assert.match(lineOf(board.renderFrame(input(120), 0), 'w-core'), /DROVE-3/)
})

test('NO_COLOR turns colour off even when FORCE_COLOR is set; FORCE_COLOR paints a pipe', () => {
  assert.equal(board.colorDepthOf({ NO_COLOR: '1', FORCE_COLOR: '3' }, true), 0)
  assert.equal(board.colorDepthOf({ NO_COLOR: '1' }, true), 0)
  assert.equal(board.colorDepthOf({}, false), 0)
  assert.equal(board.colorDepthOf({ TERM: 'dumb' }, true), 0)
  assert.equal(board.colorDepthOf({ FORCE_COLOR: '1' }, false), 8)
  assert.equal(board.colorDepthOf({ FORCE_COLOR: '1', COLORTERM: 'truecolor' }, false), 24)
  assert.equal(board.colorDepthOf({ FORCE_COLOR: '0' }, true), 0)
  assert.equal(board.colorDepthOf({ COLORTERM: '24bit' }, true), 24)
  assert.equal(board.colorDepthOf({ TERM: 'xterm-256color' }, true), 8)
  for (const line of board.renderFrame(input(120), board.colorDepthOf({ NO_COLOR: '1' }, true))) assert.doesNotMatch(line, ESC)
})

test('colour is foreground only: no background escape anywhere', () => {
  const text = board.renderFrame(input(120), 24).join('\n')
  assert.match(text, /\x1b\[38;2;/)
  assert.doesNotMatch(text, /\x1b\[(?:[0-9;]*;)?(?:4[0-9]|48;)/)
  assert.doesNotMatch(board.renderFrame(input(120), 8).join('\n'), /\x1b\[(?:[0-9;]*;)?(?:4[0-9]|48;)/)
})

test('each seat state maps to its glyph and its colour', () => {
  const cases: [SeatState, string][] = [['working', 'working'], ['idle', 'good'], ['done', 'good'], ['blocked', 'alert'], ['needs-input', 'alert'], ['gone', 'dim'], ['starting', 'muted']]
  for (const [state, tone] of cases) assert.equal(STATUS_TONE[state], tone, state)
  const seats = (['working', 'idle', 'done', 'blocked', 'starting'] as const).map((state, at) => seat({ name: `w-${state}`, state, spawnedAt: `2026-10-09T10:0${at}:00.000Z` }))
  const lines = board.renderFrame({ ...input(120), roster: { ...ROSTER, seats }, status: {} }, 24)
  for (const { name, state } of seats) {
    const line = lineOf(lines, name)
    assert.ok(line.includes(`${board.sgrOf(STATUS_TONE[state], false, 24)}${statusGlyph(state)}`), `${state} glyph`)
    assert.ok(line.includes(`${board.sgrOf(STATUS_TONE[state], true, 24)}${name}`), `${state} name`)
  }
  assert.equal(board.TONE_COLOR.working, '#89b4fa')
  assert.equal(board.TONE_COLOR.alert, '#f38ba8')
  assert.equal(board.TONE_COLOR.dim, '#585b70')
})

test('an asking seat shows ?, its question in red, and a stripe that pulses then stays red', () => {
  const alert = board.sgrOf('alert', false, 24)
  const dim = board.sgrOf('dim', false, 24)
  const stripe = (frame: number, now = NOW) => lineOf(board.renderFrame(input(120, 30, { frame, now }), 24), 'w-board')
  assert.ok(stripe(0).includes(`${alert}▌`))
  assert.ok(stripe(1).includes(`${dim}▌`))
  assert.ok(stripe(0).includes(`${alert}?`))
  assert.ok(stripe(0).includes(`${alert}Which width is the minimum?`))
  const later = NOW + PULSE_MS + 1_000
  assert.ok(stripe(1, later).includes(`${alert}▌`))
})

test('a gone seat leaves the rows and shows in the timeline', () => {
  const lines = board.renderFrame(input(120), 24)
  assert.ok(!lines.slice(0, 9).some(line => line.includes('w-old')))
  const gone = lineOf(lines, 'its pane closed')
  assert.ok(gone.includes(`${board.sgrOf('alert', false, 24)}✕`))
})

test('the spinner turns only while something moves', () => {
  assert.equal(board.isAnimated(input(120)), true)
  const still = ROSTER.seats.map(each => ({ ...each, state: each.state === 'working' ? ('idle' as const) : each.state }))
  assert.equal(board.isAnimated({ ...input(120), roster: { ...ROSTER, seats: still }, status: {} }), false)
  assert.notEqual(lineOf(board.renderFrame(input(120, 30, { frame: 0 }), 0), 'w-runtime'), lineOf(board.renderFrame(input(120, 30, { frame: 1 }), 0), 'w-runtime'))
})

test('the lead row says what the lead owes, and a planner bridge nobody holds', () => {
  assert.match(lineOf(board.renderFrame(input(120), 0), 'lead'), /waiting · owes 1 review/)
  const viaMod = { ...input(120), run: { ...RUN, planner: { ...RUN.planner, viaMod: true } } }
  assert.match(lineOf(board.renderFrame(viaMod, 0), 'lead'), /Drove bridge stopped: no planner session holds it/)
  assert.doesNotMatch(lineOf(board.renderFrame({ ...viaMod, bridgeHeld: true }, 0), 'lead'), /bridge/)
})

test('all done becomes the heading', () => {
  const seats = [seat({ name: 'w-a', state: 'done', lastReport: { id: 'r', kind: 'done', expects: 'none', summary: 'ok', at: '2026-10-09T10:30:00.000Z' } })]
  assert.match(board.renderFrame({ ...input(120), roster: { ...ROSTER, seats }, status: {} }, 0)[0] ?? '', /✓ all done · 42m$/)
})

test('text from a worker cannot carry an escape sequence into the frame', () => {
  const status = { 'w-runtime': { activity: 'evil \x1b[2J\x1b[41mred\nline', at: '2026-10-09T10:41:00.000Z' } }
  for (const line of board.renderFrame({ ...input(120), status }, 0)) assert.doesNotMatch(line, ESC)
})

test('256-colour terminals get the nearest palette index', () => {
  assert.equal(board.ansi256('#000000'), 16)
  assert.equal(board.ansi256('#ffffff'), 231)
  assert.match(board.sgrOf('working', true, 8), /^\x1b\[1;38;5;\d+m$/)
})

test('a live frame redraws in place: home, clear to line end, clear below, never a full clear', () => {
  const text = board.paintFrame(['a', 'b'])
  assert.match(text, /\x1b\[H/)
  assert.match(text, /a\x1b\[K\r\nb\x1b\[K\x1b\[J/)
  assert.doesNotMatch(text, /\x1b\[2J/)
})

const makeHome = async (): Promise<{ deps: Deps }> => {
  const home = await mkdtemp(join(tmpdir(), 'drove-board-'))
  await saveRun(home, RUN)
  await writeJsonAtomic(join(runDir(home, RUN.id), 'roster.json'), ROSTER)
  for (const event of EVENTS) await appendJsonl(join(runDir(home, RUN.id), 'events.jsonl'), event)
  for (const [name, status] of Object.entries(STATUS)) {
    mkdirSync(seatDir(home, RUN.id, name), { recursive: true })
    await writeFile(join(seatDir(home, RUN.id, name), 'mod.json'), JSON.stringify(status))
  }
  return { deps: { home, clock: { now: () => new Date(NOW) } } as unknown as Deps }
}

test('stdout not a TTY: one plain frame, even without --once', async () => {
  const { deps } = await makeHome()
  const written: string[] = []
  await board.runBoard(deps, RUN.id, false, { write: text => void written.push(text), columns: () => undefined, rows: () => undefined, isTTY: false, depth: board.colorDepthOf({}, false), offsetMinutes: 0 })
  assert.equal(written.length, 1)
  assert.doesNotMatch(written[0] ?? '', ESC)
  assert.match(written[0] ?? '', /^◆ drove Build Drove/)
  assert.match(written[0] ?? '', /w-runtime .*editing src\/herdr\.ts/)
  assert.match(written[0] ?? '', /drove-20261009-1000-a3f1/)
  assert.ok((written[0] ?? '').split('\n').every(line => board.widthOf(line) <= board.ONCE_COLUMNS))
})

test('--once on a TTY with NO_COLOR is one plain frame and never enters the alternate screen', async () => {
  const { deps } = await makeHome()
  const written: string[] = []
  await board.runBoard(deps, RUN.id, true, { write: text => void written.push(text), columns: () => 80, rows: () => 24, isTTY: true, depth: board.colorDepthOf({ NO_COLOR: '1' }, true), offsetMinutes: 0 })
  assert.equal(written.length, 1)
  assert.doesNotMatch(written.join(''), ESC)
})

test('live mode enters the alternate screen, hides the cursor, redraws on resize, and restores both when stopped', async () => {
  const { deps } = await makeHome()
  const written: string[] = []
  const controller = new AbortController()
  let resize: (() => void) | undefined
  let columns = 120
  const done = board.runBoard(deps, RUN.id, false, {
    write: text => {
      written.push(text)
      if (written.length === 2) {
        columns = 60
        resize?.()
      }
      if (written.length === 3) controller.abort()
    },
    columns: () => columns,
    rows: () => 24,
    isTTY: true,
    depth: 24,
    offsetMinutes: 0,
    signal: controller.signal,
    frameMs: 5,
    pollMs: 5,
    onResize: listener => {
      resize = listener
      return () => (resize = undefined)
    },
  })
  await done
  assert.equal(written[0], board.ENTER)
  assert.equal(written.at(-1), board.LEAVE)
  assert.match(written[1] ?? '', /\x1b\[H/)
  assert.ok(stripAnsi(written[2] ?? '').split('\r\n').every(line => board.widthOf(line) <= 60))
  assert.equal(resize, undefined)
})

const fakeInput = () => {
  const calls: string[] = []
  let listener: ((chunk: Buffer | string) => void) | undefined
  return {
    calls,
    send: (chunk: string) => listener?.(chunk),
    input: {
      setRawMode: (raw: boolean) => void calls.push(`raw:${raw}`),
      resume: () => void calls.push('resume'),
      pause: () => void calls.push('pause'),
      onData: (next: (chunk: Buffer | string) => void) => {
        listener = next
        calls.push('listen')
        return () => {
          listener = undefined
          calls.push('unlisten')
        }
      },
    },
  }
}

const liveIo = (written: string[], input?: board.BoardInput): board.BoardIo => ({
  write: text => void written.push(text),
  columns: () => 80,
  rows: () => 24,
  isTTY: true,
  depth: 24,
  offsetMinutes: 0,
  frameMs: 5,
  pollMs: 5,
  input,
})

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('live mode puts input in raw mode, ignores wheel, arrows and letters, and stops on q', async () => {
  const { deps } = await makeHome()
  const written: string[] = []
  const fake = fakeInput()
  const done = board.runBoard(deps, RUN.id, false, liveIo(written, fake.input))
  await pause(30)
  assert.deepEqual(fake.calls.slice(0, 3), ['raw:true', 'resume', 'listen'])
  const before = written.length
  const typed = ['\x1b[A', '\x1b[<64;10;5M', 'x', 'j']
  for (const chunk of typed) fake.send(chunk)
  await pause(30)
  assert.ok(!written.slice(before).includes(board.LEAVE))
  assert.ok(!fake.calls.includes('raw:false'))
  fake.send('q')
  await done
  assert.ok(fake.calls.includes('raw:false'))
  assert.ok(fake.calls.includes('pause'))
  assert.equal(written.at(-1), board.LEAVE)
})

test('live mode restores raw mode on Ctrl-C and on SIGINT', async () => {
  const { deps } = await makeHome()
  const ctrlC = fakeInput()
  const first = board.runBoard(deps, RUN.id, false, liveIo([], ctrlC.input))
  await pause(20)
  ctrlC.send('\x03')
  await first
  assert.ok(ctrlC.calls.includes('raw:false'))
  assert.equal(ctrlC.calls.at(-1), 'pause')

  const sig = fakeInput()
  const second = board.runBoard(deps, RUN.id, false, liveIo([], sig.input))
  await pause(20)
  process.emit('SIGINT')
  await second
  assert.ok(sig.calls.includes('raw:false'))
  assert.ok(sig.calls.includes('unlisten'))
})

test('--once never touches input', async () => {
  const { deps } = await makeHome()
  const fake = fakeInput()
  await board.runBoard(deps, RUN.id, true, liveIo([], fake.input))
  assert.deepEqual(fake.calls, [])
})
