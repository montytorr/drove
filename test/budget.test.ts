import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { budgetDetail, budgetNoticeText, needsBudgetNotice, needsNudge } from '../src/detect.ts'
import { seatDir } from '../src/paths.ts'
import { updateRoster } from '../src/roster.ts'
import { appendJsonl } from '../src/store.ts'
import type { HookRecord, Seat } from '../src/types.ts'
import * as usage from '../src/usage.ts'
import { createWatcher } from '../src/watch.ts'
import { eventsOf, fakePorts, rosterOf, seatOf, setup } from './p4-helpers.ts'
import type { Ctx } from './p4-helpers.ts'

const stops = async (ctx: Ctx, count: number, extra: Partial<HookRecord> = {}) => {
  for (let i = 0; i < count; i += 1) {
    await appendJsonl(join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'hooks.jsonl'), { at: ctx.clock.now().toISOString(), agent: 'claude', event: 'stop', sessionId: 's1', ...extra } satisfies HookRecord)
  }
}

const budgeted = async (change: Partial<Seat>) => {
  const ctx = await setup()
  await updateRoster(ctx.home, ctx.run.id, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, ...change })) }))
  const agents = () => [{ name: 'w-api', paneId: 'p-w-api', status: 'idle' as const }]
  const { ports, controls } = fakePorts({ agents })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  const poll = async () => {
    ctx.clock.advance(5_000)
    await watcher.tick()
  }
  return { ctx, ports, controls, watcher, poll }
}

const budgetAttention = async (ctx: Ctx) => (await rosterOf(ctx)).seats[0]?.attention.filter(item => item.reason === 'budget') ?? []

test('a seat that reaches maxTurns gets a budget attention and one notice, and is not stopped', async () => {
  const { ctx, controls, poll } = await budgeted({ maxTurns: 3 })
  await stops(ctx, 2)
  await poll()
  assert.deepEqual(await budgetAttention(ctx), [])
  assert.equal(controls.length, 0)

  await stops(ctx, 1)
  await poll()
  const [attention] = await budgetAttention(ctx)
  assert.equal(attention?.detail, 'used 3 of its 3 turns')
  assert.equal(controls.length, 1)
  assert.deepEqual([controls[0]?.kind, controls[0]?.to, controls[0]?.expects, controls[0]?.from], ['message', 'w-api', 'none', 'planner'])
  assert.match(controls[0]?.body ?? '', /Budget reached: you have used 3 of its 3 turns\..*progress.*promote.*stop/)
  assert.equal((await rosterOf(ctx)).seats[0]?.budgetNoticed, true)
  assert.equal((await eventsOf(ctx)).filter(event => event.type === 'attention' && event.data?.reason === 'budget').length, 1)

  await stops(ctx, 4)
  await poll()
  await poll()
  assert.equal(controls.length, 1)
  assert.equal((await budgetAttention(ctx)).length, 1)
  assert.equal((await rosterOf(ctx)).seats[0]?.state, 'working')
})

test('the turn count rebuilds from the hook file when the watcher restarts, and the notice is not repeated', async () => {
  const { ctx, ports, controls, poll } = await budgeted({ maxTurns: 2 })
  await stops(ctx, 2)
  await poll()
  assert.equal(controls.length, 1)

  const again = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  ctx.clock.advance(5_000)
  await again.tick()
  assert.equal((await budgetAttention(ctx)).length, 1)
  assert.equal(controls.length, 1)
})

test('a seat with no maxTurns is never flagged however many turns it takes', async () => {
  const { ctx, controls, poll } = await budgeted({})
  await stops(ctx, 30)
  await poll()
  assert.deepEqual(await budgetAttention(ctx), [])
  assert.equal(controls.length, 0)
})

test('a seat waiting on the planner after a report gets the attention but no notice', async () => {
  const { ctx, controls, poll } = await budgeted({ maxTurns: 1, owes: 'review' })
  await stops(ctx, 1)
  await poll()
  assert.equal((await budgetAttention(ctx)).length, 1)
  assert.equal(controls.length, 0)
  assert.equal((await rosterOf(ctx)).seats[0]?.budgetNoticed, undefined)

  await updateRoster(ctx.home, ctx.run.id, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, owes: 'none' as const })) }))
  await poll()
  assert.equal(controls.length, 1)
})

test('maxTokens counts a Claude transcript once per message, from the path the stop hook recorded', async () => {
  const dir = await setup()
  const transcript = join(dir.home, 'claude-transcript.jsonl')
  const assistant = (id: string, usageOf: Record<string, number>) => JSON.stringify({ type: 'assistant', message: { id, usage: usageOf } })
  await writeFile(transcript, [
    assistant('m1', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 4000, output_tokens: 90 }),
    assistant('m1', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 4000, output_tokens: 190 }),
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    'not json',
    assistant('m2', { input_tokens: 5, cache_read_input_tokens: 5000, output_tokens: 100 }),
  ].join('\n') + '\n')
  const counter = await usage.advanceTokens('claude', transcript)
  assert.equal(counter.total, 10 + 1000 + 4000 + 190 + 5 + 5000 + 100)
  await appendFileLine(transcript, assistant('m3', { input_tokens: 1, output_tokens: 9 }))
  assert.equal((await usage.advanceTokens('claude', transcript, counter)).total, counter.total + 10)

  const { ctx, controls, poll } = await budgeted({ kind: 'claude', maxTokens: 10_000 })
  await writeFile(join(ctx.home, 't.jsonl'), `${assistant('a', { input_tokens: 9000, output_tokens: 500 })}\n`)
  await stops(ctx, 1, { transcript: join(ctx.home, 't.jsonl') })
  await poll()
  assert.deepEqual(await budgetAttention(ctx), [])
  await appendFileLine(join(ctx.home, 't.jsonl'), assistant('b', { input_tokens: 400, cache_read_input_tokens: 200, output_tokens: 100 }))
  await poll()
  const [attention] = await budgetAttention(ctx)
  assert.equal(attention?.detail, 'used 10,200 of its 10,000 tokens')
  assert.equal(controls.length, 1)
})

test('maxTokens on a Codex seat is found in its home\'s rollout by session id, from the running total', async () => {
  const { ctx, controls, poll } = await budgeted({ kind: 'codex', maxTokens: 5_000, sessionId: 'thread-9' })
  const codexHome = join(ctx.home, 'codex-home')
  const day = join(codexHome, 'sessions', '2026', '10', '10')
  await mkdir(day, { recursive: true })
  const tokenCount = (total: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } } } })
  const rollout = join(day, 'rollout-2026-10-10T12-00-00-thread-9.jsonl')
  await writeFile(rollout, `${tokenCount(1200)}\n${tokenCount(3000)}\n`)
  await updateRoster(ctx.home, ctx.run.id, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, codexHome })) }))
  assert.equal(await usage.findRollout(codexHome, 'thread-9'), rollout)
  assert.equal(await usage.findRollout(codexHome, 'thread-1'), undefined)
  await poll()
  assert.deepEqual(await budgetAttention(ctx), [])
  await appendFileLine(rollout, tokenCount(5200))
  await poll()
  assert.equal((await budgetAttention(ctx))[0]?.detail, 'used 5,200 of its 5,000 tokens')
  assert.equal(controls.length, 1)
})

test('budgetDetail, the notice text and the nudge rule', () => {
  assert.equal(budgetDetail({ maxTurns: 5 }, { turns: 4 }), undefined)
  assert.equal(budgetDetail({ maxTurns: 5 }, { turns: 5 }), 'used 5 of its 5 turns')
  assert.equal(budgetDetail({ maxTokens: 100 }, { turns: 99, tokens: 100 }), 'used 100 of its 100 tokens')
  assert.equal(budgetDetail({ maxTokens: 100 }, { turns: 99 }), undefined)
  assert.equal(budgetDetail({}, { turns: 99, tokens: 1e9 }), undefined)
  assert.match(budgetNoticeText('used 5 of its 5 turns'), /progress report.*promote report/)
  const flagged = seatOf('w-api', { state: 'idle', stateAt: '2026-10-09T09:00:00.000Z', lastWorkingAt: '2026-10-09T09:30:00.000Z', attention: [{ seat: 'w-api', reason: 'budget', detail: 'x', at: '2026-10-09T09:31:00.000Z' }] })
  assert.equal(needsNudge({ ...flagged, attention: [] }, new Date('2026-10-09T10:00:00.000Z')), true)
  assert.equal(needsNudge(flagged, new Date('2026-10-09T10:00:00.000Z')), false)
  assert.equal(needsBudgetNotice(flagged), true)
  assert.equal(needsBudgetNotice({ ...flagged, budgetNoticed: true }), false)
  assert.equal(needsBudgetNotice({ ...flagged, owes: 'review' }), false)
})

const appendFileLine = async (path: string, line: string) => (await import('node:fs/promises')).appendFile(path, `${line}\n`)
