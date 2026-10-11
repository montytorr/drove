import assert from 'node:assert/strict'
import { appendFile, mkdir, utimes, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { attentionCandidates } from '../src/attention.ts'
import { boardSource } from '../src/board.ts'
import { deliverControl } from '../src/deliver.ts'
import { seatDir } from '../src/paths.ts'
import { newReportId, stampReport } from '../src/protocol.ts'
import { loadRoster } from '../src/roster.ts'
import { appendJsonl, readJsonlFrom } from '../src/store.ts'
import type { DroveEvent, HerdrStatus, Seat } from '../src/types.ts'
import { payloadOf } from '../src/web.ts'
import { createWatcher } from '../src/watch.ts'
import { FakeHerdr, makeDeps, makeSeat, seedRun, tmp } from './p3-helpers.ts'

// DROVE-108: the sequence of run seal-20261011-2029-c080, replayed from its own files. Two Claude workers each asked a
// question, the planner answered with a message, herdr said idle, and the hooks showed a prompt with no Stop after it.
// The fixtures are that run's events.jsonl (the two seats, to 19:17:30), each seat's hooks.jsonl and the times the
// seat's transcript was written. Nothing but the transcript path and the session id is changed.

const FIXTURES = join(import.meta.dirname, 'fixtures', 'idle-replay')
const SEATS = ['w-sender', 'w-agents'] as const
const START = Date.parse('2026-10-11T19:04:12.000Z')
const END = Date.parse('2026-10-11T19:17:30.000Z')
const TICK_MS = 5_000

const jsonl = <T>(name: string): T[] =>
  readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T)

type Hook = { at: string; agent: string; event: string; sessionId?: string; transcript?: string; detail?: string }
type Step = { at: number; order: number; run: () => Promise<void> }

// What herdr reported, read back from Drove's own state changes in the log: idle at each question report, done for a
// few seconds after the first one, and idle from then on, whatever the seat was doing.
const HERDR: Record<(typeof SEATS)[number], [string, HerdrStatus][]> = {
  'w-sender': [['2026-10-11T19:05:54.574Z', 'idle'], ['2026-10-11T19:06:00.500Z', 'done'], ['2026-10-11T19:06:09.000Z', 'idle']],
  'w-agents': [['2026-10-11T19:05:18.608Z', 'idle']],
}

const replay = async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake, 'idle-replay')
  deps.clock.advance(START - deps.clock.now().getTime())
  const startIso = new Date(START).toISOString()
  const seats = SEATS.map((name): Seat => makeSeat(name, { state: 'working', stateAt: startIso, spawnedAt: startIso, lastWorkingAt: startIso, paneId: `w1:p-${name}`, cairn: name === 'w-sender' ? 'SEAL-7' : 'SEAL-5' }))
  const run = await seedRun(deps, '/repo', seats, { planner: { kind: 'codex', sessionId: 'thread-1', model: 'gpt-5', effort: 'high', viaMod: false } })
  const transcripts = new Map<string, string>()
  const steps: Step[] = []
  let order = 0
  const at = (iso: string, work: () => Promise<void>) => steps.push({ at: Date.parse(iso), order: order++, run: work })

  for (const name of SEATS) {
    const dir = seatDir(deps.home, run.id, name)
    await mkdir(dir, { recursive: true })
    const transcript = join(await tmp('transcript'), `${name}.jsonl`)
    await writeFile(transcript, '')
    transcripts.set(name, transcript)
    fake.agents.set(name, { name, paneId: `w1:p-${name}`, tabId: 'w1:t1', status: 'working' })
    for (const hook of jsonl<Hook>(`${name}.hooks.jsonl`)) at(hook.at, () => appendFile(join(dir, 'hooks.jsonl'), `${JSON.stringify({ ...hook, transcript })}\n`))
    for (const written of JSON.parse(readFileSync(join(FIXTURES, `${name}.transcript-times.json`), 'utf8')) as string[]) at(written, () => utimes(transcript, new Date(written), new Date(written)))
    for (const [when, status] of HERDR[name]) at(when, async () => void fake.setStatus(name, status))
  }

  let sends = 0
  for (const event of jsonl<DroveEvent>('events.jsonl')) {
    const seat = event.seat ?? ''
    if (event.type === 'report') {
      at(event.at, async () => {
        const data = event.data as { kind: 'question'; expects: 'answer'; summary: string }
        const report = stampReport({ kind: data.kind, summary: data.summary, expects: data.expects }, { id: newReportId(seat, Date.parse(event.at)), run: run.id, seat, token: `token-${seat}`, at: event.at })
        await appendJsonl(join(seatDir(deps.home, run.id, seat), 'outbox.jsonl'), report)
      })
    }
    if (event.type === 'control.sent' && event.data?.kind === 'message') {
      at(event.at, async () => {
        const delivery = await deliverControl(deps, run, { v: 1, id: `c-replay-${sends++}`, run: run.id, from: 'planner', to: seat, kind: 'message', expects: 'none', body: 'Go with option A.', at: event.at })
        assert.equal(delivery.ok, true)
        // typing into a busy session is what flipped herdr to idle in the real run
        fake.setStatus(seat, 'idle')
      })
    }
  }

  const watcher = createWatcher(deps, run, { loop: false })
  const snapshots: { at: number; states: Record<string, Seat['state']>; owes: Record<string, Seat['owes']> }[] = []
  for (let tick = START + TICK_MS; tick <= END; tick += TICK_MS) {
    at(new Date(tick).toISOString(), async () => {
      await watcher.tick()
      const roster = await loadRoster(deps.home, run.id)
      snapshots.push({
        at: deps.clock.now().getTime(),
        states: Object.fromEntries(roster.seats.map(seat => [seat.name, seat.state])),
        owes: Object.fromEntries(roster.seats.map(seat => [seat.name, seat.owes])),
      })
    })
  }

  // a tick runs after anything the log timestamps at the same instant
  steps.sort((a, b) => a.at - b.at || a.order - b.order)
  for (const step of steps) {
    const now = deps.clock.now().getTime()
    if (step.at > now) deps.clock.advance(step.at - now)
    await step.run()
  }
  const events = (await readJsonlFrom<DroveEvent>(join(deps.home, 'runs', run.id, 'events.jsonl'), { offset: 0 })).items
  return { deps, run, fake, events, snapshots }
}

test('the fixture holds what the run really did: idle-without-report five times and a seat marked idle', () => {
  const events = jsonl<DroveEvent>('events.jsonl')
  const raised = events.filter(event => event.type === 'attention' && event.data?.reason === 'idle-without-report')
  assert.ok(raised.length >= 5, `${raised.length} idle-without-report events in the log`)
  assert.ok(events.some(event => event.type === 'control.sent' && event.seat === 'w-sender' && event.data?.kind === 'message'))
  const hooks = jsonl<Hook>('w-sender.hooks.jsonl').map(hook => hook.event)
  assert.deepEqual(hooks, ['session-start', 'user-prompt-submit', 'stop', 'user-prompt-submit', 'user-prompt-submit', 'user-prompt-submit'])
})

test('replaying the run: the seats stay working, no idle-without-report, no needs-you, and the owed answer clears', async () => {
  const { deps, run, fake, events, snapshots } = await replay()
  const at = (iso: string) => Date.parse(iso)

  // w-sender: its question at 19:05:54 owes an answer until the planner's message at 19:06:15
  const between = snapshots.filter(({ at: when }) => when >= at('2026-10-11T19:05:58.000Z') && when <= at('2026-10-11T19:06:07.000Z'))
  assert.ok(between.length > 0)
  for (const shot of between) {
    assert.ok(shot.states['w-sender'] === 'idle' || shot.states['w-sender'] === 'done', `w-sender is ${shot.states['w-sender']} between its Stop and the next prompt`)
    assert.equal(shot.owes['w-sender'], 'answer')
  }
  // from its next prompt on the turn never closes, and herdr's idle does not change that
  const open = snapshots.filter(({ at: when }) => when >= at('2026-10-11T19:06:12.000Z'))
  assert.ok(open.length > 100)
  for (const shot of open) assert.equal(shot.states['w-sender'], 'working', `w-sender at ${new Date(shot.at).toISOString()}`)
  for (const shot of snapshots.filter(({ at: when }) => when >= at('2026-10-11T19:05:32.000Z'))) assert.equal(shot.states['w-agents'], 'working', `w-agents at ${new Date(shot.at).toISOString()}`)

  // the planner's message answered the question: nothing is owed any more
  for (const shot of snapshots.filter(({ at: when }) => when >= at('2026-10-11T19:06:16.000Z'))) assert.equal(shot.owes['w-sender'], 'none')
  for (const shot of snapshots.filter(({ at: when }) => when >= at('2026-10-11T19:05:36.000Z'))) assert.equal(shot.owes['w-agents'], 'none')

  assert.deepEqual(events.filter(event => event.type === 'attention').map(event => event.data?.reason), [])
  assert.deepEqual(fake.prompts.map(({ text }) => /kind=(\w+)/.exec(text)?.[1]), ['message', 'message', 'message'])

  const roster = await loadRoster(deps.home, run.id)
  assert.deepEqual(roster.seats.map(seat => [seat.name, seat.state, seat.attention.length]), [['w-sender', 'working', 0], ['w-agents', 'working', 0]])
  assert.deepEqual(
    attentionCandidates({ run, roster, reports: [], status: {}, events, at: new Date(END).toISOString() }),
    [],
  )

  const payload = payloadOf(await boardSource(deps, run.id)(), END, 0)
  assert.deepEqual(payload.seats.map(seat => [seat.name, seat.needsYou, seat.owes]), [['w-sender', false, 'none'], ['w-agents', false, 'none']])
  assert.equal(payload.feed.filter(entry => entry.kind === 'attention').length, 0)
})
