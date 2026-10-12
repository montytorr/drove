import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../src/cli.ts'
import * as commands from '../src/commands.ts'
import { runDir, seatDir } from '../src/paths.ts'
import { claudeTranscriptPath } from '../src/report.ts'
import { saveRun } from '../src/roster.ts'
import { buildTrace, postTrace, renderTrace, type Trace, type TraceSpan } from '../src/trace.ts'
import { FakeHerdr, makeDeps, makeSeat, seedRun, tmp } from './p3-helpers.ts'

const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 9, minute)).toISOString()
const jsonl = (items: unknown[]) => `${items.map(item => JSON.stringify(item)).join('\n')}\n`
const spansOf = (trace: Trace) => trace.resourceSpans[0]!.scopeSpans[0]!.spans
const attr = (span: TraceSpan, key: string) => span.attributes.find(item => item.key === key)?.value
const fixture = async () => {
  const deps = { ...await makeDeps(new FakeHerdr()), claudeUserDir: await tmp('trace-claude') }
  const seats = [makeSeat('w-a', { state: 'closed', sessionId: 's-a', cairn: 'DROVE-130' }), makeSeat('w-b', { state: 'closed', kind: 'codex' })]
  const run = await seedRun(deps, await tmp('trace-repo'), seats, { status: 'down' })
  const event = (minute: number, type: string, seat?: string, data?: object, id?: string) => ({ at: at(minute), type, seat, data, id })
  await writeFile(join(runDir(deps.home, run.id), 'events.jsonl'), jsonl([
    event(10, 'seat.spawn', 'w-a'), event(10, 'control.sent', 'w-a', { kind: 'brief' }, 'brief-a'),
    event(11, 'seat.spawn', 'w-b'), event(11, 'control.sent', 'w-b', { kind: 'brief' }, 'brief-b'),
    event(15, 'guard.denied', 'w-a', { rule: 'push' }), event(16, 'steer.nudged', 'w-a', { rule: 'idle' }),
    event(17, 'attention', 'w-b', { reason: 'dialog' }),
    event(20, 'report', 'w-a', { kind: 'done' }, 'done-a1'),
    event(22, 'control.sent', 'w-a', { kind: 'verdict', verdict: 'changes' }, 'changes-a'),
    event(26, 'report', 'w-a', { kind: 'done' }, 'done-a2'),
    event(27, 'report', 'w-b', { kind: 'done' }, 'done-b'),
    event(28, 'merge.passed', 'w-a', { url: 'https://example.com/pr/1' }),
    event(29, 'seat.close', 'w-a'), event(29, 'seat.close', 'w-b'), event(30, 'run.down'),
  ]))
  await writeFile(join(seatDir(deps.home, run.id, 'w-a'), 'outbox.jsonl'), jsonl([{ id: 'done-a2', criteria: [{ id: 'AC1', met: true }, { id: 'AC2', met: false }] }]))
  await writeFile(join(runDir(deps.home, run.id), 'checks.jsonl'), jsonl([{ seat: 'w-a', at: at(25), durationMs: 1000, command: 'npm test', sha: 'abc123', clean: true, exit: 0, cwd: '/repo', tail: '' }]))
  const transcript = claudeTranscriptPath(deps.claudeUserDir, seats[0]!.worktree, 's-a')
  await mkdir(join(transcript, '..'), { recursive: true })
  await writeFile(transcript, jsonl([{ type: 'assistant', timestamp: at(15), message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } } }]))
  return { deps, run }
}

const collector = async (status = 200) => {
  const received: { url?: string; method?: string; contentType?: string; authorization?: string; body: Trace }[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    received.push({ url: req.url, method: req.method, contentType: req.headers['content-type'], authorization: req.headers.authorization, body: JSON.parse(body) })
    res.writeHead(status).end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { received, endpoint: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

test('trace CLI exports an OTLP span tree with stable ids, usage, criteria, checks and merges', async () => {
  const { deps, run } = await fixture()
  const oldHome = process.env.DROVE_HOME
  process.env.DROVE_HOME = deps.home
  try {
    const output: string[] = []
    const errors: string[] = []
    assert.equal(await main(['trace', run.id, '--json'], { out: text => output.push(text), err: text => errors.push(text), stdin: async () => '' }), 0, errors.join('\n'))
    const trace = JSON.parse(output[0]!) as Trace
    assert.deepEqual(trace.resourceSpans[0]!.resource.attributes, [{ key: 'service.name', value: { stringValue: 'drove' } }])
    const spans = spansOf(trace)
    const root = spans[0]!
    assert.equal(root.parentSpanId, undefined)
    assert.equal(root.startTimeUnixNano, String(BigInt(Date.parse(run.createdAt)) * 1_000_000n))
    assert.equal(root.endTimeUnixNano, String(BigInt(Date.parse(at(30))) * 1_000_000n))
    assert.equal(spans.filter(span => span.parentSpanId === root.spanId).length, 2)
    const seat = spans.find(span => span.name === 'seat w-a')!
    const attempts = spans.filter(span => span.parentSpanId === seat.spanId && span.name.startsWith('attempt'))
    assert.equal(attempts.length, 2)
    assert.deepEqual(attr(attempts[1]!, 'drove.verdict'), { stringValue: 'changes' })
    assert.deepEqual(attr(attempts[1]!, 'drove.criteria.met'), { stringValue: '["AC1"]' })
    assert.deepEqual(attr(attempts[1]!, 'drove.criteria.unmet'), { stringValue: '["AC2"]' })
    assert.equal(spans.find(span => span.name.startsWith('check'))!.parentSpanId, attempts[1]!.spanId)
    const merge = spans.find(span => span.name.startsWith('merge'))!
    assert.equal(merge.parentSpanId, seat.spanId)
    assert.deepEqual(attr(merge, 'drove.outcome'), { stringValue: 'passed' })
    assert.deepEqual(attr(merge, 'drove.pr_url'), { stringValue: 'https://example.com/pr/1' })
    assert.equal(spans.flatMap(span => span.events).length, 3)
    for (const span of spans) {
      assert.match(span.traceId, /^[a-f0-9]{32}$/)
      assert.match(span.spanId, /^[a-f0-9]{16}$/)
      assert.match(span.startTimeUnixNano, /^\d+$/)
      assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano))
      assert.equal(span.kind, 1)
    }
    assert.equal(new Set(spans.map(span => span.spanId)).size, spans.length)
    const built = await buildTrace(deps, run.id, deps.claudeUserDir)
    assert.ok(built)
    assert.deepEqual(spans.map(span => [span.traceId, span.spanId]), spansOf(built).map(span => [span.traceId, span.spanId]))
    assert.deepEqual(attr(spansOf(built).find(span => span.name === seat.name)!, 'gen_ai.usage.input_tokens'), { intValue: '10' })
    assert.deepEqual(attr(spansOf(built).find(span => span.name === seat.name)!, 'gen_ai.usage.cache_read.input_tokens'), { intValue: '30' })
    assert.ok(attr(spansOf(built).find(span => span.name === seat.name)!, 'drove.cost_usd'))
    assert.match(renderTrace(built), /\n  seat w-a.*\n    attempt 1/)
  } finally {
    if (oldHome === undefined) delete process.env.DROVE_HOME
    else process.env.DROVE_HOME = oldHome
  }
})

test('OTLP posts one JSON body with headers to /v1/traces and CLI errors name HTTP status', async () => {
  const { deps, run } = await fixture()
  const trace = await buildTrace(deps, run.id, deps.claudeUserDir)
  assert.ok(trace)
  const success = await collector()
  const failure = await collector(503)
  const oldHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS
  const oldHome = process.env.DROVE_HOME
  try {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer%20test'
    process.env.DROVE_HOME = deps.home
    const exported: string[] = []
    assert.equal(await main(['trace', run.id, '--json', '--otlp', success.endpoint], { out: text => exported.push(text), err: text => assert.fail(text), stdin: async () => '' }), 0)
    assert.equal(success.received.length, 1)
    assert.deepEqual(success.received[0], { url: '/v1/traces', method: 'POST', contentType: 'application/json', authorization: 'Bearer test', body: JSON.parse(exported[0]!) })
    const errors: string[] = []
    const output: string[] = []
    assert.equal(await main(['trace', run.id, '--otlp', failure.endpoint], { out: text => output.push(text), err: text => errors.push(text), stdin: async () => '' }), 1)
    assert.match(errors.join('\n'), /HTTP 503/)
    assert.equal(output.length, 0)
    assert.equal(failure.received.length, 1)
  } finally {
    if (oldHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = oldHeaders
    if (oldHome === undefined) delete process.env.DROVE_HOME
    else process.env.DROVE_HOME = oldHome
    await success.close()
    await failure.close()
  }
})

test('down exports the persisted run when configured; collector failure does not fail down', async () => {
  for (const status of [200, 503]) {
    const { deps, run } = await fixture()
    const server = await collector(status)
    try {
      await saveRun(deps.home, { ...run, status: 'up' })
      await writeFile(join(deps.home, 'config.json'), JSON.stringify({ otlpEndpoint: server.endpoint }))
      const result = await commands.down(deps, { run: run.id, repo: run.repo })
      assert.equal(result.ok, true, result.text)
      assert.equal(server.received.length, 1)
      assert.equal(server.received[0]!.url, '/v1/traces')
      const spans = spansOf(server.received[0]!.body)
      assert.equal(spans[0]!.endTimeUnixNano, String(BigInt(deps.clock.now().getTime()) * 1_000_000n))
    } finally {
      await server.close()
    }
  }
})

test('running traces end at now and missing runs fail cleanly', async () => {
  const { deps, run } = await fixture()
  await saveRun(deps.home, { ...run, status: 'up' })
  const trace = await buildTrace(deps, run.id, deps.claudeUserDir)
  assert.ok(trace)
  assert.equal(spansOf(trace)[0]!.endTimeUnixNano, String(BigInt(deps.clock.now().getTime()) * 1_000_000n))
  assert.equal((await commands.runTrace(deps, { run: 'missing', repo: run.repo }, {})).ok, false)
})


test('OTLP export times out when a collector never answers', async () => {
  const { deps, run } = await fixture()
  const trace = await buildTrace(deps, run.id, deps.claudeUserDir)
  assert.ok(trace)
  const server = createServer(() => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await assert.rejects(postTrace(trace, `http://127.0.0.1:${address.port}`, 30), /TimeoutError/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
