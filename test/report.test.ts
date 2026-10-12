import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { runDir, seatDir } from '../src/paths.ts'
import { loadRun, saveRun } from '../src/roster.ts'
import { buildReport, claudeTranscriptPath, costOf, duration, emptyUsage, noteLines, priceOf, renderReport } from '../src/report.ts'
import type { Deps, DroveEvent, ExecResult } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, makeSeat, RUN, seedRun, tmp } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID']) delete process.env[key]
})

const jsonl = (items: unknown[]): string => `${items.map(item => JSON.stringify(item)).join('\n')}\n`
const assistant = (id: string, model: string, usage: Record<string, unknown>, timestamp = '2026-10-09T09:15:00.000Z') => ({ type: 'assistant', timestamp, message: { id, model, usage } })
const at = (time: string): string => `2026-10-09T${time}:00.000Z`
const event = (time: string, type: DroveEvent['type'], seat: string, data?: Record<string, unknown>): DroveEvent => ({ at: at(time), type, seat, ...(data ? { data } : {}) })

// A run with a Claude seat (transcript, events with every kind of rework), a Codex seat (rollout), and a Claude seat whose transcript is gone.
const world = async () => {
  const fake = new FakeHerdr()
  const deps: Deps = { ...(await makeDeps(fake)), claudeUserDir: await tmp('claude-user') }
  deps.clock = { now: () => new Date(at('10:00')) }
  const codexHome = await tmp('codex-home')
  const seats = [
    makeSeat('w-a', { sessionId: 's-a', worktree: '/repo/.claude/worktrees/w-a', state: 'closed', cairn: 'DROVE-1' }),
    makeSeat('w-c', { kind: 'codex', model: 'gpt-6.1-sol', sessionId: 'thread-1', codexHome, worktree: '/repo/.claude/worktrees/w-c', state: 'working' }),
    makeSeat('w-gone', { sessionId: 's-gone', worktree: '/repo/.claude/worktrees/w-gone', state: 'working' }),
  ]
  const run = await seedRun(deps, await makeRepo(), seats)
  const claudeDir = deps.claudeUserDir as string
  const transcript = claudeTranscriptPath(claudeDir, '/repo/.claude/worktrees/w-a', 's-a')
  await mkdir(join(transcript, '..'), { recursive: true })
  const hour = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 }
  await writeFile(
    transcript,
    `${jsonl([
      assistant('m1', 'claude-sonnet-5-5', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: hour }),
      assistant('m1', 'claude-sonnet-5-5', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: hour }),
      assistant('m2', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 40 }),
      assistant('m3', 'claude-mystery-1', { input_tokens: 7, output_tokens: 3 }),
      assistant('m0', 'claude-sonnet-5-5', { input_tokens: 999999, output_tokens: 999999 }, '2026-10-08T09:00:00.000Z'),
      { type: 'user', message: { content: 'hi' } },
    ])}not json\n`,
  )
  const rollout = join(codexHome, 'sessions', '2026', '10', '09')
  await mkdir(rollout, { recursive: true })
  await writeFile(
    join(rollout, 'rollout-2026-10-09T10-00-00-thread-1.jsonl'),
    jsonl([
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 300, cache_write_input_tokens: 0, output_tokens: 20, total_tokens: 520 } } } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 700, cache_write_input_tokens: 0, output_tokens: 40, total_tokens: 940 } } } },
    ]),
  )
  const events: DroveEvent[] = [
    event('09:10', 'seat.spawn', 'w-a', { kind: 'claude', model: 'claude-sonnet-5-5', cairn: 'DROVE-1' }),
    event('09:20', 'attention', 'w-a', { reason: 'dialog', detail: 'a permission dialog' }),
    event('09:22', 'attention', 'w-a', { reason: 'idle-without-report', detail: 'not the human' }),
    event('09:25', 'seat.state', 'w-a', { from: 'needs-input', to: 'working' }),
    event('09:30', 'control.sent', 'w-a', { kind: 'verdict', verdict: 'changes', via: 'herdr-prompt' }),
    event('09:32', 'report', 'w-a', { kind: 'done', expects: 'review', summary: 'again' }),
    event('09:33', 'control.sent', 'w-a', { kind: 'verdict', via: 'herdr-prompt' }),
    event('09:34', 'report', 'w-a', { kind: 'done', expects: 'review', summary: 'third' }),
    event('09:35', 'control.sent', 'w-a', { kind: 'promote', via: 'herdr-prompt', model: 'claude-opus-5-5' }),
    event('09:36', 'control.sent', 'w-a', { kind: 'demote', via: 'herdr-prompt' }),
    event('09:37', 'seat.migrate', 'w-a', { from: 'claude', to: 'codex' }),
    event('09:38', 'seat.relaunch', 'w-a', {}),
    event('09:40', 'control.sent', 'w-a', { kind: 'verdict', verdict: 'approve', via: 'herdr-prompt' }),
    event('09:50', 'seat.close', 'w-a'),
    event('09:12', 'seat.spawn', 'w-c', { kind: 'codex', model: 'gpt-6.1-sol' }),
    event('09:40', 'attention', 'w-c', { reason: 'usage-limit', detail: 'limit' }),
    event('09:45', 'seat.spawn', 'w-gone', { kind: 'claude', model: 'claude-sonnet-5-5' }),
  ]
  await writeFile(join(runDir(deps.home, run.id), 'events.jsonl'), jsonl(events))
  await mkdir(seatDir(deps.home, run.id, 'w-a'), { recursive: true })
  return { deps, run, fake, claudeDir }
}

test('cost math: input, output, cache reads and 5 minute and 1 hour cache writes at the model price; unknown models have none', () => {
  const usage = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, output: 1_000_000 }
  assert.equal(costOf('claude-opus-5-5', usage), 4 + 20 + 0.2 + 5 + 8)
  assert.equal(costOf('claude-sonnet-5-5', usage), 2 + 10 + 0.2 + 2.5 + 4)
  assert.equal(costOf('claude-opus-5-5-20261001', usage), costOf('claude-opus-5-5', usage))
  assert.equal(priceOf('claude-opus-5-5[1m]')?.output, 20)
  assert.equal(costOf('gpt-6.1-sol', usage), undefined)
  assert.equal(costOf('claude-opus-5-5', emptyUsage()), 0)
})

test("the report sums a seat's transcript once per message, per model, inside the run, and prices what it can", async () => {
  const { deps, claudeDir } = await world()
  const report = await buildReport(deps, RUN, claudeDir)
  assert.ok(report)
  const a = report.seats.find(row => row.seat === 'w-a')
  assert.ok(a?.tokens)
  assert.deepEqual(a.tokens, { input: 117, cacheRead: 1000, cacheWrite5m: 40, cacheWrite1h: 200, output: 58, total: 1415 })
  const sonnet = a.models.find(item => item.model === 'claude-sonnet-5-5')
  assert.deepEqual(sonnet?.usage, { input: 100, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 200, output: 50 })
  const expected = (100 * 2 + 50 * 10 + 1000 * 0.2 + 200 * 2 * 2) / 1e6 + (10 * 4 + 5 * 20 + 40 * 4 * 1.25) / 1e6
  assert.ok(Math.abs((a.cost ?? 0) - expected) < 1e-12)
  assert.deepEqual(a.unpriced, ['claude-mystery-1'])
  assert.equal(a.transcripts, 1)
})

test('a Codex seat reads the last token_count of its rollout, input without the cached part; its model has no price', async () => {
  const { deps, claudeDir } = await world()
  const report = await buildReport(deps, RUN, claudeDir)
  const c = report?.seats.find(row => row.seat === 'w-c')
  assert.deepEqual(c?.tokens, { input: 200, cacheRead: 700, cacheWrite5m: 0, cacheWrite1h: 0, output: 40, total: 940 })
  assert.equal(c?.cost, undefined)
  assert.deepEqual(c?.unpriced, ['gpt-6.1-sol'])
})

test('a seat with no transcript is listed as not found and carries no tokens; the totals still add up', async () => {
  const { deps, claudeDir } = await world()
  const report = await buildReport(deps, RUN, claudeDir)
  assert.ok(report)
  const gone = report.seats.find(row => row.seat === 'w-gone')
  assert.equal(gone?.tokens, undefined)
  assert.equal(gone?.transcripts, 0)
  assert.match(gone?.notFound[0] ?? '', /s-gone/)
  assert.deepEqual(report.totals.notFound, ['planner', 'w-gone'])
  assert.equal(report.totals.tokens.total, 1415 + 940)
  assert.equal(report.totals.seats, 3)
  assert.deepEqual([...report.totals.unpriced].sort(), ['claude-mystery-1', 'gpt-6.1-sol'])
})

test('time and rework come from the events: spawn to close, human waits only for human reasons, verdicts read from data or the next report', async () => {
  const { deps, claudeDir } = await world()
  const report = await buildReport(deps, RUN, claudeDir)
  const a = report?.seats.find(row => row.seat === 'w-a')
  assert.equal(a?.wallMs, 40 * 60_000)
  assert.equal(a?.humanMs, 5 * 60_000)
  assert.deepEqual(a?.rework, { changes: 2, approvals: 1, promotions: 1, demotions: 1, migrations: 1, restarts: 1 })
  const c = report?.seats.find(row => row.seat === 'w-c')
  assert.equal(c?.wallMs, 48 * 60_000)
  assert.equal(c?.humanMs, 20 * 60_000)
  assert.equal(report?.totals.rework.changes, 2)
  assert.equal(report?.totals.humanMs, 25 * 60_000)
})

test('the table shows every seat and the totals, and says what is missing', async () => {
  const { deps, claudeDir } = await world()
  const report = await buildReport(deps, RUN, claudeDir)
  assert.ok(report)
  const text = renderReport(report)
  assert.match(text, /w-a\s+claude\s+claude-sonnet-5-5\s+40m\s+5m\s+1\.4k/)
  assert.match(text, /total \(3 seats\)/)
  assert.match(text, /kinds: 2 claude · 1 codex/)
  assert.match(text, /tokens by kind \(including planner\): claude: 1\.4k\+ · codex: 940/)
  assert.match(text, /No transcript found for planner \(1\), w-gone \(1\)/)
  assert.match(text, /No price for .*gpt-6\.1-sol/)
  assert.equal(duration(90 * 60_000), '1h30')
  assert.ok(noteLines(report).some(line => line.startsWith('- w-gone') && line.includes('no transcript')))
  assert.ok(noteLines(report).includes('kinds: 2 claude · 1 codex'))
})

test('drove report finds the run, prints JSON on request and fails for an unknown run', async () => {
  const { deps } = await world()
  const json = await commands.runReport(deps, { run: RUN, repo: '/nowhere' }, true)
  assert.equal(json.ok, true)
  assert.equal(JSON.parse(json.ok ? json.text : '{}').run, RUN)
  const plain = await commands.runReport(deps, { run: RUN, repo: '/nowhere' }, false)
  assert.match(plain.ok ? plain.text : '', /^run drove-/)
  const missing = await commands.runReport(deps, { run: 'drove-nope', repo: '/nowhere' }, false)
  assert.equal(missing.ok, false)
})

test('down appends the totals and the per-seat table to the summary note on the goal task', async () => {
  const { deps, fake } = await world()
  const notes: string[][] = []
  const base = fake.exec
  const wrapped: Deps = {
    ...deps,
    exec: async (argv, options) => {
      if (argv[0] !== 'cairn') return base(argv, options)
      notes.push([...argv])
      return { code: 0, stdout: '', stderr: '' } satisfies ExecResult
    },
  }
  const run = await loadRun(deps.home, RUN)
  assert.ok(run)
  await saveRun(deps.home, { ...run, cairn: 'DROVE-70' })
  const downed = await commands.down(wrapped, { run: RUN, repo: '/x' })
  assert.equal(downed.ok, true, downed.text)
  const note = notes.find(call => call[1] === 'note')?.[3] ?? ''
  assert.match(note, /Cost and rework: .* tokens .*; 2 change round\(s\), 1 promotion\(s\)/)
  assert.match(note, /- w-a \(claude claude-sonnet-5-5\): .* tokens/)
  assert.match(note, /- w-gone \(claude claude-sonnet-5-5\): no transcript/)
})
