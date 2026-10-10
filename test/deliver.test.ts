import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import * as deliver from '../src/deliver.ts'
import { deriveState } from '../src/detect.ts'
import { seatDir } from '../src/paths.ts'
import { loadRoster } from '../src/roster.ts'
import type { Control, DeliveryAdapter, Report, RunMeta, Seat } from '../src/types.ts'
import { FakeHerdr, herdrFail, makeDeps, makeSeat, seedRun } from './p3-helpers.ts'

deliver.confirmTiming.waitMs = 60
deliver.confirmTiming.pollMs = 10

afterEach(() => deliver.unregisterAdapters())

const control = (to: string, overrides: Partial<Control> = {}): Control => ({
  v: 1, id: 'c-1', run: 'drove-20261009-1042-a3f1', from: 'planner', to, kind: 'message', expects: 'none', body: 'hello there', at: '2026-10-09T10:00:00.000Z', ...overrides,
})

const lines = async (path: string): Promise<Record<string, unknown>[]> =>
  (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)

const setup = async (seat: Seat, status: 'idle' | 'working' | 'blocked' = 'idle', fake = new FakeHerdr()) => {
  const deps = await makeDeps(fake)
  const run = await seedRun(deps, '/repo', [seat])
  fake.agents.set(seat.name, { name: seat.name, paneId: seat.paneId ?? 'w1:p1', tabId: 'w1:t1', status, ...(seat.sessionId ? { sessionId: seat.sessionId } : {}) })
  return { deps, run, fake }
}

test('codexQueueArgv is the proven codex queue form', () => {
  assert.deepEqual(deliver.codexQueueArgv('t-1', 'hi'), ['codex', 'queue', '--thread', 't-1', '--message', 'hi'])
})

test('codex queue runs with the seat CODEX_HOME when Drove owns one, and with the inherited env otherwise', async () => {
  for (const codexHome of ['/h/.drove/runs/r/codex-home', undefined]) {
    const { deps, run } = await setup(makeSeat('w-api', { kind: 'codex', sessionId: 'thread-1', ...(codexHome ? { codexHome } : {}) }))
    const seen: (Record<string, string> | undefined)[] = []
    const exec = deps.exec
    const delivery = await deliver.deliverControl({ ...deps, exec: async (argv, options) => (argv[1] === 'queue' && seen.push(options?.env), exec(argv, options)) }, run, control('w-api'))
    assert.deepEqual(delivery, { ok: true, via: 'codex-queue' })
    assert.deepEqual(seen, [codexHome ? { CODEX_HOME: codexHome } : undefined])
  }
})

test('a Codex seat with a thread gets codex queue, with the enveloped text', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-api', { kind: 'codex', sessionId: 'thread-1' }))
  const delivery = await deliver.deliverControl(deps, run, control('w-api'))
  assert.deepEqual(delivery, { ok: true, via: 'codex-queue' })
  assert.equal(fake.queued.length, 1)
  assert.equal(fake.queued[0]?.thread, 'thread-1')
  assert.match(fake.queued[0]?.text ?? '', /^⟦drove v1 run=drove-20261009-1042-a3f1 from=planner to=w-api id=c-1 kind=message expects=none mac=[0-9a-f]{16}⟧\nhello there/)
  assert.equal(fake.prompts.length, 0)
})

test('codex queue is allowed while the Codex pane is mid-turn', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-api', { kind: 'codex', sessionId: 'thread-1', state: 'working' }), 'working')
  assert.equal((await deliver.deliverControl(deps, run, control('w-api'))).ok, true)
  assert.equal(fake.queued.length, 1)
})

test('a Codex seat without a thread falls back to herdr agent prompt', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-api', { kind: 'codex' }))
  const delivery = await deliver.deliverControl(deps, run, control('w-api'))
  assert.deepEqual(delivery, { ok: true, via: 'herdr-prompt' })
  assert.equal(fake.queued.length, 0)
  assert.equal(fake.prompts.length, 1)
})

test('a Claude seat is reached with herdr agent prompt', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-ui', { sessionId: 'claude-session' }))
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt' })
  assert.equal(fake.prompts[0]?.target, 'w1:p-w-ui')
  assert.ok(fake.calls.some(call => call.join(' ').startsWith('herdr agent prompt w1:p-w-ui')))
})

test('a registered mod adapter wins for the seats it can reach', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-ui', { sessionId: 'claude-session' }))
  const sent: string[] = []
  const mod: DeliveryAdapter = { transport: 'mod', canDeliver: seat => Boolean(seat.sessionId), deliver: async (_seat, text) => (sent.push(text), { ok: true, via: 'mod' }) }
  deliver.registerAdapter(mod)
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'mod' })
  assert.equal(sent.length, 1)
  assert.equal(fake.prompts.length, 0)
})

test('a blocked seat queues the control and never types into the pane', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-ui'), 'blocked')
  const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.equal(delivery.ok, false)
  assert.equal(!delivery.ok && delivery.queued, true)
  assert.equal(fake.prompts.length, 0)
  assert.ok(!fake.calls.some(call => call.join(' ').startsWith('herdr agent prompt')))
  const pending = await lines(join(seatDir(deps.home, run.id, 'w-ui'), 'pending.jsonl'))
  assert.deepEqual(pending.map(item => item.id), ['c-1'])
  const roster = await loadRoster(deps.home, run.id)
  assert.equal(roster.seats[0]?.attention[0]?.reason, 'pending-delivery')
  const events = await lines(join(deps.home, 'runs', run.id, 'events.jsonl'))
  assert.equal(events.at(-1)?.type, 'control.queued')
})

test('a blocked Codex seat also defers codex queue', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-api', { kind: 'codex', sessionId: 'thread-1' }), 'blocked')
  const delivery = await deliver.deliverControl(deps, run, control('w-api'))
  assert.equal(!delivery.ok && delivery.queued, true)
  assert.equal(fake.queued.length, 0)
})

test('a seat that the roster says needs input is not typed into either', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-ui', { state: 'needs-input' }))
  const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.equal(!delivery.ok && delivery.queued, true)
  assert.equal(fake.prompts.length, 0)
})

test('queueing the same control twice keeps one pending line', async () => {
  const { deps, run } = await setup(makeSeat('w-ui'), 'blocked')
  await deliver.deliverControl(deps, run, control('w-ui'))
  await deliver.deliverControl(deps, run, control('w-ui'))
  assert.equal((await lines(join(seatDir(deps.home, run.id, 'w-ui'), 'pending.jsonl'))).length, 1)
})

test('flushPending sends once the pane is no longer blocked, then clears the queue and the attention item', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-ui'), 'blocked')
  await deliver.deliverControl(deps, run, control('w-ui', { id: 'c-1' }))
  await deliver.deliverControl(deps, run, control('w-ui', { id: 'c-2', body: 'second' }))
  const still = await deliver.flushPending(deps, run, 'w-ui')
  assert.equal(still[0]?.ok, false)
  assert.equal(fake.prompts.length, 0)
  fake.setStatus('w-ui', 'idle')
  const flushed = await deliver.flushPending(deps, run, 'w-ui')
  assert.deepEqual(flushed.map(item => item.ok), [true, true])
  assert.deepEqual(fake.prompts.map(item => item.text.includes('second')), [false, true])
  assert.deepEqual(await lines(join(seatDir(deps.home, run.id, 'w-ui'), 'pending.jsonl')), [])
  assert.deepEqual((await loadRoster(deps.home, run.id)).seats[0]?.attention, [])
  assert.deepEqual(await deliver.flushPending(deps, run, 'w-ui'), [])
})

test('delivery is idempotent: a sent id is not typed again', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-ui'))
  await deliver.deliverControl(deps, run, control('w-ui'))
  const again = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.deepEqual(again, { ok: true, via: 'herdr-prompt' })
  assert.equal(fake.prompts.length, 1)
  const sent = await lines(join(seatDir(deps.home, run.id, 'w-ui'), 'sent.jsonl'))
  assert.deepEqual(sent.map(item => item.id), ['c-1'])
})

test('an agent_blocked answer from herdr takes the queue path', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  fake.exec = async argv => (argv[2] === 'prompt' ? herdrFail('agent_blocked') : base(argv))
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.equal(!delivery.ok && delivery.queued, true)
  assert.equal((await lines(join(seatDir(deps.home, run.id, 'w-ui'), 'pending.jsonl'))).length, 1)
})

test('agent_pane_busy is retried and then delivered', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  let busy = 2
  fake.exec = async argv => (argv[2] === 'prompt' && busy-- > 0 ? herdrFail('agent_pane_busy') : base(argv))
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  assert.equal((await deliver.deliverControl(deps, run, control('w-ui'))).ok, true)
  assert.equal(busy, -1)
})

test('agent_prompt_stalled is not resent: it raises a stalled item and stays out of the queue', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  fake.exec = async argv => (argv[2] === 'prompt' ? herdrFail('agent_prompt_stalled') : base(argv))
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.equal(!delivery.ok && delivery.queued, false)
  assert.match(!delivery.ok ? delivery.reason : '', /check the pane/)
  assert.deepEqual(await lines(join(seatDir(deps.home, run.id, 'w-ui'), 'pending.jsonl')), [])
  assert.equal((await loadRoster(deps.home, run.id)).seats[0]?.attention[0]?.reason, 'stalled')
  assert.equal((await lines(join(seatDir(deps.home, run.id, 'w-ui'), 'sent.jsonl'))).length, 0)
})

test('a stalled prompt that turned into activity counts as delivered', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  fake.exec = async argv => {
    if (argv[2] === 'prompt') {
      fake.setStatus('w-ui', 'working')
      return herdrFail('agent_prompt_stalled')
    }
    return base(argv)
  }
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  assert.equal((await deliver.deliverControl(deps, run, control('w-ui'))).ok, true)
})

test('a herdr wait timeout after typing is delivered-unconfirmed: recorded as sent, never queued or retried', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  let prompts = 0
  fake.exec = async argv => (argv[2] === 'prompt' ? (prompts++, herdrFail('timeout', 'timed out waiting for agent status')) : base(argv))
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt', unconfirmed: true })
  assert.deepEqual(await lines(join(seatDir(deps.home, run.id, 'w-ui'), 'pending.jsonl')), [])
  const events = await lines(join(deps.home, 'runs', run.id, 'events.jsonl'))
  assert.deepEqual(events.at(-1)?.data, { kind: 'message', via: 'herdr-prompt', unconfirmed: true })
  assert.equal(events.at(-1)?.type, 'control.sent')
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt' })
  assert.equal(prompts, 1)
})

test('a herdr wait timeout is confirmed by a user-prompt-submit hook record newer than the send', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  fake.exec = async argv => (argv[2] === 'prompt' ? herdrFail('timeout', 'timed out waiting for agent status') : base(argv))
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  const hooks = join(seatDir(deps.home, run.id, 'w-ui'), 'hooks.jsonl')
  const sentAt = deps.clock.now().getTime()
  await appendFile(hooks, `${JSON.stringify({ at: new Date(sentAt - 5_000).toISOString(), agent: 'claude', event: 'user-prompt-submit' })}\n`)
  setTimeout(() => void appendFile(hooks, `${JSON.stringify({ at: new Date(sentAt + 1_000).toISOString(), agent: 'claude', event: 'user-prompt-submit' })}\n`), 20)
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt' })
  const events = await lines(join(deps.home, 'runs', run.id, 'events.jsonl'))
  assert.deepEqual(events.at(-1)?.data, { kind: 'message', via: 'herdr-prompt' })
})

test('a herdr wait timeout stays unconfirmed when only an older hook record exists', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  fake.exec = async argv => (argv[2] === 'prompt' ? herdrFail('timeout', 'timed out waiting for agent status') : base(argv))
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  const hooks = join(seatDir(deps.home, run.id, 'w-ui'), 'hooks.jsonl')
  await appendFile(hooks, `${JSON.stringify({ at: new Date(deps.clock.now().getTime() - 5_000).toISOString(), agent: 'claude', event: 'user-prompt-submit' })}\n`)
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt', unconfirmed: true })
})

test('failures before typing (agent_blocked, agent_not_found) queue the control', async () => {
  for (const code of ['agent_blocked', 'agent_not_found']) {
    const fake = new FakeHerdr()
    const base = fake.exec
    fake.exec = async argv => (argv[2] === 'prompt' ? herdrFail(code) : base(argv))
    const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
    const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
    assert.equal(!delivery.ok && delivery.queued, true, code)
    assert.equal((await lines(join(seatDir(deps.home, run.id, 'w-ui'), 'pending.jsonl'))).length, 1, code)
  }
})

test('a failing codex queue is an explicit failure: not queued, recorded, retried only by flush', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-api', { kind: 'codex', sessionId: 'thread-1' }))
  fake.queueFails = true
  const delivery = await deliver.deliverControl(deps, run, control('w-api'))
  assert.equal(!delivery.ok && delivery.queued, false)
  const events = await lines(join(deps.home, 'runs', run.id, 'events.jsonl'))
  assert.equal(events.at(-1)?.type, 'control.failed')
})

test('a control for an unknown or closed seat fails without touching herdr', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-ui', { state: 'closed' }))
  assert.equal((await deliver.deliverControl(deps, run, control('w-ui'))).ok, false)
  assert.equal((await deliver.deliverControl(deps, run, control('ghost'))).ok, false)
  assert.equal(fake.calls.length, 0)
})

test('chooseAdapter ranks mod, then codex queue, then herdr prompt', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  const codex = makeSeat('x', { kind: 'codex', sessionId: 't' })
  const all = [deliver.herdrPromptAdapter(deps), deliver.codexQueueAdapter(deps)]
  assert.equal(deliver.chooseAdapter(codex, all)?.transport, 'codex-queue')
  assert.equal(deliver.chooseAdapter(makeSeat('y'), all)?.transport, 'herdr-prompt')
  const mod: DeliveryAdapter = { transport: 'mod', canDeliver: () => true, deliver: async () => ({ ok: true, via: 'mod' }) }
  assert.equal(deliver.chooseAdapter(codex, [...all, mod])?.transport, 'mod')
  assert.equal(deliver.chooseAdapter(makeSeat('z', { paneId: undefined, name: '' }), [deliver.codexQueueAdapter(deps)]), undefined)
})

const report = (seat: string): Report => ({ v: 1, id: 'r-1', run: 'drove-20261009-1042-a3f1', seat, token: 't', kind: 'done', expects: 'review', summary: 'finished', at: '2026-10-09T10:00:00.000Z' })

const plannerRun = async (fake: FakeHerdr, overrides: Partial<RunMeta['planner']> = {}) => {
  const deps = await makeDeps(fake)
  const run = await seedRun(deps, '/repo', [], { planner: { kind: 'codex', paneId: 'w1:p0', sessionId: 'planner-thread', model: '', effort: 'high', viaMod: false, ...overrides } })
  fake.agents.set('planner', { name: 'planner', paneId: 'w1:p0', tabId: 'w1:t0', status: 'working' })
  return { deps, run }
}

test('wakePlanner uses codex queue with the planner thread, even mid-turn', async () => {
  const fake = new FakeHerdr()
  const { deps, run } = await plannerRun(fake)
  assert.deepEqual(await deliver.wakePlanner(deps, run, [report('w-api')], 'Sam'), { ok: true, via: 'codex-queue' })
  assert.equal(fake.queued[0]?.thread, 'planner-thread')
  assert.match(fake.queued[0]?.text ?? '', /\[worker w-api · done · expects review\]/)
})

test('wakePlanner finds a Codex planner thread from its session-start hook record', async () => {
  const fake = new FakeHerdr()
  const { deps, run } = await plannerRun(fake, { sessionId: undefined })
  const { appendJsonl } = await import('../src/store.ts')
  const { plannerDir } = await import('../src/paths.ts')
  await appendJsonl(join(plannerDir(deps.home, run.id), 'hooks.jsonl'), { at: '2026-10-09T10:00:00.000Z', agent: 'codex', event: 'session-start', sessionId: 'thread-from-hook' })
  await deliver.wakePlanner(deps, run, [report('w-api')])
  assert.equal(fake.queued[0]?.thread, 'thread-from-hook')
})

test('wakePlanner never wakes a blocked planner', async () => {
  const fake = new FakeHerdr()
  const { deps, run } = await plannerRun(fake)
  fake.setStatus('planner', 'blocked')
  const delivery = await deliver.wakePlanner(deps, run, [report('w-api')])
  assert.equal(delivery.ok, false)
  assert.equal(fake.queued.length, 0)
})

test('a Claude planner is typed into only after 5 s of quiet, and never while working', async () => {
  const fake = new FakeHerdr()
  const { deps, run } = await plannerRun(fake, { kind: 'claude', sessionId: 'c-1' })
  assert.match((await deliver.wakePlanner(deps, run, [report('w-api')]) as { reason: string }).reason, /planner is working/)
  fake.setStatus('planner', 'idle')
  assert.match((await deliver.wakePlanner(deps, run, [report('w-api')]) as { reason: string }).reason, /not been idle for 5 s/)
  deps.clock.advance(6_000)
  assert.deepEqual(await deliver.wakePlanner(deps, run, [report('w-api')]), { ok: true, via: 'herdr-prompt' })
  assert.equal(fake.prompts.length, 1)
})

test('wakePlanner prefers a registered mod adapter for the planner', async () => {
  const fake = new FakeHerdr()
  const { deps, run } = await plannerRun(fake, { kind: 'claude', viaMod: true })
  const sent: string[] = []
  deliver.registerAdapter({ transport: 'mod', canDeliver: seat => seat.name === 'planner', deliver: async (_seat, text) => (sent.push(text), { ok: true, via: 'mod' }) })
  assert.equal((await deliver.wakePlanner(deps, run, [report('w-api')])).ok, true)
  assert.equal(sent.length, 1)
  assert.equal(fake.prompts.length, 0)
})

test('isDeliverable explains why a seat cannot be reached', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  assert.deepEqual(await deliver.isDeliverable(deps, makeSeat('w-ui', { state: 'gone' })), { ok: false, reason: 'w-ui is gone' })
  const missing = await deliver.isDeliverable(deps, makeSeat('w-ui'))
  assert.equal(missing.ok, false)
  assert.match(!missing.ok ? missing.reason : '', /agent_not_found/)
})

test('only a control that owes a report back stamps lastSentAt; a promote notice or an expects-none message does not', async () => {
  const { deps, run } = await setup(makeSeat('w-api', { kind: 'codex', sessionId: 'thread-1' }))
  const stamp = async () => (await loadRoster(deps.home, run.id)).seats[0]?.lastSentAt
  assert.equal((await deliver.deliverControl(deps, run, control('w-api', { id: 'c-1', kind: 'promote', expects: 'none' }))).ok, true)
  assert.equal((await deliver.deliverControl(deps, run, control('w-api', { id: 'c-2', kind: 'message', expects: 'none' }))).ok, true)
  assert.equal(await stamp(), undefined)
  assert.equal((await deliver.deliverControl(deps, run, control('w-api', { id: 'c-3', kind: 'message', expects: 'answer' }))).ok, true)
  assert.equal(await stamp(), deps.clock.now().toISOString())
})

test('a question answered with expects none is a reply that owes a report: a silent stop after it is flagged', async () => {
  const asked = { id: 'r-1', kind: 'question' as const, expects: 'answer' as const, summary: 'which table?', at: '2000-01-01T00:00:00.000Z' }
  const { deps, run } = await setup(makeSeat('w-api', { kind: 'codex', sessionId: 'thread-1', state: 'idle', stateAt: '2000-01-01T00:01:00.000Z', lastWorkingAt: '2000-01-01T00:01:00.000Z', lastReport: asked, owes: 'answer' }))
  assert.equal((await deliver.deliverControl(deps, run, control('w-api', { kind: 'answer', expects: 'none' }))).ok, true)
  const seat = (await loadRoster(deps.home, run.id)).seats[0]!
  assert.equal(seat.lastSentAt, deps.clock.now().toISOString())
  const later = new Date(deps.clock.now().getTime() + 60_000)
  const derived = deriveState({ ...seat, lastWorkingAt: deps.clock.now().toISOString(), stateAt: deps.clock.now().toISOString() }, { herdr: { paneId: 'w1:p1', status: 'idle' }, hooks: [], lastReport: asked }, later)
  assert.deepEqual(derived.attention.map(item => item.reason), ['idle-without-report'])
})
