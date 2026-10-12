import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readLedger } from './checks.ts'
import { runDir, seatDir } from './paths.ts'
import { buildReport, duration } from './report.ts'
import { loadRoster, loadRun } from './roster.ts'
import { readJsonlFrom } from './store.ts'
import type { Deps, DroveEvent, Report } from './types.ts'

// OTLP/JSON uses hex ids, numeric enums and decimal strings for nanoseconds and int64 values.
type Value = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean }
type Attribute = { key: string; value: Value }
export type TraceSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Attribute[]
  events: { name: string; timeUnixNano: string; attributes: Attribute[] }[]
  status?: { code: number }
}
export type Trace = { resourceSpans: { resource: { attributes: Attribute[] }; scopeSpans: { scope: { name: string }; spans: TraceSpan[] }[] }[] }

const attributes = (data: Record<string, unknown>): Attribute[] => Object.entries(data).flatMap(([key, value]) => {
  if (value === undefined || value === null) return []
  const encoded: Value = typeof value === 'boolean' ? { boolValue: value }
    : typeof value === 'number' && Number.isFinite(value) ? Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
    : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) }
  return [{ key, value: encoded }]
})
const id = (run: string, key: string, length: number): string => createHash('sha256').update(`${run}\0${key}`).digest('hex').slice(0, length)
const nano = (ms: number): string => String(BigInt(Math.trunc(ms)) * 1_000_000n)
const ms = (at: string): number => Date.parse(at)
const lines = async <T>(path: string): Promise<T[]> => (await readJsonlFrom<T>(path, { offset: 0 }).catch(() => ({ items: [] as T[] }))).items

export const buildTrace = async (deps: Deps, runId: string, claudeDir: string): Promise<Trace | undefined> => {
  const run = await loadRun(deps.home, runId)
  if (!run) return undefined
  const [roster, recorded, ledger, report] = await Promise.all([
    loadRoster(deps.home, runId), lines<DroveEvent>(join(runDir(deps.home, runId), 'events.jsonl')),
    readLedger(deps.home, runId), buildReport(deps, runId, claudeDir),
  ])
  // Most historical events have no id; their append-only ledger position supplies a stable fallback.
  const events = recorded.map((event, index) => ({ ...event, key: event.id ?? `event-${index}` })).filter(event => Number.isFinite(ms(event.at))).sort((a, b) => ms(a.at) - ms(b.at))
  const start = ms(run.createdAt)
  const down = events.filter(event => event.type === 'run.down').at(-1)
  const end = Math.max(start, run.status === 'down' ? down ? ms(down.at) : ms(events.at(-1)?.at ?? run.createdAt) : deps.clock.now().getTime())
  const spans: TraceSpan[] = []
  const span = (key: string, name: string, from: number, to: number, parent: TraceSpan | undefined, data: Record<string, unknown> = {}): TraceSpan => {
    const made: TraceSpan = { traceId: id(runId, 'trace', 32), spanId: id(runId, key, 16), ...(parent ? { parentSpanId: parent.spanId } : {}), name, kind: 1, startTimeUnixNano: nano(from), endTimeUnixNano: nano(Math.max(from, to)), attributes: attributes(data), events: [] }
    spans.push(made)
    return made
  }
  const root = span('run', `run ${runId}`, start, end, undefined, { 'drove.run': runId, 'drove.repo': run.repo, 'drove.goal': run.goal, 'drove.cairn': run.cairn })
  const names = [...new Set([...roster.seats.map(seat => seat.name), ...events.filter(event => event.type === 'seat.spawn' && event.seat).map(event => event.seat as string)])]
  const parents = new Map<string, TraceSpan>()
  const attempts = new Map<string, TraceSpan[]>()
  for (const name of names) {
    const seat = roster.seats.find(seat => seat.name === name)
    const own = events.filter(event => event.seat === name)
    const spawn = own.find(event => event.type === 'seat.spawn')
    const close = own.filter(event => event.type === 'seat.close').at(-1)
    const from = spawn ? ms(spawn.at) : ms(seat?.spawnedAt ?? run.createdAt)
    const to = close ? ms(close.at) : end
    const usage = report?.seats.find(row => row.seat === name)
    const seatSpan = span(`seat:${name}`, `seat ${name}`, from, to, root, {
      'drove.seat': name, 'drove.kind': seat?.kind ?? spawn?.data?.kind, 'gen_ai.request.model': seat?.model ?? spawn?.data?.model,
      'drove.effort': seat?.effort ?? spawn?.data?.effort, 'drove.role': seat?.role ?? 'implementer', 'drove.cairn': seat?.cairn ?? spawn?.data?.cairn,
      'gen_ai.usage.input_tokens': usage?.tokens?.input, 'gen_ai.usage.output_tokens': usage?.tokens?.output,
      'gen_ai.usage.cache_read.input_tokens': usage?.tokens?.cacheRead,
      'gen_ai.usage.cache_creation.input_tokens': usage?.tokens ? usage.tokens.cacheWrite5m + usage.tokens.cacheWrite1h : undefined,
      'drove.usage.cache_write_5m_tokens': usage?.tokens?.cacheWrite5m, 'drove.usage.cache_write_1h_tokens': usage?.tokens?.cacheWrite1h, 'drove.cost_usd': usage?.cost,
    })
    parents.set(name, seatSpan)
    const outbox = await lines<Report>(join(seatDir(deps.home, runId, name), 'outbox.jsonl'))
    const cycles: TraceSpan[] = []
    let active: TraceSpan | undefined
    const begin = (key: string, at: number, verdict?: unknown) => {
      if (active) active.endTimeUnixNano = nano(Math.max(Number(BigInt(active.startTimeUnixNano) / 1_000_000n), at))
      active = span(`attempt:${key}`, `attempt ${cycles.length + 1}`, at, to, seatSpan, { 'drove.verdict': verdict })
      cycles.push(active)
    }
    for (const event of own) {
      if (event.type === 'control.sent' && (event.data?.kind === 'brief' || (event.data?.kind === 'verdict' && event.data?.verdict === 'changes'))) begin(event.key, ms(event.at), event.data?.verdict)
      // Older runs can have a spawn without a recorded brief. Infer its first cycle once.
      if (event.type === 'report' && event.data?.kind === 'done') {
        if (!cycles.length) begin(spawn?.key ?? `seat:${name}`, from)
        if (active) {
          active.endTimeUnixNano = nano(Math.max(ms(event.at), Number(BigInt(active.startTimeUnixNano) / 1_000_000n)))
          const criteria = event.data?.criteria ?? outbox.find(item => item.id === event.id)?.criteria
          if (Array.isArray(criteria)) active.attributes.push(...attributes({ 'drove.criteria.met': criteria.filter(item => item?.met === true).map(item => item.id), 'drove.criteria.unmet': criteria.filter(item => item?.met === false).map(item => item.id) }))
          active = undefined
        }
      }
    }
    if (!cycles.length && spawn) begin(spawn.key, from)
    attempts.set(name, cycles)
  }
  const atAttempt = (seat: string, at: number): TraceSpan | undefined => attempts.get(seat)?.findLast(item => BigInt(item.startTimeUnixNano) <= BigInt(nano(at)) && BigInt(item.endTimeUnixNano) >= BigInt(nano(at)))
  ledger.forEach((check, index) => {
    const to = ms(check.at)
    if (!Number.isFinite(to)) return
    const durationMs = Number.isFinite(check.durationMs) ? Math.max(0, check.durationMs) : 0
    const from = to - durationMs
    const made = span(`check:${index}`, `check ${check.command}`, from, to, atAttempt(check.seat, from) ?? parents.get(check.seat) ?? root, {
      'drove.command': check.command, 'drove.exit': check.exit, 'drove.sha': check.sha, 'drove.clean': check.clean, 'drove.duration_ms': durationMs,
    })
    made.status = { code: check.exit === 0 ? 1 : 2 }
  })
  for (const event of events) {
    const at = ms(event.at)
    if (event.type.startsWith('merge.')) {
      const data = event.data ?? {}
      // A merge has only a settlement event today, so its recorded duration is zero.
      const made = span(`merge:${event.key}`, `merge ${event.type.slice(6)}`, at, at, parents.get(event.seat ?? '') ?? root, { 'drove.outcome': event.type.slice(6), 'drove.code': data.code, 'drove.pr_url': data.url ?? data.prUrl })
      made.status = { code: event.type === 'merge.refused' ? 2 : event.type === 'merge.passed' ? 1 : 0 }
    } else if (['guard.denied', 'guard.deny', 'steer.nudged', 'attention'].includes(event.type)) {
      const parent = atAttempt(event.seat ?? '', at) ?? parents.get(event.seat ?? '') ?? root
      parent.events.push({ name: event.type, timeUnixNano: nano(at), attributes: attributes(event.data ?? {}) })
    }
  }
  return { resourceSpans: [{ resource: { attributes: attributes({ 'service.name': 'drove' }) }, scopeSpans: [{ scope: { name: 'drove' }, spans }] }] }
}

export const renderTrace = (trace: Trace): string => {
  const spans = trace.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
  const visit = (parent: string | undefined, depth: number): string[] => spans.filter(span => span.parentSpanId === parent).flatMap(span => {
    const elapsed = Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n)
    const details = span.attributes.map(attr => `${attr.key}=${Object.values(attr.value)[0]}`).join(' ')
    return [`${'  '.repeat(depth)}${span.name} (${duration(elapsed)})${details ? ` ${details}` : ''}`, ...visit(span.spanId, depth + 1)]
  })
  return visit(undefined, 0).join('\n')
}

export const postTrace = async (trace: Trace, endpoint: string, timeoutMs = 10_000): Promise<void> => {
  const url = new URL(endpoint)
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/v1\/traces$/, '')}/v1/traces`
  const headers = new Headers()
  for (const entry of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')) {
    const equal = entry.indexOf('=')
    if (equal > 0) headers.set(entry.slice(0, equal).trim(), decodeURIComponent(entry.slice(equal + 1).trim()))
  }
  headers.set('content-type', 'application/json')
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(trace), signal: AbortSignal.timeout(timeoutMs) })
  await response.body?.cancel()
  if (!response.ok) throw new Error(`OTLP export failed: HTTP ${response.status} ${response.statusText}`)
}
