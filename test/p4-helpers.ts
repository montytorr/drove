import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seatDir } from '../src/paths.ts'
import { newReportId, stampReport } from '../src/protocol.ts'
import { loadRoster, saveRun, updateRoster } from '../src/roster.ts'
import { appendJsonl, readJsonlFrom, writeToken } from '../src/store.ts'
import { defaultWatchPorts } from '../src/watch.ts'
import type { WatchPorts } from '../src/watch.ts'
import type { Control, Deps, ExecResult, HerdrAgent, PlannerMeta, Report, ReportKind, RunMeta, Seat } from '../src/types.ts'

export const makeClock = (start = '2026-10-09T10:00:00.000Z') => {
  let ms = Date.parse(start)
  return { now: () => new Date(ms), advance: (by: number) => void (ms += by) }
}

export const makeExec = (respond: (argv: readonly string[]) => Partial<ExecResult> = () => ({})) => {
  const calls: string[][] = []
  const exec = async (argv: readonly string[]): Promise<ExecResult> => {
    calls.push([...argv])
    return { code: 0, stdout: '', stderr: '', ...respond(argv) }
  }
  return { calls, exec }
}

export const seatOf = (name: string, overrides: Partial<Seat> = {}): Seat => ({
  name,
  kind: 'codex',
  model: 'gpt-5',
  effort: 'high',
  worktree: `/tmp/repo/.claude/worktrees/${name}`,
  branch: `drove/${name}`,
  state: 'working',
  stateAt: '2026-10-09T09:59:00.000Z',
  spawnedAt: '2026-10-09T09:59:00.000Z',
  owes: 'none',
  attention: [],
  paneId: `p-${name}`,
  ...overrides,
})

export const setup = async (options: { planner?: Partial<PlannerMeta>; seats?: string[]; respond?: (argv: readonly string[]) => Partial<ExecResult> } = {}) => {
  const home = await mkdtemp(join(tmpdir(), 'drove-p4-'))
  const clock = makeClock()
  const { calls, exec } = makeExec(options.respond)
  const run: RunMeta = {
    v: 1,
    id: 'drove-test',
    repo: '/tmp/repo',
    base: 'main',
    hasRemote: false,
    createdAt: '2026-10-09T09:00:00.000Z',
    status: 'up',
    budget: 5,
    planner: { kind: 'codex', sessionId: 'thread-1', paneId: 'p-planner', model: 'gpt-5', effort: 'high', viaMod: false, ...options.planner },
  }
  await saveRun(home, run)
  const names = options.seats ?? ['w-api']
  await updateRoster(home, run.id, (roster) => ({ ...roster, seats: names.map((name) => seatOf(name)) }))
  const tokens: Record<string, string> = {}
  for (const name of names) {
    tokens[name] = `token-${name}`
    await writeToken(join(seatDir(home, run.id, name), 'token'), tokens[name])
  }
  const deps: Deps = { exec, clock, home }
  return { home, clock, calls, run, deps, tokens }
}

export type Ctx = Awaited<ReturnType<typeof setup>>

export const fileReport = async (ctx: Ctx, seat: string, kind: ReportKind, summary: string, extra: { token?: string; expects?: Report['expects'] } = {}): Promise<Report> => {
  const at = ctx.clock.now()
  const report = stampReport(
    { kind, summary, ...(extra.expects ? { expects: extra.expects } : {}) },
    { id: newReportId(seat, at.getTime()), run: ctx.run.id, seat, token: extra.token ?? ctx.tokens[seat] ?? 'none', at: at.toISOString() },
  )
  await appendJsonl(join(seatDir(ctx.home, ctx.run.id, seat), 'outbox.jsonl'), report)
  return report
}

export const eventsOf = async (ctx: Ctx) =>
  (await readJsonlFrom<{ type: string; seat?: string; id?: string; data?: Record<string, unknown> }>(join(ctx.home, 'runs', ctx.run.id, 'events.jsonl'), { offset: 0 })).items

export const rosterOf = (ctx: Ctx) => loadRoster(ctx.home, ctx.run.id)

export const fakePorts = (overrides: Partial<WatchPorts> & { agents?: () => HerdrAgent[] } = {}) => {
  const controls: Control[] = []
  const flushed: string[] = []
  const titles: string[] = []
  const { agents, ...rest } = overrides
  const ports: WatchPorts = {
    ...defaultWatchPorts,
    listAgents: async () => ({ ok: true, value: agents?.() ?? [] }),
    deriveState: (seat, signals) => ({ state: signals.herdr?.status === 'working' ? 'working' : seat.state, attention: [] }),
    needsNudge: () => false,
    codexQueueArgv: (thread, text) => ['codex', 'queue', '--thread', thread, '--message', text],
    agentPromptArgv: (target, text) => ['herdr', 'agent', 'prompt', target, text],
    agentReadArgv: (target, lines, source) => ['herdr', 'agent', 'read', target, '--source', source ?? 'recent-unwrapped', '--lines', String(lines)],
    deliverControl: async (_deps, _run, control) => {
      controls.push(control)
      return { ok: true, via: 'herdr-prompt' }
    },
    flushPending: async (_deps, _run, seat) => {
      flushed.push(seat)
      return []
    },
    nudgeText: () => 'nudge',
    paneTty: async () => '/dev/ttys-planner',
    writeTty: (_path, data) => void titles.push(data),
    ...rest,
  }
  return { ports, controls, flushed, titles }
}
