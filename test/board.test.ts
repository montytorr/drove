import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { test } from 'node:test'
import * as board from '../src/board.ts'
import type { Attention, DroveEvent, Roster, RunMeta, Seat } from '../src/types.ts'
import { assertExports } from './helpers.ts'

const NOW = new Date('2026-10-09T10:42:00.000Z')

const RUN: RunMeta = {
  v: 1,
  id: 'drove-20261009-1000-a3f1',
  repo: '/Users/cal/maestro-dev/drove',
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

const ATTENTION: Attention[] = [
  { seat: 'w-guard', reason: 'codex-version-mismatch', detail: 'Codex CLI and app-server daemon versions differ (codex --version vs the daemon); align them. Drove will not answer the dialog', at: '2026-10-09T10:38:00.000Z' },
  { seat: 'w-store', reason: 'idle-without-report', detail: 'went idle at 10:20 with no report', at: '2026-10-09T10:41:00.000Z' },
]

const ROSTER: Roster = {
  v: 1,
  run: RUN.id,
  updatedAt: '2026-10-09T10:41:00.000Z',
  seats: [
    seat({ name: 'w-core', cairn: 'DROVE-3', state: 'done', stateAt: '2026-10-09T10:35:00.000Z', owes: 'review', lastReport: { id: 'r1', kind: 'done', expects: 'review', summary: 'P1 core state and protocol finished, 48 tests green', at: '2026-10-09T10:35:00.000Z' } }),
    seat({ name: 'w-guard', kind: 'codex', model: 'gpt-5.5-codex', effort: 'xhigh', cairn: 'DROVE-4', state: 'blocked', stateAt: '2026-10-09T10:38:00.000Z', attention: [ATTENTION[0]!] }),
    seat({ name: 'w-runtime', cairn: 'DROVE-5', state: 'working', stateAt: '2026-10-09T10:12:00.000Z', lastReport: { id: 'r2', kind: 'progress', expects: 'none', summary: 'herdr wrapper and launch specs written', at: '2026-10-09T10:30:00.000Z' } }),
    seat({ name: 'w-store', kind: 'codex', model: 'gpt-5.5-codex', effort: 'high', cairn: 'DROVE-6', state: 'idle', stateAt: '2026-10-09T10:20:00.000Z', attention: [ATTENTION[1]!] }),
    seat({ name: 'w-board', cairn: 'DROVE-7', state: 'needs-input', stateAt: '2026-10-09T10:41:30.000Z', owes: 'answer', lastReport: { id: 'r3', kind: 'question', expects: 'answer', summary: 'Need a types change for the color flag?', at: '2026-10-09T10:41:30.000Z' } }),
    seat({ name: 'w-old', state: 'closed', stateAt: '2026-10-09T09:00:00.000Z' }),
  ],
}

const EVENTS: DroveEvent[] = [
  { at: '2026-10-09T10:00:01.000Z', type: 'run.up' },
  { at: '2026-10-09T10:01:00.000Z', type: 'seat.spawn', seat: 'w-core' },
  { at: '2026-10-09T10:35:00.000Z', type: 'report', seat: 'w-core', data: { kind: 'done', summary: 'P1 finished' } },
  { at: '2026-10-09T10:38:00.000Z', type: 'attention', seat: 'w-guard', data: { reason: 'codex-version-mismatch' } },
  { at: '2026-10-09T10:41:30.000Z', type: 'report.pending', seat: 'w-board' },
]

const frame = (width: number, color = false) => board.renderBoard({ run: RUN, roster: ROSTER, events: EVENTS, attention: ATTENTION, now: NOW, width, color })

const golden = (name: string, actual: string) => {
  const path = new URL(`./fixtures/p5/${name}`, import.meta.url)
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(new URL('./fixtures/p5/', import.meta.url), { recursive: true })
    writeFileSync(path, `${actual}\n`)
  }
  assert.equal(`${actual}\n`, readFileSync(path, 'utf8'))
}

test('board exports its interface', () => {
  assertExports(board, ['renderBoard', 'runBoard'])
})

test('golden frame at width 80', () => golden('board-80.txt', frame(80)))
test('golden frame at width 140', () => golden('board-140.txt', frame(140)))

test('no line exceeds the width', () => {
  for (const width of [80, 100, 110, 140]) for (const line of frame(width).split('\n')) assert.ok([...line].length <= width, `${width}: ${line}`)
})

test('the attention list comes before the seats', () => {
  const text = frame(80)
  const attentionAt = text.indexOf('ATTENTION 2')
  assert.ok(attentionAt >= 0)
  assert.ok(text.indexOf('codex-version-mismatch') > attentionAt)
  assert.ok(attentionAt < text.indexOf('w-core'))
})

test('colour is optional and frames read the same without it', () => {
  const coloured = frame(80, true)
  assert.match(coloured, /\x1b\[/)
  assert.equal(coloured.replace(/\x1b\[[0-9;]*m/g, ''), frame(80))
})

test('an empty roster still renders', () => {
  const text = board.renderBoard({ run: RUN, roster: { ...ROSTER, seats: [] }, events: [], attention: [], now: NOW, width: 80 })
  assert.match(text, /ATTENTION none/)
  assert.match(text, /no seats yet/)
  assert.match(text, /no events yet/)
})

test('model and effort are never cut at width 80, and the report keeps 20 columns', () => {
  const lines = frame(80).split('\n')
  for (const seatRow of ROSTER.seats) {
    const line = lines.find((text) => !text.startsWith('!') && text.includes(` ${seatRow.name} `))
    assert.ok(line?.includes(board.modelEffort(seatRow.model, seatRow.effort)), `${seatRow.name}: ${line}`)
  }
  const core = lines.find((text) => text.includes(' w-core '))!
  assert.ok(core.includes('done: P1 core state and'), core)
})

test('short model forms', () => {
  assert.equal(board.shortModel('claude-sonnet-5-5'), 'sonnet 5.5')
  assert.equal(board.shortModel('claude-opus-5-5'), 'opus 5.5')
  assert.equal(board.shortModel('gpt-5.5-codex'), 'gpt-5.5')
  assert.equal(board.modelEffort('claude-sonnet-5-5', 'medium'), 'sonnet 5.5·m')
  assert.equal(board.modelEffort('gpt-5.5-codex', 'xhigh'), 'gpt-5.5·x')
  assert.deepEqual(['low', 'medium', 'high', 'xhigh', 'max'].map(board.effortShort), ['l', 'm', 'h', 'x', 'M'])
})

test('kind is a letter under 110 columns and a word from 110', () => {
  assert.match(frame(80), /w-guard\s+X /)
  assert.match(frame(110), /w-guard\s+codex /)
})

test('since formats ages', () => {
  assert.equal(board.since('2026-10-09T10:41:40.000Z', NOW), 'now')
  assert.equal(board.since('2026-10-09T10:12:00.000Z', NOW), '30m')
  assert.equal(board.since('2026-10-09T08:37:00.000Z', NOW), '2h05')
  assert.equal(board.since(undefined, NOW), '-')
})
