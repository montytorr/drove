import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import * as deliver from '../src/deliver.ts'
import { deriveState } from '../src/detect.ts'
import { seatDir } from '../src/paths.ts'
import { parseEnvelope, verifyControl } from '../src/protocol.ts'
import { loadRoster, updateRoster } from '../src/roster.ts'
import type { Control, DeliveryAdapter, Report, RunMeta, Seat } from '../src/types.ts'
import { FakeHerdr, herdrFail, makeDeps, makeSeat, result, seedRun } from './p3-helpers.ts'

deliver.confirmTiming.waitMs = 60
deliver.confirmTiming.pollMs = 10
deliver.workingWait.maxMs = 60
deliver.workingWait.pollMs = 10

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

test('agent_prompt_stalled raises a stalled item and stays out of the queue', async () => {
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

const stalledSetup = async (promptStalls: 'pasted' | 'empty', status: 'idle' | 'working' = 'idle') => {
  const fake = new FakeHerdr({ promptStalls })
  return setup(makeSeat('w-ui'), status, fake)
}

const sentOf = (deps: Awaited<ReturnType<typeof setup>>['deps'], run: RunMeta) => lines(join(seatDir(deps.home, run.id, 'w-ui'), 'sent.jsonl'))

test('a stalled prompt whose input holds the paste placeholder is submitted with Enter once, and counts as delivered (DROVE-124)', async () => {
  const { deps, run, fake } = await stalledSetup('pasted')
  const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.deepEqual(delivery, { ok: true, via: 'herdr-prompt', submitted: true })
  assert.deepEqual(fake.keys, [{ target: 'w1:p-w-ui', keys: ['Enter'] }])
  assert.equal(fake.prompts.length, 1)
  assert.equal((await sentOf(deps, run)).length, 1)
  assert.deepEqual((await loadRoster(deps.home, run.id)).seats[0]?.attention, [])
  const events = await lines(join(deps.home, 'runs', run.id, 'events.jsonl'))
  assert.deepEqual(events.at(-1)?.data, { kind: 'message', via: 'herdr-prompt', submitted: true })
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt' })
  assert.equal(fake.keys.length, 1)
})

test('a stalled prompt whose input starts with the typed text is submitted too', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  fake.exec = async argv => {
    if (argv[2] !== 'prompt') return base(argv)
    fake.screen = `● Ready\n──────\n❯ ${(argv[4] ?? '').split('\n')[0]}\n  hello there\n──────\n  ? for shortcuts`
    return herdrFail('agent_prompt_stalled')
  }
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt', submitted: true })
  assert.equal(fake.keys.length, 1)
})

test('a stalled prompt with an empty input and an idle agent is sent again once, and reported not delivered when that stalls too', async () => {
  const { deps, run, fake } = await stalledSetup('empty')
  const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.equal(!delivery.ok && delivery.queued, false)
  assert.match(!delivery.ok ? delivery.reason : '', /^agent_prompt_stalled: .*check the pane.*sent again once and stalled again/)
  assert.equal(fake.keys.length, 0)
  assert.equal(fake.prompts.length, 2)
  assert.equal((await sentOf(deps, run)).length, 0)
  assert.equal((await loadRoster(deps.home, run.id)).seats[0]?.attention[0]?.reason, 'stalled')
})

const BRIEF_FILE_LINES = 12
const longBody = (lines: number): string => Array.from({ length: lines }, (_, index) => `line ${index + 1} of the brief`).join('\n')
const saveBriefFile = async (deps: Awaited<ReturnType<typeof setup>>['deps'], run: RunMeta, body: string, name = 'brief.md') => {
  const file = join(seatDir(deps.home, run.id, 'w-ui'), name)
  await mkdir(seatDir(deps.home, run.id, 'w-ui'), { recursive: true })
  await writeFile(file, `${body}\n`)
  return file
}

test('a brief whose paste never reached the input is sent again once as a signed pointer to brief.md (DROVE-136)', async () => {
  const fake = new FakeHerdr({ promptStalls: 'empty', stallsFor: 1 })
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  const body = longBody(BRIEF_FILE_LINES)
  const file = await saveBriefFile(deps, run, body)
  const delivery = await deliver.deliverControl(deps, run, control('w-ui', { kind: 'brief', expects: 'review', body }))
  assert.deepEqual(delivery, { ok: true, via: 'herdr-prompt' })
  assert.equal(fake.prompts.length, 2)
  assert.match(fake.prompts[0]?.text ?? '', /line 12 of the brief/)
  const pointer = fake.prompts[1]?.text ?? ''
  assert.doesNotMatch(pointer, /line 1 of the brief/)
  const envelope = parseEnvelope(pointer)
  assert.equal(envelope?.fields.id, 'c-1')
  assert.equal(envelope?.fields.kind, 'brief')
  assert.equal(envelope?.body, `Your brief is in \`${file}\` (${BRIEF_FILE_LINES} lines): read it with the Read tool, then start.`)
  assert.equal(envelope && verifyControl(envelope, 'token-w-ui'), true)
  assert.equal((await sentOf(deps, run)).length, 1)
  assert.deepEqual((await loadRoster(deps.home, run.id)).seats[0]?.attention, [])
  const events = await lines(join(deps.home, 'runs', run.id, 'events.jsonl'))
  assert.deepEqual(events.at(-1)?.data, { kind: 'brief', via: 'herdr-prompt', pointer: true, resent: true })
  assert.equal(fake.keys.length, 0)
})

test('a pointer that is itself typed into a stalled input is submitted by Drove like any paste (DROVE-124)', async () => {
  const fake = new FakeHerdr()
  let stalls = 0
  const base = fake.exec
  fake.exec = async argv => {
    if (argv[2] !== 'prompt') return base(argv)
    stalls += 1
    fake.screen = stalls === 1 ? '● Ready\n──────\n❯ \n──────' : `● Ready\n──────\n❯ ${(argv[4] ?? '').split('\n')[0]}\n──────`
    return herdrFail('agent_prompt_stalled')
  }
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  const body = longBody(BRIEF_FILE_LINES)
  await saveBriefFile(deps, run, body)
  const delivery = await deliver.deliverControl(deps, run, control('w-ui', { kind: 'brief', expects: 'review', body }))
  assert.deepEqual(delivery, { ok: true, via: 'herdr-prompt', submitted: true })
  assert.equal(fake.keys.length, 1)
  assert.equal(stalls, 2)
})

test('a handoff brief that is not the seat\'s brief.md is saved to handoff.md for the pointer, and brief.md stays as it was', async () => {
  const fake = new FakeHerdr({ promptStalls: 'empty', stallsFor: 1 })
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  const original = await saveBriefFile(deps, run, 'the original brief')
  const handoff = longBody(5)
  assert.equal((await deliver.deliverControl(deps, run, control('w-ui', { kind: 'brief', expects: 'review', body: handoff }))).ok, true)
  const file = join(seatDir(deps.home, run.id, 'w-ui'), 'handoff.md')
  assert.equal(await readFile(file, 'utf8'), `${handoff}\n`)
  assert.equal(await readFile(original, 'utf8'), 'the original brief\n')
  assert.match(parseEnvelope(fake.prompts[1]?.text ?? '')?.body ?? '', new RegExp(`^Your brief is in \`${file}\` \\(5 lines\\)`))
})

test('a Codex seat is pointed at the file with cat', async () => {
  const fake = new FakeHerdr({ promptStalls: 'empty', stallsFor: 1 })
  const { deps, run } = await setup(makeSeat('w-ui', { kind: 'codex' }), 'idle', fake)
  const body = longBody(3)
  await saveBriefFile(deps, run, body)
  assert.equal((await deliver.deliverControl(deps, run, control('w-ui', { kind: 'brief', expects: 'review', body }))).ok, true)
  assert.match(parseEnvelope(fake.prompts[1]?.text ?? '')?.body ?? '', /\(3 lines\): read it with `cat`, then start\.$/)
})

test('a message that stalled with an empty input is sent again once, as it was', async () => {
  const fake = new FakeHerdr({ promptStalls: 'empty', stallsFor: 1 })
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt' })
  assert.equal(fake.prompts.length, 2)
  assert.equal(fake.prompts[0]?.text, fake.prompts[1]?.text)
  const events = await lines(join(deps.home, 'runs', run.id, 'events.jsonl'))
  assert.deepEqual(events.at(-1)?.data, { kind: 'message', via: 'herdr-prompt', resent: true })
})

test('a stalled input that holds the paste, or no readable screen, is not sent again', async () => {
  const pasted = await stalledSetup('pasted')
  assert.equal((await deliver.deliverControl(pasted.deps, pasted.run, control('w-ui'))).ok, true)
  assert.equal(pasted.fake.prompts.length, 1)

  const unreadable = await stalledSetup('empty')
  unreadable.fake.agentReadFails = true
  unreadable.fake.paneReadFails = 'pane_not_found'
  assert.equal((await deliver.deliverControl(unreadable.deps, unreadable.run, control('w-ui'))).ok, false)
  assert.equal(unreadable.fake.prompts.length, 1)
})

test('a brief longer than the limit is sent as a pointer first, and its full text is in brief.md before the prompt goes out', async () => {
  const { deps, run, fake } = await setup(makeSeat('w-ui'), 'idle', new FakeHerdr())
  const body = longBody(41)
  const file = await saveBriefFile(deps, run, body)
  const full = control('w-ui', { kind: 'brief', expects: 'review', body })
  const sent = await deliver.briefForSend(deps, run, full, 40)
  assert.equal(sent.body, `Your brief is in \`${file}\` (41 lines): read it with the Read tool, then start.`)
  assert.equal(sent.id, full.id)
  assert.equal(await readFile(file, 'utf8'), `${body}\n`)
  assert.deepEqual(await deliver.deliverControl(deps, run, sent), { ok: true, via: 'herdr-prompt' })
  assert.equal(fake.prompts.length, 1)
  const events = await lines(join(deps.home, 'runs', run.id, 'events.jsonl'))
  assert.deepEqual(events.at(-1)?.data, { kind: 'brief', via: 'herdr-prompt', pointer: true })
})

test('a brief at or under the limit, and any other kind, is left as it is', async () => {
  const { deps, run } = await setup(makeSeat('w-ui'), 'idle', new FakeHerdr())
  const atLimit = control('w-ui', { kind: 'brief', expects: 'review', body: longBody(40) })
  assert.equal(await deliver.briefForSend(deps, run, atLimit, 40), atLimit)
  const message = control('w-ui', { body: longBody(80) })
  assert.equal(await deliver.briefForSend(deps, run, message, 40), message)
  const pointer = control('w-ui', { kind: 'brief', body: 'Your brief is in `/x/brief.md` (90 lines): read it with the Read tool, then start.' })
  assert.equal(await deliver.briefForSend(deps, run, pointer, 1), pointer)
})

test('a paste placeholder in the transcript, above an empty input, is not submitted', async () => {
  const { deps, run, fake } = await stalledSetup('empty')
  const base = fake.exec
  fake.exec = async argv => {
    const ran = await base(argv)
    if (argv[2] === 'prompt') fake.screen = '❯ [Pasted text #1 +70 lines]\n\n● Reading the brief.\n\n──────\n❯ \n──────\n  ? for shortcuts'
    return ran
  }
  const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.equal(delivery.ok, false)
  assert.equal(fake.keys.length, 0)
  assert.equal(fake.prompts.length, 2)
})

test('a stalled prompt of an agent that is already working is delivered without Enter', async () => {
  const { deps, run, fake } = await stalledSetup('pasted', 'working')
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt' })
  assert.equal(fake.keys.length, 0)
  assert.equal(fake.calls.filter(call => call[2] === 'read').length, 0)
})

test('a stalled prompt is read from the pane when herdr cannot read the agent', async () => {
  const { deps, run, fake } = await stalledSetup('pasted')
  fake.agentReadFails = true
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt', submitted: true })
  assert.ok(fake.calls.some(call => call[1] === 'pane' && call[2] === 'read'))
  assert.equal(fake.keys.length, 1)
})

test('a stalled prompt that cannot be read at all is reported not delivered, as before', async () => {
  const { deps, run, fake } = await stalledSetup('pasted')
  fake.agentReadFails = true
  fake.paneReadFails = 'pane_not_found'
  const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.equal(delivery.ok, false)
  assert.equal(fake.keys.length, 0)
})

test('a refused Enter is reported not delivered, with the text still in the input', async () => {
  const { deps, run, fake } = await stalledSetup('pasted')
  fake.sendKeysFails = 'unknown_command'
  const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.equal(!delivery.ok && delivery.queued, false)
  assert.match(!delivery.ok ? delivery.reason : '', /agent_prompt_stalled.*unsubmitted.*would not press Enter \(unknown_command\)/)
  assert.equal((await loadRoster(deps.home, run.id)).seats[0]?.attention[0]?.reason, 'stalled')
  assert.equal((await sentOf(deps, run)).length, 0)
})

test('an Enter that shows no activity is delivered-unconfirmed, and a hook record confirms it', async () => {
  const { deps, run, fake } = await stalledSetup('pasted')
  fake.enterSubmits = false
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt', unconfirmed: true, submitted: true })
  assert.equal(fake.keys.length, 1)

  const confirmed = await stalledSetup('pasted')
  confirmed.fake.enterSubmits = false
  const hooks = join(seatDir(confirmed.deps.home, confirmed.run.id, 'w-ui'), 'hooks.jsonl')
  const sentAt = confirmed.deps.clock.now().getTime()
  const exec = confirmed.deps.exec
  confirmed.deps.exec = async argv => {
    const result = await exec(argv)
    if (argv[2] === 'send-keys') await appendFile(hooks, `${JSON.stringify({ at: new Date(sentAt + 1_000).toISOString(), agent: 'claude', event: 'user-prompt-submit' })}\n`)
    return result
  }
  assert.deepEqual(await deliver.deliverControl(confirmed.deps, confirmed.run, control('w-ui')), { ok: true, via: 'herdr-prompt', submitted: true })
})

test('unsubmittedInput reads the last prompt line only', () => {
  const text = '⟦drove v1 run=r from=planner to=w-ui id=c-1 kind=brief expects=review mac=ab⟧\nbody'
  assert.equal(deliver.unsubmittedInput('❯ [Pasted text #1 +3 lines]', text), true)
  assert.equal(deliver.unsubmittedInput('│ > [Pasted Content 1520 chars]  │', text), true)
  assert.equal(deliver.unsubmittedInput('› ⟦drove v1 run=r from=planner to=w-ui id=c-1 kind=brief expects=review mac=ab⟧\n  body', text), true)
  assert.equal(deliver.unsubmittedInput('❯ [Pasted text #1 +3 lines]\n● done\n❯ ', text), false)
  assert.equal(deliver.unsubmittedInput('❯ ⟦drove v1 run=r from=planner to=w-ui id=c-0 kind=message', text), false)
  assert.equal(deliver.unsubmittedInput('❯ Try "fix lint errors"', text), false)
  assert.equal(deliver.unsubmittedInput('no prompt here', text), false)
  assert.equal(deliver.unsubmittedInput('', text), false)
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
  deps.exec = async argv => {
    if (argv[2] !== 'prompt') return base(argv)
    await appendFile(hooks, `${JSON.stringify({ at: new Date(sentAt + 1_000).toISOString(), agent: 'claude', event: 'user-prompt-submit' })}\n`)
    return herdrFail('timeout', 'timed out waiting for agent status')
  }
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

test('a bare herdr exit 1 while the seat is working waits for idle, then delivers', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  let gets = 0
  fake.exec = async argv => {
    if (argv[2] === 'prompt' && fake.agents.get('w-ui')?.status === 'working') return result('', 1, '')
    if (argv[2] === 'get' && ++gets === 3) fake.setStatus('w-ui', 'idle')
    return base(argv)
  }
  const { deps, run } = await setup(makeSeat('w-ui'), 'working', fake)
  assert.deepEqual(await deliver.deliverControl(deps, run, control('w-ui')), { ok: true, via: 'herdr-prompt' })
  assert.equal(fake.prompts.length, 1)
})

test('a seat that stays working queues the control with a readable reason', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  fake.exec = async argv => (argv[2] === 'prompt' ? result('', 1, '') : base(argv))
  const { deps, run } = await setup(makeSeat('w-ui'), 'working', fake)
  const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.equal(!delivery.ok && delivery.queued, true)
  assert.match(!delivery.ok ? delivery.reason : '', /^w-ui is working; herdr would not take the text/)
  assert.doesNotMatch(!delivery.ok ? delivery.reason : '', /exit_1/)
  assert.equal((await lines(join(seatDir(deps.home, run.id, 'w-ui'), 'pending.jsonl'))).length, 1)
})

test('delivery failures carry a readable reason, never a bare exit code', async () => {
  const cases: [string, ReturnType<typeof result>, RegExp][] = [
    ['empty exit 1 on an idle seat', result('', 1, ''), /refused to type into w-ui \(agent prompt exited 1 with no message\)/],
    ['exit with text', result('', 2, 'pane exploded'), /exited 2 with "pane exploded"/],
    ['exec timeout', result('', 124, 'timed out after 90000ms'), /did not answer in time/],
    ['pane gone', herdrFail('pane_not_found'), /pane is gone or unknown to herdr/],
  ]
  for (const [label, outcome, expected] of cases) {
    const fake = new FakeHerdr()
    const base = fake.exec
    fake.exec = async argv => (argv[2] === 'prompt' ? outcome : base(argv))
    const { deps, run } = await setup(makeSeat('w-ui'), 'idle', fake)
    const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
    assert.equal(delivery.ok, false, label)
    assert.match(!delivery.ok ? delivery.reason : '', expected, label)
  }
})

test('a pane that vanished between the prompt and the status check is reported as gone', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  fake.exec = async argv => {
    if (argv[2] === 'prompt') {
      fake.agents.delete('w-ui')
      return result('', 1, '')
    }
    return base(argv)
  }
  const { deps, run } = await setup(makeSeat('w-ui'), 'working', fake)
  const delivery = await deliver.deliverControl(deps, run, control('w-ui'))
  assert.match(!delivery.ok ? delivery.reason : '', /pane is gone or unknown to herdr/)
})

test('DROVE-108: a message or answer sent after a question or a block clears what the seat was owed', async () => {
  const asked = { id: 'r-1', kind: 'question' as const, expects: 'answer' as const, summary: 'which table?', at: '2000-01-01T00:00:00.000Z' }
  for (const kind of ['message', 'answer'] as const) {
    const { deps, run } = await setup(makeSeat('w-api', { kind: 'codex', sessionId: 'thread-1', state: 'idle', lastReport: asked, owes: 'answer' }))
    assert.equal((await deliver.deliverControl(deps, run, control('w-api', { kind, expects: 'none' }))).ok, true)
    assert.equal((await loadRoster(deps.home, run.id)).seats[0]?.owes, 'none', kind)
  }
  const blocked = { ...asked, id: 'r-2', kind: 'blocked' as const }
  const { deps, run } = await setup(makeSeat('w-api', { kind: 'codex', sessionId: 'thread-1', state: 'idle', lastReport: blocked, owes: 'answer' }))
  assert.equal((await deliver.deliverControl(deps, run, control('w-api', { kind: 'message', expects: 'none' }))).ok, true)
  assert.equal((await loadRoster(deps.home, run.id)).seats[0]?.owes, 'none')
})

test('DROVE-108: a verdict clears a review; a plain message, a nudge or a promote after a done report does not', async () => {
  const done = { id: 'r-1', kind: 'done' as const, expects: 'review' as const, summary: 'done', at: '2000-01-01T00:00:00.000Z' }
  const seat = () => makeSeat('w-api', { kind: 'codex', sessionId: 'thread-1', state: 'idle', lastReport: done, owes: 'review' })
  for (const kind of ['message', 'nudge', 'promote'] as const) {
    const { deps, run } = await setup(seat())
    assert.equal((await deliver.deliverControl(deps, run, control('w-api', { kind, expects: 'none' }))).ok, true)
    assert.equal((await loadRoster(deps.home, run.id)).seats[0]?.owes, 'review', kind)
  }
  const { deps, run } = await setup(seat())
  assert.equal((await deliver.deliverControl(deps, run, control('w-api', { kind: 'verdict', expects: 'review', verdict: 'approve' }))).ok, true)
  assert.equal((await loadRoster(deps.home, run.id)).seats[0]?.owes, 'none')
})

test('DROVE-108: a report that arrived while the answer was typed is still owed its own answer', async () => {
  const asked = { id: 'r-1', kind: 'question' as const, expects: 'answer' as const, summary: 'which table?', at: '2000-01-01T00:00:00.000Z' }
  const { deps, run } = await setup(makeSeat('w-api', { kind: 'codex', sessionId: 'thread-1', state: 'idle', lastReport: asked, owes: 'answer' }))
  const mod: DeliveryAdapter = {
    transport: 'mod',
    canDeliver: () => true,
    deliver: async () => {
      const roster = await loadRoster(deps.home, run.id)
      await updateRoster(deps.home, run.id, () => ({ ...roster, seats: roster.seats.map(entry => ({ ...entry, lastReport: { ...asked, id: 'r-2', summary: 'and which schema?' }, owes: 'answer' as const })) }))
      return { ok: true, via: 'mod' }
    },
  }
  deliver.registerAdapter(mod)
  assert.equal((await deliver.deliverControl(deps, run, control('w-api', { kind: 'message', expects: 'none' }))).ok, true)
  const seat = (await loadRoster(deps.home, run.id)).seats[0]
  assert.deepEqual([seat?.lastReport?.id, seat?.owes], ['r-2', 'answer'])
})
