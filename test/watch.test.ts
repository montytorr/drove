import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWatcher, piggyback, readNewReports, shouldWake, BATCH_MS } from '../src/watch.ts'
import type { HerdrAgent } from '../src/types.ts'
import { join } from 'node:path'
import { appendJsonl } from '../src/store.ts'
import { deriveState, needsNudge } from '../src/detect.ts'
import { updateRoster } from '../src/roster.ts'
import { eventsOf, fakePorts, fileReport, rosterOf, setup } from './p4-helpers.ts'

const queued = (calls: string[][]) => calls.filter((argv) => argv[0] === 'codex')
const prompted = (calls: string[][]) => calls.filter((argv) => argv[0] === 'herdr' && argv[2] === 'prompt')

test('shouldWake: every kind but progress wakes', async () => {
  const ctx = await setup()
  const kinds = ['done', 'question', 'blocked', 'promote', 'progress'] as const
  const woken = await Promise.all(kinds.map(async (kind) => shouldWake(await fileReport(ctx, 'w-api', kind, 's'))))
  assert.deepEqual(woken, [true, true, true, true, false])
})

test('a pre-filled outbox is read exactly once across watcher restarts', async () => {
  const ctx = await setup()
  await fileReport(ctx, 'w-api', 'progress', 'warming up')
  await fileReport(ctx, 'w-api', 'done', 'api finished')
  const { ports } = fakePorts()
  const first = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await first.tick()
  ctx.clock.advance(BATCH_MS)
  await first.tick()
  first.stop()
  assert.equal(queued(ctx.calls).length, 1)

  const second = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  for (let i = 0; i < 4; i++) {
    ctx.clock.advance(BATCH_MS)
    await second.tick()
  }
  assert.equal(queued(ctx.calls).length, 1)
  assert.equal((await eventsOf(ctx)).filter((event) => event.type === 'report').length, 2)
  assert.deepEqual(await readNewReports(ctx.deps, ctx.run, ports), [])
})

test('a Codex planner wake calls codex queue with the planner thread', async () => {
  const ctx = await setup()
  const { ports } = fakePorts()
  await fileReport(ctx, 'w-api', 'done', 'api finished')
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  assert.equal(queued(ctx.calls).length, 0, 'still inside the batch window')
  ctx.clock.advance(BATCH_MS)
  await watcher.tick()
  const [call] = queued(ctx.calls)
  assert.deepEqual(call?.slice(0, 4), ['codex', 'queue', '--thread', 'thread-1'])
  assert.match(call?.at(-1) ?? '', /api finished/)
  const roster = await rosterOf(ctx)
  assert.equal(roster.seats[0]?.owes, 'review')
  assert.equal(roster.seats[0]?.lastReport?.kind, 'done')
  assert.ok((await eventsOf(ctx)).some((event) => event.type === 'report.delivered' && event.data?.via === 'codex-queue'))
})

test('a failed wake lands in pending and the next tool result carries it, once', async () => {
  const ctx = await setup({ respond: (argv) => (argv[0] === 'codex' ? { code: 1, stderr: 'no such thread' } : {}) })
  const { ports } = fakePorts()
  await fileReport(ctx, 'w-api', 'question', 'which schema?')
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  ctx.clock.advance(BATCH_MS)
  await watcher.tick()
  assert.equal(queued(ctx.calls).length, 1)
  assert.ok((await eventsOf(ctx)).some((event) => event.type === 'report.pending'))

  ctx.clock.advance(1000)
  await watcher.tick()
  assert.equal(queued(ctx.calls).length, 1, 'a failed codex queue is not retried before the cooldown')

  const result = await watcher.piggyback('roster: 1 seat')
  assert.match(result, /^roster: 1 seat/)
  assert.match(result, /which schema\?/)
  assert.equal(await watcher.piggyback('roster: 1 seat'), 'roster: 1 seat')
  ctx.clock.advance(60_000)
  await watcher.tick()
  assert.equal(queued(ctx.calls).length, 1, 'a piggybacked report is never woken again')
})

test('the standalone piggyback reads the same pending ledger', async () => {
  const ctx = await setup({ respond: (argv) => (argv[0] === 'codex' ? { code: 1 } : {}) })
  const { ports } = fakePorts()
  await fileReport(ctx, 'w-api', 'blocked', 'cannot reach cairn')
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  ctx.clock.advance(BATCH_MS)
  await watcher.tick()
  assert.match(await piggyback(ctx.deps, ctx.run, 'ok', ports), /cannot reach cairn/)
  assert.equal(await piggyback(ctx.deps, ctx.run, 'ok', ports), 'ok')
})

test('progress never wakes but still updates the roster', async () => {
  const ctx = await setup()
  const { ports } = fakePorts()
  await fileReport(ctx, 'w-api', 'progress', 'halfway there')
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  for (let i = 0; i < 5; i++) {
    await watcher.tick()
    ctx.clock.advance(BATCH_MS)
  }
  assert.equal(ctx.calls.length, 0)
  assert.equal(await watcher.piggyback('x'), 'x')
  const seat = (await rosterOf(ctx)).seats[0]
  assert.equal(seat?.lastReport?.summary, 'halfway there')
  assert.equal(seat?.owes, 'none')
})

test('reports within 2 s go out as one wake, later ones as another', async () => {
  const ctx = await setup({ seats: ['w-api', 'w-ui'] })
  const { ports } = fakePorts()
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await fileReport(ctx, 'w-api', 'done', 'first one')
  await watcher.tick()
  ctx.clock.advance(1000)
  await fileReport(ctx, 'w-ui', 'question', 'second one')
  await watcher.tick()
  assert.equal(queued(ctx.calls).length, 0)
  ctx.clock.advance(1000)
  await watcher.tick()
  assert.equal(queued(ctx.calls).length, 1)
  const text = queued(ctx.calls)[0]?.at(-1) ?? ''
  assert.match(text, /first one/)
  assert.match(text, /second one/)

  ctx.clock.advance(500)
  await fileReport(ctx, 'w-api', 'done', 'third one')
  await watcher.tick()
  assert.equal(queued(ctx.calls).length, 1)
  ctx.clock.advance(BATCH_MS)
  await watcher.tick()
  assert.equal(queued(ctx.calls).length, 2)
  assert.doesNotMatch(queued(ctx.calls)[1]?.at(-1) ?? '', /first one/)
})

test('a report with a stale token is rejected and never wakes', async () => {
  const ctx = await setup({ seats: ['w-api', 'w-ui'] })
  const { ports } = fakePorts()
  await fileReport(ctx, 'w-api', 'done', 'forged', { token: 'stale-token' })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  ctx.clock.advance(BATCH_MS * 3)
  await watcher.tick()
  assert.equal(ctx.calls.length, 0)
  const rejected = (await eventsOf(ctx)).find((event) => event.type === 'attention')
  assert.equal(rejected?.data?.why, 'token mismatch')
  assert.equal((await rosterOf(ctx)).seats[0]?.lastReport, undefined)
})

test('Claude planner: the channel carries the wake when enabled', async () => {
  const ctx = await setup({ planner: { kind: 'claude' } })
  const { ports } = fakePorts()
  const sent: { content: string; meta: Record<string, string> }[] = []
  await fileReport(ctx, 'w-api', 'done', 'channel me')
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false, channel: (content, meta) => void sent.push({ content, meta }) })
  await watcher.tick()
  ctx.clock.advance(BATCH_MS)
  await watcher.tick()
  assert.equal(sent.length, 1)
  assert.match(sent[0]?.content ?? '', /channel me/)
  assert.equal(ctx.calls.length, 0)
})

test('Claude planner: keystroke wake only after 5 s idle, never when blocked', async () => {
  const ctx = await setup({ planner: { kind: 'claude' } })
  let status: HerdrAgent['status'] = 'working'
  const { ports } = fakePorts({ agents: () => [{ paneId: 'p-planner', status }] })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await fileReport(ctx, 'w-api', 'done', 'type me')
  const step = async (by: number) => {
    ctx.clock.advance(by)
    await watcher.tick()
  }
  await watcher.tick()
  await step(BATCH_MS)
  assert.equal(prompted(ctx.calls).length, 0, 'planner is working')

  status = 'idle'
  await step(5000)
  assert.equal(prompted(ctx.calls).length, 0, 'idle observed just now')
  await step(1000)
  assert.equal(prompted(ctx.calls).length, 0, 'idle for 1 s')
  await step(4000)
  assert.equal(prompted(ctx.calls).length, 1)
  assert.deepEqual(prompted(ctx.calls)[0]?.slice(0, 4), ['herdr', 'agent', 'prompt', 'p-planner'])

  await fileReport(ctx, 'w-api', 'question', 'blocked planner')
  status = 'blocked'
  for (let i = 0; i < 6; i++) await step(5000)
  assert.equal(prompted(ctx.calls).length, 1, 'never types into a blocked planner')
  assert.match(await watcher.piggyback('r'), /blocked planner/)
})

const TIMEOUT_STDERR = JSON.stringify({ error: { code: 'timeout', message: 'timed out waiting for agent status' }, id: 'cli' })

test('Claude planner: a keystroke wake that times out after typing is delivered-unconfirmed, not pending', async () => {
  const ctx = await setup({ planner: { kind: 'claude' }, respond: (argv) => (argv[2] === 'prompt' ? { code: 1, stderr: TIMEOUT_STDERR } : {}) })
  const { ports } = fakePorts({ agents: () => [{ paneId: 'p-planner', status: 'idle' }] })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await fileReport(ctx, 'w-api', 'done', 'type me once')
  await watcher.tick()
  for (let i = 0; i < 6; i++) {
    ctx.clock.advance(5000)
    await watcher.tick()
  }
  assert.equal(prompted(ctx.calls).length, 1, 'typed once, never retried')
  const events = await eventsOf(ctx)
  assert.ok(events.some((event) => event.type === 'report.delivered' && event.data?.via === 'herdr-prompt-unconfirmed'))
  assert.ok(!events.some((event) => event.type === 'report.pending'))
  assert.doesNotMatch(await watcher.piggyback('r'), /type me once/)
})

test('Claude planner: a prompt failure before typing stays pending and is retried', async () => {
  const blocked = JSON.stringify({ error: { code: 'agent_blocked', message: 'blocked' } })
  const ctx = await setup({ planner: { kind: 'claude' }, respond: (argv) => (argv[2] === 'prompt' ? { code: 1, stderr: blocked } : {}) })
  const { ports } = fakePorts({ agents: () => [{ paneId: 'p-planner', status: 'idle' }] })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await fileReport(ctx, 'w-api', 'done', 'not typed')
  await watcher.tick()
  for (let i = 0; i < 6; i++) {
    ctx.clock.advance(5000)
    await watcher.tick()
  }
  const events = await eventsOf(ctx)
  assert.ok(events.some((event) => event.type === 'report.pending'))
  assert.ok(!events.some((event) => event.type === 'report.delivered'))
  assert.match(await watcher.piggyback('r'), /not typed/)
})

test('an idle seat that has fired no hook yet has its visible screen read for a startup dialog', async () => {
  const ctx = await setup({ respond: (argv) => (argv[2] === 'read' ? { stdout: '1 hook needs review before it can run' } : {}) })
  const { ports } = fakePorts({ agents: () => [{ name: 'w-api', paneId: 'p-w-api', status: 'idle' }], deriveState })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  assert.ok(ctx.calls.some((argv) => argv[2] === 'read' && argv[3] === 'w-api' && argv[5] === 'visible'))
  const roster = await rosterOf(ctx)
  assert.equal(roster.seats[0]?.state, 'blocked')
  assert.equal(roster.seats[0]?.attention[0]?.reason, 'hook-trust')
})

test('modWake is tried first when the planner runs the mod', async () => {
  const ctx = await setup({ planner: { kind: 'claude', viaMod: true } })
  const { ports } = fakePorts()
  const woken: string[] = []
  await fileReport(ctx, 'w-api', 'done', 'via the mod')
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false, modWake: async (text) => void woken.push(text) === undefined })
  await watcher.tick()
  ctx.clock.advance(BATCH_MS)
  await watcher.tick()
  assert.equal(woken.length, 1)
  assert.equal(ctx.calls.length, 0)
})

test('the herdr poll feeds deriveState into the roster and raises attention once', async () => {
  const ctx = await setup()
  const attention = { seat: 'w-api', reason: 'dialog' as const, detail: 'needs you', at: '2026-10-09T10:00:00.000Z' }
  const { ports } = fakePorts({
    agents: () => [{ name: 'w-api', paneId: 'p-w-api', status: 'blocked' }],
    deriveState: () => ({ state: 'blocked', attention: [attention] }),
  })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  let seat = (await rosterOf(ctx)).seats[0]
  assert.equal(seat?.state, 'blocked')
  assert.deepEqual(seat?.attention, [attention])
  assert.ok(ctx.calls.some((argv) => argv[2] === 'read'), 'a blocked seat gets its screen read')
  ctx.clock.advance(5000)
  await watcher.tick()
  assert.equal((await eventsOf(ctx)).filter((event) => event.type === 'attention').length, 1)
  assert.match(await watcher.piggyback('r'), /Needs the human:\n⚠ w-api: dialog: needs you/)
  assert.equal(await watcher.piggyback('r'), 'r')
  seat = (await rosterOf(ctx)).seats[0]
  assert.equal(seat?.state, 'blocked')
})

test('herdr is polled every 5 s, not on every tick', async () => {
  const ctx = await setup()
  let listed = 0
  const { ports } = fakePorts({
    listAgents: async () => {
      listed++
      return { ok: true, value: [] }
    },
  })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  for (let i = 0; i < 6; i++) {
    await watcher.tick()
    ctx.clock.advance(1000)
  }
  assert.equal(listed, 2)
})

test('an idle seat with no report gets one nudge per working episode', async () => {
  const ctx = await setup()
  let status: HerdrAgent['status'] = 'idle'
  const { ports, controls } = fakePorts({
    agents: () => [{ name: 'w-api', paneId: 'p-w-api', status }],
    deriveState: (_seat, signals) => ({ state: signals.herdr?.status === 'working' ? 'working' : 'idle', attention: [] }),
    needsNudge: (seat) => seat.state === 'idle' && !seat.hasNudged,
  })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  for (let i = 0; i < 3; i++) {
    await watcher.tick()
    ctx.clock.advance(5000)
  }
  assert.equal(controls.length, 1)
  assert.equal(controls[0]?.kind, 'nudge')
  assert.equal(controls[0]?.to, 'w-api')
  assert.equal((await rosterOf(ctx)).seats[0]?.hasNudged, true)

  status = 'working'
  await watcher.tick()
  ctx.clock.advance(5000)
  status = 'idle'
  await watcher.tick()
  ctx.clock.advance(5000)
  await watcher.tick()
  assert.equal(controls.length, 2)
})

test('pending controls are retried on a 3 s tick for every open seat', async () => {
  const ctx = await setup({ seats: ['w-api', 'w-ui'] })
  const { ports, flushed } = fakePorts()
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  for (let i = 0; i < 4; i++) {
    await watcher.tick()
    ctx.clock.advance(1500)
  }
  assert.deepEqual(flushed, ['w-api', 'w-ui', 'w-api', 'w-ui'])
})

test('queued promotes are applied on the flush tick', async () => {
  const ctx = await setup({ seats: ['w-api'] })
  const applied: string[] = []
  const { ports } = fakePorts({
    applyPendingPromotes: async (_deps, run) => {
      applied.push(run.id)
      return []
    },
  })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  for (let i = 0; i < 4; i++) {
    await watcher.tick()
    ctx.clock.advance(1500)
  }
  assert.deepEqual(applied, [ctx.run.id, ctx.run.id])
})

test('a throwing step is reported and does not stop the other steps', async () => {
  const ctx = await setup()
  const errors: string[] = []
  const { ports } = fakePorts({
    listAgents: async () => {
      throw new Error('herdr is down')
    },
  })
  await fileReport(ctx, 'w-api', 'done', 'still delivered')
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false, onError: (error, step) => void errors.push(`${step}: ${(error as Error).message}`) })
  await watcher.tick()
  ctx.clock.advance(BATCH_MS)
  await watcher.tick()
  assert.deepEqual(errors.slice(0, 1), ['poll: herdr is down'])
  assert.equal(queued(ctx.calls).length, 1)
})

test('a Codex planner without a recorded thread uses its session-start hook record', async () => {
  const ctx = await setup({ planner: { sessionId: undefined } })
  const { ports } = fakePorts()
  await fileReport(ctx, 'w-api', 'done', 'no thread yet')
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  ctx.clock.advance(BATCH_MS)
  await watcher.tick()
  assert.equal(queued(ctx.calls).length, 0, 'thread unknown: nothing is sent anywhere')
  assert.equal(prompted(ctx.calls).length, 0)

  await appendJsonl(join(ctx.home, 'runs', ctx.run.id, 'planner', 'hooks.jsonl'), { at: ctx.clock.now().toISOString(), agent: 'codex', event: 'session-start', sessionId: 'thread-from-hook' })
  ctx.clock.advance(1000)
  await watcher.tick()
  assert.deepEqual(queued(ctx.calls)[0]?.slice(0, 4), ['codex', 'queue', '--thread', 'thread-from-hook'], 'retried on the next tick, not after the 15 s cooldown')
})

test('a Codex planner thread falls back to the herdr agent session', async () => {
  const ctx = await setup({ planner: { sessionId: undefined } })
  const { ports } = fakePorts({ agents: () => [{ paneId: 'p-planner', status: 'working', sessionId: 'thread-from-herdr' }] })
  await fileReport(ctx, 'w-api', 'done', 'herdr knows')
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  ctx.clock.advance(BATCH_MS)
  await watcher.tick()
  assert.deepEqual(queued(ctx.calls)[0]?.slice(0, 4), ['codex', 'queue', '--thread', 'thread-from-herdr'])
})

const markWorking = (ctx: Awaited<ReturnType<typeof setup>>) =>
  updateRoster(ctx.home, ctx.run.id, (current) => ({ ...current, seats: current.seats.map((seat) => ({ ...seat, lastWorkingAt: seat.stateAt })) }))

test('a report that lands inside the working episode stops idle-without-report and the nudge', async () => {
  const ctx = await setup()
  await markWorking(ctx)
  let status: HerdrAgent['status'] = 'working'
  const { ports, controls } = fakePorts({ agents: () => [{ name: 'w-api', paneId: 'p-w-api', status }], deriveState, needsNudge })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await fileReport(ctx, 'w-api', 'done', 'finished', { expects: 'none' })
  ctx.clock.advance(1000)
  await watcher.tick()
  ctx.clock.advance(5000)
  status = 'idle'
  await watcher.tick()
  ctx.clock.advance(60_000)
  await watcher.tick()
  const seat = (await rosterOf(ctx)).seats[0]
  assert.equal(seat?.state, 'idle')
  assert.deepEqual(seat?.attention, [])
  assert.equal(controls.length, 0)
})

test('a seat that stops without any report is still nudged', async () => {
  const ctx = await setup()
  await markWorking(ctx)
  let status: HerdrAgent['status'] = 'working'
  const { ports, controls } = fakePorts({ agents: () => [{ name: 'w-api', paneId: 'p-w-api', status }], deriveState, needsNudge })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  ctx.clock.advance(5000)
  status = 'idle'
  await watcher.tick()
  ctx.clock.advance(60_000)
  await watcher.tick()
  assert.equal(controls.length, 1)
})

test('after a question is answered, a new silent stop is nudged', async () => {
  const ctx = await setup()
  await markWorking(ctx)
  let status: HerdrAgent['status'] = 'working'
  const { ports, controls } = fakePorts({ agents: () => [{ name: 'w-api', paneId: 'p-w-api', status }], deriveState, needsNudge })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await fileReport(ctx, 'w-api', 'question', 'which table?', { expects: 'answer' })
  ctx.clock.advance(1000)
  status = 'idle'
  await watcher.tick()
  ctx.clock.advance(60_000)
  await watcher.tick()
  assert.equal(controls.length, 0)

  await updateRoster(ctx.home, ctx.run.id, (current) => ({ ...current, seats: current.seats.map((seat) => ({ ...seat, owes: 'none' })) }))
  status = 'working'
  ctx.clock.advance(5000)
  await watcher.tick()
  status = 'idle'
  ctx.clock.advance(5000)
  await watcher.tick()
  ctx.clock.advance(60_000)
  await watcher.tick()
  assert.equal(controls.length, 1)
})

test('the watcher leaves a closing seat alone', async () => {
  const ctx = await setup()
  await updateRoster(ctx.home, ctx.run.id, (current) => ({ ...current, seats: current.seats.map((seat) => ({ ...seat, state: 'closing' })) }))
  const { ports } = fakePorts({ agents: () => [{ name: 'w-api', paneId: 'p-w-api', status: 'blocked' }], deriveState, needsNudge })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  const seat = (await rosterOf(ctx)).seats[0]
  assert.equal(seat?.state, 'closing')
  assert.deepEqual(seat?.attention, [])
  assert.equal((await eventsOf(ctx)).filter((event) => event.type === 'attention').length, 0)
})
