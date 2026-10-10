import { join } from 'node:path'
import { EFFORTS, loadConfig } from './commands.ts'
import { recordEvent } from './deliver.ts'
import * as git from './git.ts'
import { newRunId, plannerDir, runDir, seatDir } from './paths.ts'
import { latestRunFor, loadRoster, loadRun, saveRun, updateRoster } from './roster.ts'
import { readJson, readJsonlFrom, withLock, writeJsonAtomic } from './store.ts'
import { workerTools } from './tools.ts'
import { createWatcher } from './watch.ts'
import type { CommandResult, Deps, DroveEvent, Effort, Identity, Roster, RunMeta } from './types.ts'

// The Claude orchestrator mod runs in Claude Code's plugin runtime, which has no Node, so it reaches Drove
// through these entry points (`drove mod attach|bridge|report`) instead of importing src/mod.ts.

export type AttachRequest = { repo: string; sessionId: string; paneId?: string; goal?: string; model?: string; effort?: Effort; budget?: number; run?: string }

export type ModStatus = { at?: string; ctx?: number; asking?: string; activity?: string }

export type BridgeLine =
  | { t: 'ready'; run: string; pid: number }
  | { t: 'busy'; pid: number; sessionId?: string }
  | { t: 'fatal'; code: string; text: string }
  | { t: 'run'; run: RunMeta }
  | { t: 'roster'; roster: Roster; status: Record<string, ModStatus> }
  | { t: 'events'; events: DroveEvent[]; isInitial: boolean }
  | { t: 'wake'; text: string }
  | { t: 'error'; step: string; message: string }

export type BridgeLock = { pid: number; sessionId: string; startedAt: string }

export type BridgeIo = {
  write: (line: BridgeLine) => boolean
  pid: number
  ppid: () => number
  isAlive: (pid: number) => boolean
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  sleep: (ms: number) => Promise<void>
}

export type BridgeOptions = { sessionId: string; loopMs?: number; tailEvents?: number; takeoverMs?: number; watch?: typeof createWatcher }

export const BRIDGE_LOOP_MS = 1_000
export const BRIDGE_TAIL_EVENTS = 60
export const TAKEOVER_MS = 3_000
export const EXIT = { ok: 0, fatal: 2, busy: 3, detached: 4 } as const

const ok = (text: string, data?: unknown): CommandResult => ({ ok: true, text, ...(data === undefined ? {} : { data }) })
const failed = (code: string, text: string): CommandResult => ({ ok: false, code, text })
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const lockFile = (home: string, run: string) => join(plannerDir(home, run), 'bridge.json')
const lockDir = (home: string, run: string) => join(plannerDir(home, run), 'bridge.lock')

// ---------- attach ----------

export const attach = async (deps: Deps, request: AttachRequest): Promise<CommandResult> => {
  const paneId = request.paneId || process.env.HERDR_PANE_ID
  if (!paneId) return failed('not-in-herdr', 'this session is not in a herdr pane (HERDR_PANE_ID is unset), so it cannot open worker panes')
  if (!request.sessionId) return failed('usage', '--session is required')
  if (request.effort && !EFFORTS.includes(request.effort)) return failed('usage', `--effort must be one of ${EFFORTS.join(', ')}`)
  if (request.budget !== undefined && (!Number.isInteger(request.budget) || request.budget < 1)) return failed('usage', '--budget must be a whole number of at least 1')
  const repo = await git.toplevel(deps.exec, request.repo)
  if (!repo) return failed('not-a-repo', `${request.repo} is not inside a git repository`)
  const config = await loadConfig(deps.home)
  const model = request.model ?? config.plannerModel.claude
  const effort = request.effort ?? config.plannerEffort
  const planner = { kind: 'claude' as const, paneId, sessionId: request.sessionId, model, effort, viaMod: true }

  let existing: RunMeta | undefined
  if (request.run) {
    existing = await loadRun(deps.home, request.run)
    if (!existing) return failed('no-run', `no run named ${request.run}`)
    if (existing.status !== 'up') return failed('run-down', `run ${existing.id} is down`)
  } else {
    const latest = await latestRunFor(deps.home, repo, 'up')
    existing = latest?.planner.viaMod && latest.planner.sessionId === request.sessionId ? latest : undefined
  }

  let run: RunMeta
  if (existing) {
    run = { ...existing, goal: request.goal ?? existing.goal, ...(request.budget ? { budget: request.budget } : {}), planner }
  } else {
    const base = await git.baseRef(deps.exec, repo).catch(() => undefined)
    if (!base) return failed('no-base', `no main or master branch found in ${repo}`)
    const now = deps.clock.now()
    run = {
      v: 1,
      id: newRunId(repo, now),
      repo,
      base,
      hasRemote: await git.hasRemote(deps.exec, repo),
      createdAt: now.toISOString(),
      status: 'up',
      ...(request.goal ? { goal: request.goal } : {}),
      budget: request.budget ?? config.budget,
      planner,
    }
  }
  await saveRun(deps.home, run)
  await updateRoster(deps.home, run.id, roster => roster)
  await recordEvent(deps, run.id, { type: 'run.up', data: { planner: 'claude', pane: paneId, viaMod: true, attached: Boolean(existing) } })
  return ok(`Run ${run.id} is up with this session as its planner${existing ? ' (re-attached)' : ''}.`, { run })
}

// ---------- report (the worker's mcp__orchestrator__report alias) ----------

export const report = async (deps: Deps, identity: Identity | undefined, args: unknown): Promise<CommandResult> => {
  if (!identity || identity.role !== 'worker') return failed('forbidden', 'only a Drove worker can report (DROVE_ROLE=worker is not set)')
  const [tool] = workerTools(deps, identity)
  if (!tool) return failed('internal', 'the report tool is missing')
  const result = await tool.call(typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {})
  return result.isError ? failed('report', result.text) : ok(result.text)
}

// ---------- bridge ----------

type Acquired = { ok: true } | { ok: false; holder: BridgeLock }

// One bridge per run. A live bridge of the same planner session is a leftover of a hot reload of the mod, so
// it is replaced; a live bridge of another session is left alone and this one stands down.
export const acquireBridge = async (deps: Deps, run: string, mine: BridgeLock, io: BridgeIo, takeoverMs = TAKEOVER_MS): Promise<Acquired> =>
  withLock(lockDir(deps.home, run), async () => {
    const holder = await readJson<BridgeLock>(lockFile(deps.home, run)).catch(() => undefined)
    // A released lock holds pid 0, and kill(0) signals this whole process group, Claude Code included.
    if (holder && holder.pid > 0 && holder.pid !== mine.pid && io.isAlive(holder.pid)) {
      if (holder.sessionId !== mine.sessionId) return { ok: false, holder }
      io.kill(holder.pid, 'SIGTERM')
      for (let waited = 0; io.isAlive(holder.pid) && waited < takeoverMs; waited += 100) await io.sleep(100)
      if (io.isAlive(holder.pid)) io.kill(holder.pid, 'SIGKILL')
    }
    await writeJsonAtomic(lockFile(deps.home, run), mine)
    return { ok: true }
  })

export const releaseBridge = async (deps: Deps, run: string, pid: number): Promise<void> => {
  await withLock(lockDir(deps.home, run), async () => {
    const holder = await readJson<BridgeLock>(lockFile(deps.home, run)).catch(() => undefined)
    if (holder?.pid === pid) await writeJsonAtomic(lockFile(deps.home, run), { ...holder, pid: 0 })
  }).catch(() => undefined)
}

const holdsBridge = async (deps: Deps, run: string, pid: number): Promise<boolean> =>
  (await readJson<BridgeLock>(lockFile(deps.home, run)).catch(() => undefined))?.pid === pid

const statusOf = async (deps: Deps, run: string, roster: Roster): Promise<Record<string, ModStatus>> => {
  const entries = await Promise.all(
    roster.seats.map(async seat => [seat.name, await readJson<ModStatus>(join(seatDir(deps.home, run, seat.name), 'mod.json')).catch(() => undefined)] as const),
  )
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, ModStatus] => entry[1] !== undefined))
}

const withoutStamp = (roster: Roster): string => JSON.stringify(roster.seats)

export const runBridge = async (deps: Deps, runId: string, options: BridgeOptions, io: BridgeIo, signal: AbortSignal): Promise<number> => {
  const initial = await loadRun(deps.home, runId)
  if (!initial) {
    io.write({ t: 'fatal', code: 'no-run', text: `no run named ${runId}` })
    return EXIT.fatal
  }
  if (!initial.planner.viaMod || initial.planner.sessionId !== options.sessionId) {
    io.write({ t: 'fatal', code: 'not-attached', text: `run ${runId} is not attached to session ${options.sessionId}; run drove mod attach first` })
    return EXIT.fatal
  }
  const acquired = await acquireBridge(deps, runId, { pid: io.pid, sessionId: options.sessionId, startedAt: deps.clock.now().toISOString() }, io, options.takeoverMs)
  if (!acquired.ok) {
    io.write({ t: 'busy', pid: acquired.holder.pid, sessionId: acquired.holder.sessionId })
    return EXIT.busy
  }

  const parent = io.ppid()
  let isBroken = false
  const write = (line: BridgeLine): boolean => {
    if (isBroken) return false
    if (!io.write(line)) isBroken = true
    return !isBroken
  }
  write({ t: 'ready', run: runId, pid: io.pid })

  const eventsPath = join(runDir(deps.home, runId), 'events.jsonl')
  const all = await readJsonlFrom<DroveEvent>(eventsPath, { offset: 0 }).catch(() => ({ items: [] as DroveEvent[], cursor: { offset: 0 } }))
  let cursor = all.cursor
  write({ t: 'events', events: all.items.slice(-(options.tailEvents ?? BRIDGE_TAIL_EVENTS)), isInitial: true })

  const watcher = (options.watch ?? createWatcher)(deps, initial, {
    modWake: async text => write({ t: 'wake', text }),
    onError: (error, step) => void write({ t: 'error', step, message: messageOf(error) }),
    loop: true,
  })

  let lastRun = ''
  let lastRoster = ''
  let lastStatus = ''
  let code: number = EXIT.ok
  try {
    while (!signal.aborted && !isBroken) {
      if (io.ppid() !== parent) break
      if (!(await holdsBridge(deps, runId, io.pid))) break
      const run = await loadRun(deps.home, runId)
      if (!run || run.status !== 'up' || !run.planner.viaMod || run.planner.sessionId !== options.sessionId) {
        code = EXIT.detached
        if (run) write({ t: 'run', run })
        break
      }
      const runText = JSON.stringify(run)
      if (runText !== lastRun) {
        lastRun = runText
        write({ t: 'run', run })
      }
      const roster = await loadRoster(deps.home, runId)
      const status = await statusOf(deps, runId, roster)
      const rosterText = withoutStamp(roster)
      const statusText = JSON.stringify(status)
      if (rosterText !== lastRoster || statusText !== lastStatus) {
        lastRoster = rosterText
        lastStatus = statusText
        write({ t: 'roster', roster, status })
      }
      const fresh = await readJsonlFrom<DroveEvent>(eventsPath, cursor).catch(() => ({ items: [] as DroveEvent[], cursor }))
      cursor = fresh.cursor
      if (fresh.items.length > 0) write({ t: 'events', events: fresh.items, isInitial: false })
      await io.sleep(options.loopMs ?? BRIDGE_LOOP_MS)
    }
  } finally {
    watcher.stop()
    await releaseBridge(deps, runId, io.pid)
  }
  return code
}
