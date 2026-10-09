import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { seatDir } from '../src/paths.ts'
import { stampReport } from '../src/protocol.ts'
import { updateRoster } from '../src/roster.ts'
import { appendJsonl, readJsonlFrom } from '../src/store.ts'
import type { Report } from '../src/types.ts'
import { seatOf, setup } from './p4-helpers.ts'
import type { Ctx } from './p4-helpers.ts'

const server = join(import.meta.dirname, 'p4-server.ts')

type Message = { id?: number | string; method?: string; result?: Record<string, any>; error?: { code: number; message: string }; params?: Record<string, any> }

const launch = (ctx: Ctx, role: 'planner' | 'worker', seat: string, extraEnv: Record<string, string> = {}) => {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', server], {
    env: { ...process.env, DROVE_HOME: ctx.home, DROVE_RUN: ctx.run.id, DROVE_ROLE: role, DROVE_SEAT: seat, DROVE_TOKEN: ctx.tokens[seat] ?? '', DROVE_CHANNEL: '', ...extraEnv },
  })
  const seen: Message[] = []
  const waiters: (() => void)[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    seen.push(JSON.parse(line) as Message)
    waiters.splice(0).forEach((wake) => wake())
  })
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  const raw = (text: string) => child.stdin.write(`${text}\n`)
  const send = (message: Record<string, unknown>) => raw(JSON.stringify({ jsonrpc: '2.0', ...message }))
  const next = async (match: (message: Message) => boolean): Promise<Message> => {
    for (;;) {
      const found = seen.find(match)
      if (found) return found
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
  const reply = (id: number) => next((message) => message.id === id && message.method === undefined)
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
  const end = async () => {
    child.stdin.end()
    return closed
  }
  return { send, raw, next, reply, end, seen }
}

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }

test('worker session: initialize, tools/list, tools/call report appends a stamped outbox line', async () => {
  const ctx = await setup()
  const session = launch(ctx, 'worker', 'w-api')
  session.send({ id: 1, method: 'initialize', params: INIT })
  session.send({ method: 'notifications/initialized' })
  session.send({ id: 2, method: 'tools/list' })
  session.send({ id: 3, method: 'tools/call', params: { name: 'report', arguments: { kind: 'done', summary: 'built it', details: 'tests pass' } } })
  session.send({ id: 4, method: 'tools/call', params: { name: 'report', arguments: { kind: 'nope', summary: 'x' } } })
  session.send({ id: 5, method: 'tools/call', params: { name: 'ghost', arguments: {} } })
  session.send({ id: 6, method: 'ping' })
  session.send({ id: 7, method: 'resources/list' })
  assert.equal(await session.end(), 0)

  assert.equal((await session.reply(1)).result?.serverInfo.name, 'drove')
  assert.equal((await session.reply(1)).result?.protocolVersion, '2025-06-18')
  assert.deepEqual((await session.reply(2)).result?.tools.map((tool: { name: string }) => tool.name), ['report'])
  const ok = await session.reply(3)
  assert.equal(ok.result?.isError, undefined)
  assert.match(ok.result?.content[0].text, /recorded \(done, expects review\)/)
  assert.equal((await session.reply(4)).result?.isError, true)
  assert.equal((await session.reply(5)).error?.code, -32602)
  assert.deepEqual((await session.reply(6)).result, {})
  assert.equal((await session.reply(7)).error?.code, -32601)
  assert.equal(session.seen.filter((message) => message.id === undefined).length, 0, 'notifications get no reply')

  const lines = (await readJsonlFrom<Report>(join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'outbox.jsonl'), { offset: 0 })).items
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.token, 'token-w-api')
  assert.equal(lines[0]?.summary, 'built it')
})

test('worker session: a malformed line gets a parse error and the server keeps going', async () => {
  const ctx = await setup()
  const session = launch(ctx, 'worker', 'w-api')
  session.raw('{not json')
  session.send({ id: 1, method: 'ping' })
  assert.equal(await session.end(), 0)
  const broken = await session.next((message) => message.error?.code === -32700)
  assert.equal(broken.id, null)
  assert.deepEqual((await session.reply(1)).result, {})
})

test('planner session: tools/list, a call, and a pending report riding on the tool result', async () => {
  const ctx = await setup({ seats: ['w-api'] })
  const report = stampReport({ kind: 'question', summary: 'which database?' }, { id: 'r-w-api-1-abcd', run: ctx.run.id, seat: 'w-api', token: 'token-w-api', at: '2026-10-09T10:00:00.000Z' })
  await appendJsonl(join(ctx.home, 'runs', ctx.run.id, 'planner', 'pending.jsonl'), { t: 'add', report })
  const session = launch(ctx, 'planner', 'planner')
  session.send({ id: 1, method: 'initialize', params: INIT })
  session.send({ id: 2, method: 'tools/list' })
  session.send({ id: 3, method: 'tools/call', params: { name: 'roster', arguments: {} } })
  const first = (await session.reply(3)).result?.content[0].text as string
  session.send({ id: 4, method: 'tools/call', params: { name: 'roster', arguments: {} } })
  assert.equal(await session.end(), 0)

  const names = (await session.reply(2)).result?.tools.map((tool: { name: string }) => tool.name)
  assert.ok(['spawn', 'send', 'verdict', 'roster', 'close'].every((name) => names.includes(name)))
  assert.ok(!names.includes('report'))
  assert.match(first, /^roster ok/)
  assert.match(first, /which database\?/)
  assert.equal((await session.reply(4)).result?.content[0].text, 'roster ok')
})

test('planner session: a report that landed in an outbox between ticks rides on the next tool result, exactly once', async () => {
  const ctx = await setup({ seats: ['w-api'] })
  const session = launch(ctx, 'planner', 'planner')
  session.send({ id: 1, method: 'initialize', params: INIT })
  session.send({ id: 2, method: 'tools/call', params: { name: 'roster', arguments: {} } })
  assert.equal((await session.reply(2)).result?.content[0].text, 'roster ok')
  const report = stampReport({ kind: 'done', summary: 'built the parser' }, { id: 'r-w-api-2-abcd', run: ctx.run.id, seat: 'w-api', token: 'token-w-api', at: '2026-10-09T10:00:00.000Z' })
  await appendJsonl(join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'outbox.jsonl'), report)
  session.send({ id: 3, method: 'tools/call', params: { name: 'roster', arguments: {} } })
  const riding = (await session.reply(3)).result?.content[0].text as string
  session.send({ id: 4, method: 'tools/call', params: { name: 'roster', arguments: {} } })
  assert.equal(await session.end(), 0)
  assert.match(riding, /built the parser/)
  assert.equal((await session.reply(4)).result?.content[0].text, 'roster ok')
})

test('planner session: the channel capability is declared only when DROVE_CHANNEL=1', async () => {
  const ctx = await setup()
  const plain = launch(ctx, 'planner', 'planner')
  plain.send({ id: 1, method: 'initialize', params: INIT })
  assert.equal(await plain.end(), 0)
  assert.equal((await plain.reply(1)).result?.capabilities.experimental, undefined)

  const channel = launch(ctx, 'planner', 'planner', { DROVE_CHANNEL: '1' })
  channel.send({ id: 1, method: 'initialize', params: INIT })
  assert.equal(await channel.end(), 0)
  const result = (await channel.reply(1)).result
  assert.deepEqual(result?.capabilities.experimental, { 'claude/channel': {} })
  assert.match(result?.instructions, /<channel source="drove">/)
})

test('planner session: spawn over budget elicits the human and spawns after accept', async () => {
  const ctx = await setup()
  await updateRoster(ctx.home, ctx.run.id, (roster) => ({ ...roster, seats: ['a', 'b', 'c', 'd', 'e'].map((name) => seatOf(`w-${name}`)) }))
  const session = launch(ctx, 'planner', 'planner')
  session.send({ id: 1, method: 'initialize', params: { ...INIT, capabilities: { elicitation: {} } } })
  session.send({ id: 2, method: 'tools/call', params: { name: 'spawn', arguments: { seat: 'w-six', kind: 'claude', brief: 'go' } } })
  const ask = await session.next((message) => message.method === 'elicitation/create')
  assert.match(ask.params?.message, /budget of 5/)
  session.send({ id: ask.id, result: { action: 'accept', content: { approve: true } } })
  const done = await session.reply(2)
  assert.equal(done.result?.isError, undefined)
  assert.match(done.result?.content[0].text, /^spawn ok/)
  assert.equal(await session.end(), 0)
})

test('planner session: without the elicitation capability spawn is not blocked on the client', async () => {
  const ctx = await setup()
  await updateRoster(ctx.home, ctx.run.id, (roster) => ({ ...roster, seats: ['a', 'b', 'c', 'd', 'e'].map((name) => seatOf(`w-${name}`)) }))
  const session = launch(ctx, 'planner', 'planner')
  session.send({ id: 1, method: 'initialize', params: INIT })
  session.send({ id: 2, method: 'tools/call', params: { name: 'spawn', arguments: { seat: 'w-six', kind: 'claude', brief: 'go' } } })
  assert.match((await session.reply(2)).result?.content[0].text, /^spawn ok/)
  assert.equal(await session.end(), 0)
  assert.equal(session.seen.some((message) => message.method === 'elicitation/create'), false)
})
