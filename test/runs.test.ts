import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as herdr from '../src/herdr.ts'
import { loadRoster } from '../src/roster.ts'
import type { Deps, Identity } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, makeSeat, RUN, seedRun } from './p3-helpers.ts'

const RUN_B = 'drove-20261009-1100-b7c2'
const brief = 'Build the widget.'

beforeEach(() => {
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const plannerOf = (deps: Deps, run: string): Identity => ({ home: deps.home, run, role: 'planner', seat: 'planner' })

test('two runs on one herdr each have a w-core and never address each other\'s agent', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  await seedRun(deps, await makeRepo('a'))
  await seedRun(deps, await makeRepo('b'), [], { id: RUN_B })
  const [a, b] = [plannerOf(deps, RUN), plannerOf(deps, RUN_B)]
  assert.equal((await commands.spawn(deps, a, { seat: 'w-core', kind: 'claude', brief })).ok, true)
  assert.equal((await commands.spawn(deps, b, { seat: 'w-core', kind: 'claude', brief })).ok, true)

  assert.deepEqual([...fake.agents.keys()].sort(), ['w-core-a3f1', 'w-core-b7c2'])
  const paneOf = async (run: string) => (await loadRoster(deps.home, run)).seats[0]?.paneId
  assert.notEqual(await paneOf(RUN), await paneOf(RUN_B))
  assert.equal(fake.agents.get('w-core-a3f1')?.paneId, await paneOf(RUN))
  assert.equal(fake.agents.get('w-core-b7c2')?.paneId, await paneOf(RUN_B))
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.name, 'w-core')

  const before = fake.calls.length
  assert.equal((await commands.prompt(deps, a, 'w-core', 'carry on')).ok, true)
  assert.equal((await commands.capture(deps, { run: RUN, repo: '/nowhere' }, 'w-core', 20)).ok, true)
  const touched = fake.calls.slice(before).filter(call => call[0] === 'herdr' && call[1] === 'agent').map(call => call[3])
  assert.ok(touched.length > 0)
  assert.ok(touched.every(target => target === fake.agents.get('w-core-a3f1')?.paneId), `addressed ${touched.join(', ')}`)

  const bPane = await paneOf(RUN_B)
  assert.equal((await commands.close(deps, a, 'w-core', false)).ok, true)
  assert.deepEqual([...fake.agents.keys()], ['w-core-b7c2'])
  assert.equal(fake.agents.get('w-core-b7c2')?.paneId, bPane)
  assert.ok(!fake.prompts.some(prompt => prompt.target === bPane))
  assert.ok(!fake.calls.some(call => call[1] === 'pane' && call[2] === 'close' && call[3] === bPane))
})

test('an agent that herdr holds under the bare seat name is still reached through its pane', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  const seat = makeSeat('w-api', { state: 'working' })
  await seedRun(deps, await makeRepo(), [seat])
  fake.agents.set('w-api', { name: 'w-api', paneId: seat.paneId ?? '', tabId: 'w1:t1', status: 'idle' })
  const identity = plannerOf(deps, RUN)
  assert.equal((await commands.roster(deps, { run: RUN, repo: '/nowhere' }, false)).ok, true)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.state, 'idle')
  assert.equal((await commands.prompt(deps, identity, 'w-api', 'carry on')).ok, true)
  assert.equal(fake.prompts.at(-1)?.target, seat.paneId)
  const closed = await commands.close(deps, identity, 'w-api', false)
  assert.equal(closed.ok, true, closed.text)
  assert.equal(fake.agents.size, 0)
})

test('a seat whose worktree another run of the same repo still holds is refused, and allowed once it is closed', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  const repo = await makeRepo()
  await seedRun(deps, repo)
  await seedRun(deps, repo, [], { id: RUN_B })
  const [a, b] = [plannerOf(deps, RUN), plannerOf(deps, RUN_B)]
  assert.equal((await commands.spawn(deps, a, { seat: 'w-core', kind: 'claude', brief })).ok, true)

  const refused = await commands.spawn(deps, b, { seat: 'w-core', kind: 'codex', brief })
  assert.equal(!refused.ok && refused.code, 'seat-taken')
  assert.match(refused.text, new RegExp(`open seat w-core of run ${RUN}`))
  assert.match(refused.text, /pick another seat name/)
  assert.deepEqual((await loadRoster(deps.home, RUN_B)).seats, [])
  assert.equal(fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').length, 1)
  assert.equal(existsSync(join(repo, '.claude', 'worktrees', 'w-core')), true)

  assert.equal((await commands.spawn(deps, b, { seat: 'w-other', kind: 'claude', brief })).ok, true)
  assert.equal((await commands.close(deps, a, 'w-core', false)).ok, true)
  const retried = await commands.spawn(deps, b, { seat: 'w-core', kind: 'claude', brief })
  assert.equal(retried.ok, true, retried.text)
})

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/

test('agentName tags the seat with the run so two runs never share a herdr agent name', () => {
  assert.equal(herdr.agentName('drove-20261010-1934-87d7', 'w-core'), 'w-core-87d7')
  assert.notEqual(herdr.agentName('drove-20261010-1934-87d7', 'w-core'), herdr.agentName('drove-20261010-1935-a3f1', 'w-core'))
  assert.equal(herdr.agentName('drove-20261010-1934-87d7', 'w-core'), herdr.agentName('drove-20261010-1934-87d7', 'w-core'))
})

test('agentName stays within herdr\'s name rule for a long seat and keeps long seats apart', () => {
  const run = 'drove-20261010-1934-87d7'
  const first = herdr.agentName(run, `${'a'.repeat(31)}x`)
  const second = herdr.agentName(run, `${'a'.repeat(31)}y`)
  for (const name of [first, second, herdr.agentName(run, 'a'), herdr.agentName('odd run id', 'w-core')]) assert.match(name, AGENT_NAME)
  assert.equal(first.length, 32)
  assert.notEqual(first, second)
  assert.ok(first.endsWith('-87d7'))
})

test('close with removeWorktree refuses before closing anything when the caller stands in that worktree', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  const seat = makeSeat('w-api', { state: 'working' })
  await seedRun(deps, await makeRepo(), [seat])
  fake.agents.set('w-api', { name: 'w-api', paneId: seat.paneId ?? '', tabId: 'w1:t1', status: 'idle' })
  const identity = plannerOf(deps, RUN)
  const refused = await commands.close(deps, identity, 'w-api', true, join(seat.worktree, 'src'))
  assert.equal(!refused.ok && refused.code, 'cwd-in-worktree')
  assert.match(refused.text, /cd to the repo/)
  assert.equal(fake.agents.size, 1)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.state, 'working')
  const kept = await commands.close(deps, identity, 'w-api', false, join(seat.worktree, 'src'))
  assert.equal(kept.ok, true, kept.text)
})

test('agentTarget uses the pane id when the seat has one, which also reaches a bare-named agent', () => {
  assert.equal(herdr.agentTarget('drove-20261010-1934-87d7', { name: 'w-core', paneId: 'w1:p4' }), 'w1:p4')
  assert.equal(herdr.agentTarget('drove-20261010-1934-87d7', { name: 'w-core' }), 'w-core-87d7')
})
