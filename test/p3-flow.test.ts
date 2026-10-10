import assert from 'node:assert/strict'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import { seatDir } from '../src/paths.ts'
import { loadRoster, updateRoster } from '../src/roster.ts'
import { appendJsonl } from '../src/store.ts'
import type { Identity } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20 })
})

test('codex worker lifecycle: spawn, thread discovery from the session-start hook, queue delivery, review, close', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake, 'flow')
  const repo = await makeRepo('flow-repo')
  await seedRun(deps, repo)
  const planner: Identity = { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }

  const spawned = await commands.spawn(deps, planner, { seat: 'w-cx', kind: 'codex', cairn: 'DROVE-9', brief: 'Write the parser.' })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.sessionId, undefined)

  const early = await commands.send(deps, planner, { seat: 'w-cx', kind: 'message', body: 'also add tests' })
  assert.equal(early.ok, true, early.text)
  assert.equal(fake.queued.length, 0)
  assert.equal(fake.prompts.length, 2)

  await appendJsonl(join(seatDir(deps.home, RUN, 'w-cx'), 'hooks.jsonl'), { at: deps.clock.now().toISOString(), agent: 'codex', event: 'session-start', sessionId: 'thread-42' })
  deps.clock.advance(1000)
  await commands.roster(deps, { run: RUN, repo }, false)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.sessionId, 'thread-42')

  await updateRoster(deps.home, RUN, roster => ({
    ...roster,
    seats: roster.seats.map(seat => ({ ...seat, owes: 'review' as const, lastReport: { id: 'r-1', kind: 'done' as const, expects: 'review' as const, summary: 'parser done', at: deps.clock.now().toISOString() } })),
  }))
  fake.setStatus('w-cx', 'working')
  await commands.roster(deps, { run: RUN, repo }, false)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.state, 'idle')

  const verdict = await commands.send(deps, planner, { seat: 'w-cx', kind: 'verdict', verdict: 'approve', body: 'looks good' })
  assert.equal(verdict.ok, true, verdict.text)
  assert.equal(fake.queued.length, 1)
  assert.equal(fake.queued[0]?.thread, 'thread-42')
  assert.match(fake.queued[0]?.text ?? '', /kind=verdict verdict=approve expects=none/)
  assert.equal(fake.prompts.length, 2)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.owes, 'none')

  const closed = await commands.close(deps, planner, 'w-cx', false)
  assert.equal(closed.ok, true, closed.text)
  assert.equal(fake.prompts.at(-1)?.text, '/quit')
  assert.equal(fake.agents.size, 0)
})

test('a blocked seat queues a verdict, then delivers it after the dialog is answered', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake, 'flow')
  const repo = await makeRepo('flow-repo')
  await seedRun(deps, repo)
  const planner: Identity = { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }
  await commands.spawn(deps, planner, { seat: 'w-ui', kind: 'claude', brief: 'Do the UI.' })
  fake.setStatus('w-ui', 'blocked')
  const sent = await commands.send(deps, planner, { seat: 'w-ui', kind: 'verdict', verdict: 'changes', body: 'fix spacing' })
  assert.match(sent.text, /Queued verdict changes/)
  assert.equal(fake.prompts.length, 1)

  const { flushPending } = await import('../src/deliver.ts')
  const { loadRun } = await import('../src/roster.ts')
  const run = await loadRun(deps.home, RUN)
  assert.ok(run)
  assert.equal((await flushPending(deps, run, 'w-ui'))[0]?.ok, false)
  fake.setStatus('w-ui', 'idle')
  assert.deepEqual((await flushPending(deps, run, 'w-ui')).map(item => item.ok), [true])
  assert.match(fake.prompts[1]?.text ?? '', /fix spacing/)
})
