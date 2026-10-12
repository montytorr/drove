import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { findRollout } from './usage.ts'
import { codexHomeDir, runDir } from './paths.ts'
import { loadRoster, loadRun } from './roster.ts'
import type { AgentKind, Deps, DroveEvent, HookRecord, RunMeta, Seat } from './types.ts'

// DROVE-106: what a run cost and how much rework it took, from the agents' own transcripts, the run's events and its roster.

export type Usage = { input: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; output: number }

// USD per million tokens, from the Anthropic price list (2026-10-06). Cache writes are 1.25x (5 minute) and 2x (1 hour) the input price.
// Haiku 5.5's cache read price is not on that list: 0.1x its input, as for the other families. A model that is not here shows tokens only,
// which is the case for every Codex model.
export type Price = { input: number; output: number; cacheRead: number }
export const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
}

export const emptyUsage = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 })
const addUsage = (into: Usage, from: Usage): Usage => {
  into.input += from.input
  into.cacheRead += from.cacheRead
  into.cacheWrite5m += from.cacheWrite5m
  into.cacheWrite1h += from.cacheWrite1h
  into.output += from.output
  return into
}
export const totalTokens = (usage: Usage): number => usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h + usage.output

// A model id may carry a date suffix or a context marker ("claude-opus-5-5-20261001", "claude-opus-5-5[1m]").
export const priceOf = (model: string): Price | undefined => PRICES[model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')]

export const costOf = (model: string, usage: Usage): number | undefined => {
  const price = priceOf(model)
  if (!price) return undefined
  const million = 1_000_000
  return (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite5m * price.input * 1.25 + usage.cacheWrite1h * price.input * 2) / million
}

export type ModelUsage = { model: string; usage: Usage; cost?: number }
// DROVE-122: check runs (one per checks.ran event) and how many of them failed.
export type CheckCounts = { runs: number; failures: number }
export type Rework = { changes: number; approvals: number; promotions: number; demotions: number; migrations: number; restarts: number }
export type SeatReport = {
  seat: string
  kind: AgentKind
  model: string
  cairn?: string
  state: string
  spawns: number
  wallMs: number
  humanMs: number
  rework: Rework
  checks: CheckCounts
  // Guard refusals the seat met (`guard.denied` events), in all and by rule (DROVE-121).
  denials: number
  denialsByRule: Record<string, number>
  // Steering the seat got from Drove (`steer.nudged` events), in all and by rule (DROVE-127).
  nudges: number
  nudgesByRule: Record<string, number>
  tokens?: Usage & { total: number }
  cost?: number
  unpriced: string[]
  models: ModelUsage[]
  transcripts: number
  notFound: string[]
}
export type RunReport = {
  run: string
  repo: string
  status: RunMeta['status']
  goal?: string
  cairn?: string
  startedAt: string
  at: string
  elapsedMs: number
  seats: SeatReport[]
  totals: { seats: number; wallMs: number; humanMs: number; rework: Rework; checks: CheckCounts; denials: number; denialsByRule: Record<string, number>; nudges: number; nudgesByRule: Record<string, number>; tokens: Usage & { total: number }; cost?: number; unpriced: string[]; notFound: string[] }
}

const emptyRework = (): Rework => ({ changes: 0, approvals: 0, promotions: 0, demotions: 0, migrations: 0, restarts: 0 })

// ---------- transcripts ----------

type Line = { type?: string; timestamp?: string; payload?: Record<string, unknown> & { type?: string; model?: string; info?: { total_token_usage?: Record<string, unknown> } }; message?: { id?: string; model?: string; usage?: Record<string, unknown> } }

const whole = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

const readLines = async (path: string): Promise<Line[] | undefined> => {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const lines: Line[] = []
  for (const row of text.split('\n')) {
    if (!row.trim()) continue
    try {
      lines.push(JSON.parse(row) as Line)
    } catch {
      // a line cut by a crash or still being written
    }
  }
  return lines
}

const within = (line: Line, from: number, to: number): boolean => {
  const at = line.timestamp ? Date.parse(line.timestamp) : Number.NaN
  return Number.isNaN(at) || (at >= from && at <= to)
}

// Claude repeats a message's usage on each of its content blocks, so a message counts once (its last line wins).
export const claudeUsageByModel = (lines: readonly Line[], from = 0, to = Number.POSITIVE_INFINITY): Map<string, Usage> => {
  const byMessage = new Map<string, { model: string; usage: Usage }>()
  let anonymous = 0
  for (const line of lines) {
    const usage = line.type === 'assistant' ? line.message?.usage : undefined
    const model = line.message?.model
    if (!usage || !model || model.startsWith('<') || !within(line, from, to)) continue
    const creation = (usage.cache_creation ?? {}) as Record<string, unknown>
    const write5m = whole(creation.ephemeral_5m_input_tokens)
    const write1h = whole(creation.ephemeral_1h_input_tokens)
    const written = whole(usage.cache_creation_input_tokens)
    byMessage.set(line.message?.id ?? `anonymous-${anonymous++}`, {
      model,
      usage: { input: whole(usage.input_tokens), cacheRead: whole(usage.cache_read_input_tokens), cacheWrite5m: write5m + write1h > 0 ? write5m : written, cacheWrite1h: write5m + write1h > 0 ? write1h : 0, output: whole(usage.output_tokens) },
    })
  }
  const models = new Map<string, Usage>()
  for (const { model, usage } of byMessage.values()) addUsage(models.get(model) ?? models.set(model, emptyUsage()).get(model) as Usage, usage)
  return models
}

// A Codex rollout keeps a running total in each token_count event; the last one is the session's. Its input count includes the cached part.
export const codexUsageByModel = (lines: readonly Line[]): Map<string, Usage> => {
  let model = ''
  let total: Record<string, unknown> | undefined
  for (const line of lines) {
    if (line.type === 'turn_context' && typeof line.payload?.model === 'string') model = line.payload.model
    if (line.type === 'event_msg' && line.payload?.type === 'token_count' && line.payload.info?.total_token_usage) total = line.payload.info.total_token_usage
  }
  if (!total) return new Map()
  const cached = whole(total.cached_input_tokens)
  const written = whole(total.cache_write_input_tokens)
  return new Map([[model || 'codex', { input: Math.max(0, whole(total.input_tokens) - cached - written), cacheRead: cached, cacheWrite5m: written, cacheWrite1h: 0, output: whole(total.output_tokens) }]])
}

// Claude Code keeps a session at <config dir>/projects/<working directory with "/" and "." as "-">/<session id>.jsonl.
export const claudeTranscriptPath = (claudeDir: string, cwd: string, sessionId: string): string => join(claudeDir, 'projects', cwd.replace(/[/.]/g, '-'), `${sessionId}.jsonl`)

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

type Found = { usage: Map<string, Usage>; found: number; notFound: string[] }

const seatTokens = async (deps: Deps, run: RunMeta, seat: Pick<Seat, 'kind' | 'name' | 'sessionId' | 'worktree' | 'codexHome'>, hooks: readonly HookRecord[], window: [number, number], claudeDir: string): Promise<Found> => {
  const usage = new Map<string, Usage>()
  const notFound: string[] = []
  let found = 0
  const merge = (from: Map<string, Usage>) => {
    for (const [model, value] of from) addUsage(usage.get(model) ?? usage.set(model, emptyUsage()).get(model) as Usage, value)
  }
  const sessions = new Set<string>()
  if (seat.sessionId) sessions.add(seat.sessionId)
  for (const hook of hooks) if (hook.sessionId && hook.agent === seat.kind) sessions.add(hook.sessionId)
  if (seat.kind === 'claude') {
    const paths = new Map<string, string>()
    for (const hook of hooks) if (hook.agent === 'claude' && hook.transcript && hook.sessionId) paths.set(hook.sessionId, hook.transcript)
    for (const session of sessions) {
      const candidates = [paths.get(session), claudeTranscriptPath(claudeDir, seat.worktree, session)].filter((path): path is string => Boolean(path))
      const path = (await Promise.all(candidates.map(async candidate => ((await exists(candidate)) ? candidate : undefined)))).find(Boolean)
      const lines = path ? await readLines(path) : undefined
      if (!lines) {
        notFound.push(`${session} (looked for ${candidates[0] ?? session})`)
        continue
      }
      found += 1
      merge(claudeUsageByModel(lines, window[0], window[1]))
    }
    if (sessions.size === 0) notFound.push('no session id')
    return { usage, found, notFound }
  }
  const codexHome = seat.codexHome ?? codexHomeDir(deps.home, run.id)
  for (const session of sessions) {
    const path = await findRollout(codexHome, session)
    const lines = path ? await readLines(path) : undefined
    if (!lines) {
      notFound.push(`${session} (no rollout under ${join(codexHome, 'sessions')})`)
      continue
    }
    found += 1
    merge(codexUsageByModel(lines))
  }
  if (sessions.size === 0) notFound.push('no session id')
  return { usage, found, notFound }
}

// ---------- events ----------

// Attention reasons that wait on the human; the others (idle, stalled, budget, gone, pending delivery) are the planner's to resolve.
const HUMAN_REASONS = new Set(['dialog', 'permission', 'trust', 'hook-trust', 'channel-confirm', 'codex-version-mismatch', 'usage-limit'])
const SETTLING = new Set(['working', 'idle', 'done', 'closed', 'closing', 'gone', 'down'])

type Interval = [number, number]
const unionMs = (intervals: Interval[]): number => {
  const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0])
  let total = 0
  let reach = Number.NEGATIVE_INFINITY
  for (const [start, end] of sorted) {
    if (end > reach) {
      total += end - Math.max(start, reach)
      reach = end
    }
  }
  return total
}

const stampOf = (event: DroveEvent): number => Date.parse(event.at)

// A seat name can be spawned again after it closed (or after the run came down and up), so wall time is the sum of its spawn-to-close stretches.
const stretches = (events: readonly DroveEvent[], end: number): Interval[] => {
  const result: Interval[] = []
  let open: number | undefined
  for (const event of events) {
    const at = stampOf(event)
    if (event.type === 'seat.spawn' && open === undefined) open = at
    else if ((event.type === 'seat.close' || event.type === 'run.down') && open !== undefined) {
      result.push([open, at])
      open = undefined
    }
  }
  if (open !== undefined) result.push([open, end])
  return result
}

const humanWait = (events: readonly DroveEvent[], stretch: readonly Interval[], end: number): number => {
  const waits: Interval[] = []
  events.forEach((event, index) => {
    if (event.type !== 'attention' || !HUMAN_REASONS.has(String(event.data?.reason))) return
    const start = stampOf(event)
    const closing = events.slice(index + 1).find(next => next.type === 'seat.close' || next.type === 'run.down' || next.type === 'control.sent' || (next.type === 'seat.state' && SETTLING.has(String(next.data?.to))))
    const limit = stretch.find(([from, to]) => start >= from && start <= to)?.[1] ?? end
    waits.push([start, Math.min(closing ? stampOf(closing) : end, limit)])
  })
  return unionMs(waits)
}

// The verdict is in the event since DROVE-106; before that a verdict is read from what came next: a done report that expects a review means changes.
const verdictOf = (event: DroveEvent, later: readonly DroveEvent[]): 'approve' | 'changes' | undefined => {
  const given = event.data?.verdict
  if (given === 'approve' || given === 'changes') return given
  const next = later.find(item => item.type === 'report' || item.type === 'seat.spawn' || item.type === 'seat.close')
  if (next?.type === 'report' && next.data?.kind === 'done') return next.data?.expects === 'review' ? 'changes' : 'approve'
  return undefined
}

const reworkOf = (events: readonly DroveEvent[]): Rework => {
  const rework = emptyRework()
  events.forEach((event, index) => {
    if (event.type === 'seat.migrate') rework.migrations += 1
    else if (event.type === 'seat.relaunch') rework.restarts += 1
    else if (event.type === 'control.sent' && event.data?.kind === 'promote') rework.promotions += 1
    else if (event.type === 'control.sent' && event.data?.kind === 'demote') rework.demotions += 1
    else if (event.type === 'control.sent' && event.data?.kind === 'verdict') {
      const verdict = verdictOf(event, events.slice(index + 1))
      if (verdict === 'changes') rework.changes += 1
      else if (verdict === 'approve') rework.approvals += 1
    }
  })
  return rework
}

// `guard.deny` is what runs before DROVE-121 wrote; it carries no rule.
const GUARD_DENIALS = new Set(['guard.denied', 'guard.deny'])

const denialsOf = (events: readonly DroveEvent[]): { denials: number; denialsByRule: Record<string, number> } => {
  const denialsByRule: Record<string, number> = {}
  let denials = 0
  for (const event of events) {
    if (!GUARD_DENIALS.has(event.type)) continue
    const rule = typeof event.data?.rule === 'string' ? event.data.rule : 'unknown'
    denialsByRule[rule] = (denialsByRule[rule] ?? 0) + 1
    denials += 1
  }
  return { denials, denialsByRule }
}

const nudgesOf = (events: readonly DroveEvent[]): { nudges: number; nudgesByRule: Record<string, number> } => {
  const nudgesByRule: Record<string, number> = {}
  let nudges = 0
  for (const event of events) {
    if (event.type !== 'steer.nudged') continue
    const rule = typeof event.data?.rule === 'string' ? event.data.rule : 'unknown'
    nudgesByRule[rule] = (nudgesByRule[rule] ?? 0) + 1
    nudges += 1
  }
  return { nudges, nudgesByRule }
}

const checksOf = (events: readonly DroveEvent[]): CheckCounts => {
  const ran = events.filter(event => event.type === 'checks.ran')
  return { runs: ran.length, failures: ran.filter(event => event.data?.passed === false).length }
}

const readEvents = async (path: string): Promise<DroveEvent[]> => {
  const lines = await readLines(path)
  return ((lines ?? []) as unknown as DroveEvent[]).filter(event => typeof event?.at === 'string' && typeof event.type === 'string')
}

const readHooks = async (path: string): Promise<HookRecord[]> => ((await readLines(path)) ?? []) as unknown as HookRecord[]

// ---------- report ----------

const sumRework = (items: readonly Rework[]): Rework =>
  items.reduce((all, one) => ({ changes: all.changes + one.changes, approvals: all.approvals + one.approvals, promotions: all.promotions + one.promotions, demotions: all.demotions + one.demotions, migrations: all.migrations + one.migrations, restarts: all.restarts + one.restarts }), emptyRework())

const priced = (usage: Map<string, Usage>): { models: ModelUsage[]; cost?: number; unpriced: string[] } => {
  const models: ModelUsage[] = [...usage].map(([model, one]) => ({ model, usage: one, cost: costOf(model, one) }))
  const known = models.filter(item => item.cost !== undefined)
  return { models, cost: known.length ? known.reduce((sum, item) => sum + (item.cost as number), 0) : undefined, unpriced: models.filter(item => item.cost === undefined).map(item => item.model) }
}

// The same transcript accounting and prices as the report, for the watcher's seat budget check.
export const seatCost = async (deps: Deps, run: RunMeta, seat: Seat, claudeDir: string): Promise<number | undefined> => {
  const hooks = await readHooks(join(runDir(deps.home, run.id), 'seats', seat.name, 'hooks.jsonl'))
  const costs: number[] = []
  for (const kind of new Set([seat.kind, ...hooks.map(hook => hook.agent)])) {
    const own = hooks.filter(hook => hook.agent === kind)
    const found = await seatTokens(deps, run, { ...seat, kind, sessionId: kind === seat.kind ? seat.sessionId : undefined }, own, [Date.parse(run.createdAt), deps.clock.now().getTime()], claudeDir)
    const cost = priced(found.usage).cost
    if (cost !== undefined) costs.push(cost)
  }
  return costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : undefined
}

export const buildReport = async (deps: Deps, runId: string, claudeDir: string): Promise<RunReport | undefined> => {
  const run = await loadRun(deps.home, runId)
  if (!run) return undefined
  const roster = await loadRoster(deps.home, run.id)
  const events = await readEvents(join(runDir(deps.home, run.id), 'events.jsonl'))
  const now = deps.clock.now().getTime()
  const last = events.length ? stampOf(events[events.length - 1] as DroveEvent) : now
  const end = run.status === 'up' ? now : Math.max(last, Date.parse(run.createdAt))
  const start = Date.parse(run.createdAt)
  const rows: SeatReport[] = []

  const names = [...new Set([...roster.seats.map(seat => seat.name), ...events.filter(event => event.seat && event.type === 'seat.spawn').map(event => event.seat as string)])]
  for (const name of names) {
    const seat = roster.seats.find(item => item.name === name)
    const own = events.filter(event => event.seat === name)
    const spawn = own.find(event => event.type === 'seat.spawn')
    const kind = seat?.kind ?? ((spawn?.data?.kind as AgentKind | undefined) ?? 'claude')
    const stretch = stretches(own, end)
    const hooks = await readHooks(join(runDir(deps.home, run.id), 'seats', name, 'hooks.jsonl'))
    const tokens = await seatTokens(deps, run, { kind, name, sessionId: seat?.sessionId, worktree: seat?.worktree ?? String(spawn?.data?.worktree ?? ''), codexHome: seat?.codexHome }, hooks, [start, end], claudeDir)
    const cost = priced(tokens.usage)
    const sum = [...tokens.usage.values()].reduce((all, one) => addUsage(all, one), emptyUsage())
    rows.push({
      seat: name,
      kind,
      model: seat?.model ?? String(spawn?.data?.model ?? ''),
      ...(seat?.cairn ?? spawn?.data?.cairn ? { cairn: String(seat?.cairn ?? spawn?.data?.cairn) } : {}),
      state: seat?.state ?? 'unknown',
      spawns: own.filter(event => event.type === 'seat.spawn').length,
      wallMs: unionMs(stretch),
      humanMs: humanWait(own, stretch, end),
      rework: reworkOf(own),
      checks: checksOf(own),
      ...denialsOf(own),
      ...nudgesOf(own),
      ...(tokens.usage.size ? { tokens: { ...sum, total: totalTokens(sum) } } : {}),
      ...(cost.cost === undefined ? {} : { cost: cost.cost }),
      unpriced: cost.unpriced,
      models: cost.models,
      transcripts: tokens.found,
      notFound: tokens.notFound,
    })
  }

  const planner = run.planner
  if (planner.sessionId) {
    const found = await seatTokens(deps, run, { kind: planner.kind, name: 'planner', sessionId: planner.sessionId, worktree: run.repo }, [], [start, end], claudeDir)
    const cost = priced(found.usage)
    const sum = [...found.usage.values()].reduce((all, one) => addUsage(all, one), emptyUsage())
    rows.unshift({
      seat: 'planner',
      kind: planner.kind,
      model: planner.model,
      state: run.status,
      spawns: 1,
      wallMs: Math.max(0, end - start),
      humanMs: 0,
      rework: emptyRework(),
      checks: { runs: 0, failures: 0 },
      ...denialsOf(events.filter(event => event.seat === 'planner')),
      nudges: 0,
      nudgesByRule: {},
      ...(found.usage.size ? { tokens: { ...sum, total: totalTokens(sum) } } : {}),
      ...(cost.cost === undefined ? {} : { cost: cost.cost }),
      unpriced: cost.unpriced,
      models: cost.models,
      transcripts: found.found,
      notFound: found.notFound,
    })
  }

  const all = rows.reduce((total, row) => addUsage(total, row.tokens ?? emptyUsage()), emptyUsage())
  const costs = rows.filter(row => row.cost !== undefined)
  const workers = rows.filter(row => row.seat !== 'planner')
  return {
    run: run.id,
    repo: run.repo,
    status: run.status,
    ...(run.goal ? { goal: run.goal } : {}),
    ...(run.cairn ? { cairn: run.cairn } : {}),
    startedAt: run.createdAt,
    at: new Date(end).toISOString(),
    elapsedMs: Math.max(0, end - start),
    seats: rows,
    totals: {
      seats: workers.length,
      wallMs: workers.reduce((sum, row) => sum + row.wallMs, 0),
      humanMs: workers.reduce((sum, row) => sum + row.humanMs, 0),
      rework: sumRework(rows.map(row => row.rework)),
      checks: { runs: workers.reduce((sum, row) => sum + row.checks.runs, 0), failures: workers.reduce((sum, row) => sum + row.checks.failures, 0) },
      // Every denial of the run, a planner's included, even when its row is missing (no session id) or its seat is gone.
      ...denialsOf(events),
      ...nudgesOf(events),
      tokens: { ...all, total: totalTokens(all) },
      ...(costs.length ? { cost: costs.reduce((sum, row) => sum + (row.cost as number), 0) } : {}),
      unpriced: [...new Set(rows.flatMap(row => row.unpriced))],
      notFound: rows.filter(row => row.notFound.length > 0).map(row => row.seat),
    },
  }
}

// ---------- rendering ----------

export const duration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return ms >= 1000 ? `${Math.round(ms / 1000)}s` : '0'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h${String(minutes % 60).padStart(2, '0')}` : `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`
}
export const compact = (count: number): string => (count >= 1e9 ? `${(count / 1e9).toFixed(2)}G` : count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : count >= 1e3 ? `${(count / 1e3).toFixed(1)}k` : String(count))
const dollars = (cost: number | undefined, partial: boolean): string => (cost === undefined ? '-' : `$${cost.toFixed(2)}${partial ? '+' : ''}`)
const reworkCell = (rework: Rework): string => `${rework.changes}/${rework.promotions}/${rework.demotions}/${rework.migrations}/${rework.restarts}`
const checksCell = (checks: CheckCounts): string => `${checks.runs}/${checks.failures}`

export const renderReport = (report: RunReport): string => {
  const header = ['seat', 'agent', 'model', 'wall', 'human', 'tokens', 'in/out', 'cost', 'deny', 'nudge', 'chg/pro/dem/mig/rst', 'chk run/fail']
  const rows = report.seats.map(row => [
    row.seat,
    row.kind,
    row.model || '-',
    duration(row.wallMs),
    duration(row.humanMs),
    row.tokens ? compact(row.tokens.total) : 'n/a',
    row.tokens ? `${compact(row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite5m + row.tokens.cacheWrite1h)}/${compact(row.tokens.output)}` : '-',
    dollars(row.cost, row.unpriced.length > 0),
    String(row.denials),
    String(row.nudges),
    reworkCell(row.rework),
    checksCell(row.checks),
  ])
  const t = report.totals
  rows.push([`total (${t.seats} seats)`, '', '', duration(t.wallMs), duration(t.humanMs), compact(t.tokens.total), `${compact(t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite5m + t.tokens.cacheWrite1h)}/${compact(t.tokens.output)}`, dollars(t.cost, t.unpriced.length > 0), String(t.denials), String(t.nudges), reworkCell(t.rework), checksCell(t.checks)])
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => (row[column] ?? '').length)))
  const line = (cells: string[]) => cells.map((cell, column) => (column >= 3 ? cell.padStart(widths[column] as number) : cell.padEnd(widths[column] as number))).join('  ').trimEnd()
  const out = [`run ${report.run} · ${report.status} · started ${report.startedAt} · ${duration(report.elapsedMs)} elapsed${report.cairn ? ` · ${report.cairn}` : ''}`, '', line(header), ...rows.map((row, index) => (index === rows.length - 1 ? `${'-'.repeat(widths.reduce((sum, width) => sum + width + 2, -2))}\n${line(row)}` : line(row)))]
  out.push('', `chk = check runs (drove checks, run_checks, the merge gate) and how many failed; reused evidence is not a run.`)
  out.push(`wall = spawn to close, summed over a seat's incarnations; human = time an attention item waited on the human (dialog, permission, trust, usage limit); cache reads and writes are in tokens.`)
  if (t.denials > 0) out.push(`deny = tool calls the guard refused; by rule: ${Object.entries(t.denialsByRule).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([rule, count]) => `${rule} ${count}`).join(', ')}.`)
  if (t.nudges > 0) out.push(`nudge = steering Drove gave a seat from its tool ledger (R1 the same command failed in a row, R2 a done report with no check after the last edit); by rule: ${Object.entries(t.nudgesByRule).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([rule, count]) => `${rule} ${count}`).join(', ')}.`)
  if (t.unpriced.length) out.push(`No price for ${t.unpriced.join(', ')}: those tokens are counted, their cost is not (a + after a cost marks it partial).`)
  const missing = report.seats.filter(row => row.notFound.length > 0)
  if (missing.length) out.push(`No transcript found for ${missing.map(row => `${row.seat} (${row.notFound.length})`).join(', ')}: their tokens are missing or partial.`)
  return out.join('\n')
}

// The short form for a Cairn note: totals first, then one line per seat.
export const noteLines = (report: RunReport): string[] => {
  const t = report.totals
  const tokens = (usage: Usage & { total: number }) => `${compact(usage.total)} tokens (${compact(usage.output)} out)`
  return [
    `Cost and rework: ${tokens(t.tokens)}, ${dollars(t.cost, t.unpriced.length > 0)}, ${duration(t.wallMs)} of seat time, ${duration(t.humanMs)} waiting on the human; ${t.rework.changes} change round(s), ${t.rework.promotions} promotion(s), ${t.rework.demotions} demotion(s), ${t.rework.migrations} migration(s), ${t.rework.restarts} restart(s)${t.denials > 0 ? `, ${t.denials} guard denial(s)` : ''}${t.nudges > 0 ? `, ${t.nudges} steering nudge(s)` : ''}.`,
    ...report.seats.map(row => `- ${row.seat} (${row.kind} ${row.model || '?'}): ${row.tokens ? tokens(row.tokens) : 'no transcript'}, ${dollars(row.cost, row.unpriced.length > 0)}, ${duration(row.wallMs)}, human ${duration(row.humanMs)}, chg/pro/dem/mig/rst ${reworkCell(row.rework)}, checks run/fail ${checksCell(row.checks)}${row.denials > 0 ? `, guard denials ${row.denials}` : ''}${row.nudges > 0 ? `, steering nudges ${row.nudges}` : ''}`),
    ...(t.unpriced.length ? [`No price for ${t.unpriced.join(', ')}: tokens only.`] : []),
    ...(t.notFound.length ? [`No transcript found for ${t.notFound.join(', ')}.`] : []),
  ]
}
