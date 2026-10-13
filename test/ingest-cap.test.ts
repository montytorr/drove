import assert from 'node:assert/strict'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { clippedMarker, fitReport } from '../src/pending.ts'
import type { LedgerLine } from '../src/pending.ts'
import { plannerDir, seatDir } from '../src/paths.ts'
import { newReportId, stampReport } from '../src/protocol.ts'
import { updateRoster } from '../src/roster.ts'
import { appendJsonl, clipUtf8, jsonlBytes, LINE_MAX_BYTES, readJson, readJsonlFrom, REPORT_MAX_BYTES, writeJsonAtomic } from '../src/store.ts'
import { workerTools } from '../src/tools.ts'
import type { HookRecord, Report, ReportInput } from '../src/types.ts'
import { BATCH_MS, createWatcher } from '../src/watch.ts'
import { eventsOf, fakePorts, setup } from './p4-helpers.ts'
import type { Ctx } from './p4-helpers.ts'

const jsonl = (items: unknown[]): string => `${items.map(item => JSON.stringify(item)).join('\n')}\n`
const stamp = (seconds: number): string => new Date(Date.parse('2026-10-09T09:30:00.000Z') + seconds * 1000).toISOString()
let ids = 0
const claudeCall = (name: string, input: Record<string, unknown>, second: number): unknown[] => {
  ids += 1
  const id = `toolu_${ids}`
  return [
    { type: 'assistant', timestamp: stamp(second), message: { id: `msg_${ids}`, content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', timestamp: stamp(second + 1), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'text' }] } },
  ]
}

// A Claude seat whose last edit has no check after it, so its done report gets the R2 line.
const uncheckedSeat = async () => {
  const ctx = await setup()
  const transcript = join(ctx.home, 'claude-session.jsonl')
  await writeFile(transcript, jsonl([...claudeCall('Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }, 10), ...claudeCall('Bash', { command: 'git status' }, 20)]))
  await updateRoster(ctx.home, ctx.run.id, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, kind: 'claude' as const, sessionId: 's1' })) }))
  const hook: HookRecord = { at: ctx.clock.now().toISOString(), agent: 'claude', event: 'session-start', sessionId: 's1', transcript }
  await appendJsonl(join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'hooks.jsonl'), hook)
  return ctx
}

// Straight to the outbox, as an older report tool (or a worker by hand) could write it: only the jsonl cap applies.
const fileRaw = async (ctx: Ctx, input: ReportInput, bytes?: number): Promise<Report> => {
  ctx.clock.advance(1000)
  const at = ctx.clock.now()
  let report = stampReport(input, { id: newReportId('w-api', at.getTime()), run: ctx.run.id, seat: 'w-api', token: ctx.tokens['w-api'] ?? '', at: at.toISOString() })
  if (bytes !== undefined) report = { ...report, details: 'x'.repeat(bytes - jsonlBytes({ ...report, details: '' })) }
  await appendJsonl(join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'outbox.jsonl'), report)
  return report
}

const ledgerOf = async (ctx: Ctx) => (await readJsonlFrom<LedgerLine>(join(plannerDir(ctx.home, ctx.run.id), 'pending.jsonl'), { offset: 0 })).items
const cursorOf = async (ctx: Ctx) => (await readJson<Record<string, { offset: number }>>(join(plannerDir(ctx.home, ctx.run.id), 'cursors.json')))?.['w-api']?.offset
const outboxSize = async (ctx: Ctx) => (await stat(join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'outbox.jsonl'))).size
const queued = (ctx: Ctx) => ctx.calls.filter(argv => argv[0] === 'codex')
const eventsFor = async (ctx: Ctx, id: string) => (await eventsOf(ctx)).filter(event => event.id === id)

const watching = (ctx: Ctx) => {
  const { ports } = fakePorts({ agents: () => [{ name: 'w-api', paneId: 'p-w-api', status: 'working' as const }] })
  const errors: string[] = []
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false, onError: (_error, step) => void errors.push(step) })
  const ticks = async (count: number) => {
    for (let i = 0; i < count; i++) {
      ctx.clock.advance(BATCH_MS)
      await watcher.tick()
    }
  }
  return { watcher, ticks, errors }
}

test('DROVE-170 AC1/AC2: an 8,100-byte done report with the R2 line lands in the ledger once, clipped, the cursor moves and the planner is woken once', async () => {
  const ctx = await uncheckedSeat()
  const report = await fileRaw(ctx, { kind: 'done', expects: 'review', summary: 'trust check done' }, 8100)
  assert.equal(await outboxSize(ctx), 8100)
  const { watcher, ticks } = watching(ctx)
  await watcher.tick()
  await ticks(5)

  const lines = (await ledgerOf(ctx)).filter(line => line.t !== 'ack' && line.report.id === report.id)
  assert.equal(lines.length, 1)
  const [line] = lines
  assert.ok(line && line.t !== 'ack')
  assert.match(line.report.steering ?? '', /^Drove: no check ran after the last edit/)
  assert.ok(line.report.details?.endsWith(clippedMarker('w-api')), 'the details say they were clipped')
  assert.equal(line.report.summary, 'trust check done')
  assert.equal(await cursorOf(ctx), await outboxSize(ctx))
  assert.equal(queued(ctx).length, 1)
  assert.match(queued(ctx)[0]?.at(-1) ?? '', /trust check done/)

  const events = await eventsFor(ctx, report.id)
  assert.equal(events.filter(event => event.type === 'report').length, 1)
  assert.equal(events.filter(event => event.type === 'steer.nudged').length, 1)

  // Read again from the start (a cursor lost to a crash): still one event, one R2 line, one ledger entry and one wake.
  await writeJsonAtomic(join(plannerDir(ctx.home, ctx.run.id), 'cursors.json'), {})
  await ticks(5)
  const again = await eventsFor(ctx, report.id)
  assert.equal(again.filter(event => event.type === 'report').length, 1)
  assert.equal(again.filter(event => event.type === 'steer.nudged').length, 1)
  assert.equal((await ledgerOf(ctx)).filter(line => line.t !== 'ack' && line.report.id === report.id).length, 1)
  assert.equal(queued(ctx).length, 1)
})

test('DROVE-170 AC3: a report that cannot fit even clipped is rejected once, wakes the planner once, and the report after it still lands', async () => {
  const ctx = await uncheckedSeat()
  const criteria = Array.from({ length: 8 }, (_, index) => ({ id: `AC${index + 1}`, met: true, evidence: 'e'.repeat(960) }))
  const huge = await fileRaw(ctx, { kind: 'done', expects: 'review', summary: 'all criteria', criteria })
  assert.ok((await outboxSize(ctx)) > LINE_MAX_BYTES - 200)
  const after = await fileRaw(ctx, { kind: 'question', expects: 'answer', summary: 'and one more thing' })
  const { watcher, ticks, errors } = watching(ctx)
  await watcher.tick()
  await ticks(5)

  const rejected = (await eventsOf(ctx)).filter(event => event.type === 'attention' && event.data?.reason === 'report-rejected')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0]?.id, huge.id)
  assert.match(String(rejected[0]?.data?.why), /over the 8192-byte ledger line/)
  assert.deepEqual(errors, ['ingest-report'])
  assert.equal(await cursorOf(ctx), await outboxSize(ctx))
  const ledger = await ledgerOf(ctx)
  assert.ok(!ledger.some(line => line.t !== 'ack' && line.report.id === huge.id))
  assert.ok(ledger.some(line => line.t !== 'ack' && line.report.id === after.id))
  assert.equal(queued(ctx).length, 1)
  const wake = queued(ctx)[0]?.at(-1) ?? ''
  assert.match(wake, /and one more thing/)
  assert.match(wake, new RegExp(`For you to act on:\\n⚠ w-api: report-rejected: ${huge.id}: `))
  assert.equal((await eventsFor(ctx, huge.id)).filter(event => event.type === 'report').length, 1)
})

test('DROVE-170: a rejection with no report to carry it still wakes the planner, once', async () => {
  const ctx = await uncheckedSeat()
  const criteria = Array.from({ length: 8 }, (_, index) => ({ id: `AC${index + 1}`, met: true, evidence: 'e'.repeat(960) }))
  await fileRaw(ctx, { kind: 'done', expects: 'review', summary: 'all criteria', criteria })
  const { watcher, ticks } = watching(ctx)
  await watcher.tick()
  await ticks(5)
  assert.equal(queued(ctx).length, 1)
  assert.match(queued(ctx)[0]?.at(-1) ?? '', /^For you to act on:\n⚠ w-api: report-rejected: /)
})

test('DROVE-170 AC4: clipping counts bytes, never splits a UTF-8 character, and marks the report', () => {
  assert.equal(clipUtf8('héllo', 2), 'h')
  assert.equal(clipUtf8('héllo', 3), 'hé')
  assert.equal(clipUtf8('a😀b', 4), 'a')
  assert.equal(clipUtf8('a😀b', 5), 'a😀')
  assert.equal(clipUtf8('abc', -4), '')

  const at = '2026-10-09T09:30:00.000Z'
  const base: Report = { v: 1, id: 'r-1', run: 'run', seat: 'w-api', token: 't', kind: 'done', expects: 'review', summary: 'ok', at }
  const line = (report: Report): LedgerLine => ({ t: 'add', report })
  for (const filler of ['é', '😀', '"', '\n', 'ab']) {
    const report = { ...base, details: filler.repeat(Math.ceil(9000 / Buffer.byteLength(filler))) }
    const fitted = fitReport(report, line)
    assert.ok(fitted, JSON.stringify(filler))
    assert.ok(jsonlBytes(line(fitted)) <= LINE_MAX_BYTES)
    assert.ok(!fitted.details?.includes('�'), 'no broken character')
    assert.match(fitted.details ?? '', /clipped by Drove .* drove reports w-api shows it in full\]$/)
    assert.equal(fitted.summary, 'ok')
  }

  // Details first, then the summary.
  const both = fitReport({ ...base, details: 'd'.repeat(200), summary: 's'.repeat(9000) }, line)
  assert.ok(both)
  assert.match(both.details ?? '', /clipped by Drove/)
  assert.match(both.summary, /^s+ … \[clipped by Drove/)
  assert.ok(jsonlBytes(line(both)) <= LINE_MAX_BYTES)

  const small = { ...base, details: 'short' }
  assert.equal(fitReport(small, line), small)
})

test('DROVE-170 AC5: the report tool refuses a report that leaves under 2 KiB of the line, and says why', async () => {
  const ctx = await setup()
  const [tool] = workerTools(ctx.deps, { home: ctx.home, run: ctx.run.id, role: 'worker', seat: 'w-api', token: ctx.tokens['w-api'] })
  assert.equal(REPORT_MAX_BYTES, LINE_MAX_BYTES - 2048)
  const big = await tool?.call({ kind: 'done', summary: 'long', details: 'x'.repeat(5000), criteria: [{ id: 'AC1', met: true, evidence: 'é'.repeat(600) }] })
  assert.equal(big?.isError, true)
  assert.match(big?.text ?? '', /^Not recorded: this report is \d+ bytes, over the 6144-byte limit/)
  assert.match(big?.text ?? '', /Shorten details/)
  assert.equal(await stat(join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'outbox.jsonl')).catch(() => undefined), undefined)

  const fits = await tool?.call({ kind: 'done', summary: 'short', details: 'x'.repeat(5000) })
  assert.equal(fits?.isError, undefined)
})
