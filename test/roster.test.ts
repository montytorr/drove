import assert from 'node:assert/strict'
import { mkdir, mkdtemp, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runDir } from '../src/paths.ts'
import * as roster from '../src/roster.ts'
import type { Roster, RunMeta, Seat } from '../src/types.ts'

const temp = (): Promise<string> => mkdtemp(join(tmpdir(), 'drove-roster-'))

const seat = (name: string, extra: Partial<Seat> = {}): Seat => ({
  name,
  kind: 'claude',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  worktree: `/repo/.claude/worktrees/${name}`,
  branch: `drove/${name}`,
  state: 'working',
  stateAt: '2026-10-09T10:00:00.000Z',
  spawnedAt: '2026-10-09T10:00:00.000Z',
  owes: 'none',
  attention: [],
  ...extra,
})

const meta = (id: string, extra: Partial<RunMeta> = {}): RunMeta => ({
  v: 1,
  id,
  repo: '/repo',
  base: 'main',
  hasRemote: true,
  createdAt: '2026-10-09T10:00:00.000Z',
  status: 'up',
  budget: 5,
  planner: { kind: 'claude', model: 'claude-opus-5-5', effort: 'high', viaMod: false },
  ...extra,
})

const empty: Roster = { v: 1, run: 'r', seats: [], updatedAt: '' }

test('CLOSED_STATES', () => {
  for (const state of ['closed', 'gone', 'down'] as const) assert.ok(roster.CLOSED_STATES.has(state))
  assert.ok(!roster.CLOSED_STATES.has('working'))
})

test('run.json round-trips and the home is mode 700', async () => {
  const home = join(await temp(), '.drove')
  assert.equal(await roster.loadRun(home, 'r1'), undefined)
  await roster.saveRun(home, meta('r1'))
  assert.deepEqual(await roster.loadRun(home, 'r1'), meta('r1'))
  assert.equal((await stat(home)).mode & 0o777, 0o700)
})

test('latestRunFor picks the newest run of a repo, optionally by status', async () => {
  const home = await temp()
  await roster.saveRun(home, meta('old', { createdAt: '2026-10-08T10:00:00.000Z', status: 'down' }))
  await roster.saveRun(home, meta('new', { createdAt: '2026-10-09T10:00:00.000Z', status: 'up' }))
  await roster.saveRun(home, meta('other', { repo: '/elsewhere', createdAt: '2026-10-10T10:00:00.000Z' }))
  assert.equal((await roster.latestRunFor(home, '/repo'))?.id, 'new')
  assert.equal((await roster.latestRunFor(home, '/repo', 'down'))?.id, 'old')
  assert.equal(await roster.latestRunFor(home, '/none'), undefined)
  assert.equal(await roster.latestRunFor(await temp(), '/repo'), undefined)
})

test('loadRoster starts empty and updateRoster persists changes', async () => {
  const home = await temp()
  assert.deepEqual((await roster.loadRoster(home, 'r1')).seats, [])
  const updated = await roster.updateRoster(home, 'r1', current => roster.upsertSeat(current, seat('w-api')))
  assert.equal(updated.seats.length, 1)
  assert.equal((await roster.loadRoster(home, 'r1')).seats[0]?.name, 'w-api')
})

test('concurrent updateRoster calls do not lose writes', async () => {
  const home = await temp()
  await Promise.all(Array.from({ length: 12 }, (_, index) => roster.updateRoster(home, 'r1', current => roster.upsertSeat(current, seat(`w-${index}`)))))
  assert.equal((await roster.loadRoster(home, 'r1')).seats.length, 12)
})

test('a stale roster lock is stolen by updateRoster', async () => {
  const home = await temp()
  const lock = join(runDir(home, 'r1'), 'roster.lock')
  await mkdir(lock, { recursive: true })
  const old = new Date(Date.now() - 60_000)
  await utimes(lock, old, old)
  await roster.updateRoster(home, 'r1', current => roster.upsertSeat(current, seat('w-api')))
  assert.equal((await roster.loadRoster(home, 'r1')).seats.length, 1)
})

test('seat CRUD helpers are pure', () => {
  const one = roster.upsertSeat(empty, seat('a'))
  const two = roster.upsertSeat(one, seat('b'))
  const closed = roster.upsertSeat(two, seat('a', { state: 'closed' }))
  assert.equal(empty.seats.length, 0)
  assert.equal(two.seats.length, 2)
  assert.equal(closed.seats.length, 2)
  assert.equal(roster.findSeat(closed, 'a')?.state, 'closed')
  assert.equal(roster.findSeat(closed, 'zz'), undefined)
  assert.deepEqual(roster.openSeats(closed).map(item => item.name), ['b'])
})

test('gridSlot: none, beside the first, then under the worker two places before', () => {
  const placed = (name: string, spawnedAt: string) => seat(name, { paneId: `p-${name}`, spawnedAt })
  assert.equal(roster.gridSlot([]), undefined)
  assert.equal(roster.gridSlot([seat('nopane')]), undefined)
  const a = placed('a', '2026-10-09T10:00:00.000Z')
  const b = placed('b', '2026-10-09T10:01:00.000Z')
  const c = placed('c', '2026-10-09T10:02:00.000Z')
  const d = placed('d', '2026-10-09T10:03:00.000Z')
  assert.deepEqual(roster.gridSlot([a]), { anchor: 'p-a', direction: 'right' })
  assert.deepEqual(roster.gridSlot([a, b]), { anchor: 'p-a', direction: 'down' })
  assert.deepEqual(roster.gridSlot([b, a, c]), { anchor: 'p-b', direction: 'down' })
  assert.deepEqual(roster.gridSlot([d, c, b, a]), { anchor: 'p-c', direction: 'down' })
})

test('isOverBudget is true when no room is left for one more seat', () => {
  const three = ['a', 'b', 'c'].reduce((current, name) => roster.upsertSeat(current, seat(name)), empty)
  assert.equal(roster.isOverBudget(three, 5), false)
  assert.equal(roster.isOverBudget(three, 3), true)
  assert.equal(roster.isOverBudget(roster.upsertSeat(three, seat('c', { state: 'closed' })), 3), false)
})

test('rosterLines describes open seats and lists gone ones', () => {
  const now = new Date('2026-10-09T10:10:00.000Z')
  assert.deepEqual(roster.rosterLines(empty, now), ['No seats are open.'])
  const lines = roster.rosterLines(
    {
      ...empty,
      seats: [
        seat('w-api', { cairn: 'DROVE-7', paneId: 'p1', owes: 'review', lastReport: { id: 'r', kind: 'done', expects: 'review', summary: 'tests pass', at: '2026-10-09T10:07:00.000Z' } }),
        seat('w-ui', { state: 'gone', attention: [{ seat: 'w-ui', reason: 'gone', detail: 'pane closed', at: '2026-10-09T10:09:00.000Z' }] }),
        seat('w-old', { state: 'closed' }),
      ],
    },
    now,
  )
  assert.equal(lines.length, 2)
  assert.match(lines[0] ?? '', /^- w-api \[working\] claude Sonnet 5\.5 medium · DROVE-7 · pane p1 · up 10m · last report done 3m ago: tests pass · waiting for your review$/)
  assert.match(lines[1] ?? '', /^- w-ui \[gone\].*attention: gone$/)
})

test('attentionOf collects items from seats that are not closed', () => {
  const item = (name: string) => ({ seat: name, reason: 'dialog' as const, detail: 'd', at: '2026-10-09T10:00:00.000Z' })
  const attention = roster.attentionOf({
    ...empty,
    seats: [seat('a', { attention: [item('a')] }), seat('b', { state: 'closed', attention: [item('b')] }), seat('c', { state: 'gone', attention: [item('c')] })],
  })
  assert.deepEqual(attention.map(entry => entry.seat), ['a', 'c'])
})
