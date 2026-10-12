import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { loadRoster, updateRoster } from '../src/roster.ts'
import type { Deps, Identity } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_OWNS', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const planner = (deps: Deps): Identity => ({ home: deps.home, run: RUN, role: 'planner', seat: 'planner' })

const setup = async (fake = new FakeHerdr()) => {
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo, [])
  return { fake, repo, deps, identity: planner(deps) }
}

const brief = 'Build the widget.'
const OWNS = ['src/guard.ts', 'test/**/*.test.ts', '{README,DESIGN}.md']

// The env of the pane Drove placed last (a tab create or a pane split carries one --env per variable).
const placedEnv = (fake: FakeHerdr): Record<string, string> => {
  const call = fake.calls.filter(item => (item[1] === 'tab' && item[2] === 'create') || (item[1] === 'pane' && item[2] === 'split')).at(-1) ?? []
  return Object.fromEntries(call.flatMap((arg, i) => (arg === '--env' && call[i + 1] ? [[call[i + 1]?.split('=')[0] ?? '', call[i + 1]?.slice((call[i + 1]?.indexOf('=') ?? 0) + 1) ?? '']] : [])))
}

test('spawn --owns saves the globs on the seat and puts them in the worker env as JSON', async () => {
  const { fake, deps, identity } = await setup()
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, owns: [' ./src/guard.ts ', 'test/**/*.test.ts', '{README,DESIGN}.md', 'src/guard.ts'] })
  assert.equal(spawned.ok, true, spawned.text)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats[0]?.owns, OWNS)
  assert.deepEqual(JSON.parse(placedEnv(fake).DROVE_OWNS ?? 'null'), OWNS)
})

test('a seat spawned with no owns has no DROVE_OWNS, and an empty list is the same', async () => {
  const { fake, deps, identity } = await setup()
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })).ok, true)
  assert.equal('DROVE_OWNS' in placedEnv(fake), false)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.owns, undefined)
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-ui', kind: 'claude', brief, owns: [] })).ok, true)
  assert.equal('DROVE_OWNS' in placedEnv(fake), false)
})

test('owns globs must stay inside the worktree', async () => {
  const { deps, identity } = await setup()
  for (const owns of [['../other/**'], ['/etc/hosts'], ['~/notes.md'], ['src/../../x']]) {
    const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, owns })
    assert.equal(spawned.ok, false, owns.join())
    assert.equal(!spawned.ok && spawned.code, 'usage')
    assert.match(spawned.text, /--owns takes globs relative to the worktree/)
  }
  assert.equal((await loadRoster(deps.home, RUN)).seats.length, 0)
})

test('owns survives a promote: the relaunched worker gets the same DROVE_OWNS', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, owns: OWNS, maxMinutes: 2, maxCost: 3 })
  await updateRoster(deps.home, RUN, roster => ({
    ...roster,
    seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, owes: 'answer' as const, reviewChanges: 3, attention: [{ seat: seat.name, reason: 'review-loop' as const, detail: 'three changes', at: '2026-10-09T10:30:00.000Z' }], lastReport: { id: 'r-1', kind: 'promote' as const, expects: 'answer' as const, summary: 'stuck', at: '2026-10-09T10:30:00.000Z' } })),
  }))
  fake.setStatus('w-api', 'idle')
  const promoted = await commands.promote(deps, identity, { seat: 'w-api', model: 'opus', effort: 'high', reason: 'subtle bug' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.equal(fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').length, 2)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats[0]?.owns, OWNS)
  assert.deepEqual(JSON.parse(placedEnv(fake).DROVE_OWNS ?? 'null'), OWNS)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.maxMinutes, seat?.maxCost], [2, 3])
  assert.equal(seat?.reviewChanges ?? 0, 0)
  assert.equal(seat?.attention.some(item => item.reason === 'review-loop'), false)
})

test('owns and time/cost bounds survive up --seat: a relaunched seat gets the same DROVE_OWNS', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, owns: OWNS, maxMinutes: 2, maxCost: 3 })
  fake.agents.clear()
  await commands.roster(deps, { run: RUN, repo: '/x' }, false)
  const relaunched = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-api')
  assert.equal(relaunched.ok, true, relaunched.text)
  assert.deepEqual(JSON.parse(placedEnv(fake).DROVE_OWNS ?? 'null'), OWNS)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.maxMinutes, seat?.maxCost], [2, 3])
})

test('owns and the budgets survive a migrate to the other provider', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, owns: OWNS, maxTurns: 9, maxMinutes: 1.5, maxCost: 2.25 })
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, reviewChanges: 3, attention: [{ seat: seat.name, reason: 'review-loop' as const, detail: 'three changes', at: seat.stateAt }] })) }))
  const migrated = await commands.migrate(deps, identity, { seat: 'w-api', kind: 'codex', reason: 'Claude usage limit' })
  assert.equal(migrated.ok, true, migrated.text)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.kind, seat?.owns, seat?.maxTurns, seat?.maxMinutes, seat?.maxCost], ['codex', OWNS, 9, 1.5, 2.25])
  assert.equal(seat?.reviewChanges, 0)
  assert.equal(seat?.attention.some(item => item.reason === 'review-loop'), false)
  assert.deepEqual(JSON.parse(placedEnv(fake).DROVE_OWNS ?? 'null'), OWNS)
})

test('maxTurns and maxTokens are saved per seat; the config maxTurns is the default and a spawn option wins', async () => {
  const { deps, identity } = await setup()
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ maxTurns: 40 }))
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })).ok, true)
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-b', kind: 'claude', brief, maxTurns: 12, maxTokens: 3_000_000 })).ok, true)
  const seats = (await loadRoster(deps.home, RUN)).seats
  assert.deepEqual([seats[0]?.maxTurns, seats[0]?.maxTokens], [40, undefined])
  assert.deepEqual([seats[1]?.maxTurns, seats[1]?.maxTokens], [12, 3_000_000])
})

test('with no config maxTurns and no option a seat has no turn budget; a bad budget is a usage error', async () => {
  const { deps, identity } = await setup()
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })).ok, true)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.maxTurns, undefined)
  for (const request of [{ maxTurns: 0 }, { maxTurns: 1.5 }, { maxTurns: Number.NaN }, { maxTokens: -5 }]) {
    const spawned = await commands.spawn(deps, identity, { seat: 'w-b', kind: 'claude', brief, ...request })
    assert.equal(!spawned.ok && spawned.code, 'usage', JSON.stringify(request))
    assert.match(spawned.text, /--max-(turns|tokens) must be a whole number of at least 1/)
  }
})

test('changes verdicts raise a human review-loop item at the configured limit and approval clears it', async () => {
  const { deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const { attentionCandidates } = await import('../src/attention.ts')
  const { loadRun } = await import('../src/roster.ts')
  const run = (await loadRun(deps.home, RUN))!
  for (let i = 1; i <= 3; i += 1) {
    const sent = await commands.send(deps, identity, { seat: 'w-api', kind: 'verdict', verdict: 'changes', body: 'Fix the widget.' })
    assert.equal(sent.ok, true, sent.text)
    const roster = await loadRoster(deps.home, RUN)
    const items = attentionCandidates({ run, roster, events: [], reports: [], status: {}, at: deps.clock.now().toISOString() }).filter(item => item.kind === 'review-loop')
    assert.equal(items.length, i >= 3 ? 1 : 0)
    if (i === 3) assert.equal(items[0]?.text, 'w-api has had 3 rounds of changes: re-scope it, promote it, or take it over')
  }
  assert.equal((await commands.send(deps, identity, { seat: 'w-api', kind: 'verdict', verdict: 'approve', body: 'Approved.' })).ok, true)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.attention.some(item => item.reason === 'review-loop'), false)
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ reviewLoopLimit: 1 }))
  await commands.send(deps, identity, { seat: 'w-api', kind: 'verdict', verdict: 'changes', body: 'Fix it.' })
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.attention.some(item => item.reason === 'review-loop'), true)
  await commands.close(deps, identity, 'w-api', false)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.attention.length, 0)
})

test('time and cost options accept positive fractions and reject invalid bounds', async () => {
  const { deps, identity } = await setup()
  for (const request of [{ maxMinutes: 0 }, { maxMinutes: Number.NaN }, { maxCost: -1 }, { maxCost: Number.POSITIVE_INFINITY }]) {
    const result = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, ...request })
    assert.equal(!result.ok && result.code, 'usage')
  }
  const { spawnRequestOf } = await import('../src/cli.ts')
  const request = spawnRequestOf({ kind: 'claude', 'max-minutes': '1.5', 'max-cost': '0.25' }, ['w-api'], brief)
  assert.deepEqual([request.maxMinutes, request.maxCost], [1.5, 0.25])
  assert.equal((await commands.spawn(deps, identity, request)).ok, true)
})

test('a Claude promote through the mod resets review rounds without restarting the agent', async () => {
  const { deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const { loadRun, saveRun } = await import('../src/roster.ts')
  const run = (await loadRun(deps.home, RUN))!
  await saveRun(deps.home, { ...run, planner: { ...run.planner, viaMod: true } })
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, reviewChanges: 3, attention: [{ seat: seat.name, reason: 'review-loop' as const, detail: 'three changes', at: seat.stateAt }] })) }))
  const result = await commands.promote(deps, identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.equal(result.ok, true, result.text)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.equal(seat?.reviewChanges, 0)
  assert.equal(seat?.attention.some(item => item.reason === 'review-loop'), false)
})
