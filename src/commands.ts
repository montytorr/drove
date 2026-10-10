import { spawn as spawnProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyDerived, deriveState, EXIT_WAIT_MS, findDialog, matchDialog, shouldReadScreen } from './detect.ts'
import { BUSY_RETRY_MS, deliverControl, herdrPromptAdapter, isDeliverable, plannerSessionId, recordEvent } from './deliver.ts'
import * as git from './git.ts'
import * as herdr from './herdr.ts'
import { type CodexLaunchRequest, execArgv, isShellSafeArg, readCodexHome, redactSpec, specFor, writeLaunchFiles } from './launch.ts'
import { branchName, codexHomeDir, defaultHome, ENV, identityFromEnv, newRunId, PLANNER_SEAT, plannerDir, SEAT_RE, seatDir, userCodexHome, worktreePath } from './paths.ts'
import { approvedText, briefFooter, plannerRole, resumedText, workerRole } from './prompts.ts'
import { formatControl } from './protocol.ts'
import { attentionOf, findSeat, gridSlot, isOverBudget, latestRunFor, loadRoster, loadRun, openSeats, rosterLines, saveRun, updateRoster, upsertSeat } from './roster.ts'
import { appendJsonl, mintToken, readJson, readJsonlFrom, readToken, writeJsonAtomic, writeToken } from './store.ts'
import type {
  AgentKind, CommandResult, Control, Deps, DroveConfig, Effort, Exec, ExecResult, HerdrStatus, HookRecord, Identity, LaunchRequest, PromoteRequest, RunMeta, Seat, SendRequest, SpawnRequest, Transport,
} from './types.ts'

export type PlanRequest = { repo: string; kind: AgentKind; model?: string; effort?: Effort; goal?: string; run?: string }
export type RunRef = { run?: string; repo: string }
export type ProcessPlan = { argv: string[]; env: Record<string, string>; cwd: string }

export const DROVE_ENTRY = fileURLToPath(new URL('./cli.ts', import.meta.url))
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const timing = { pollMs: 500, exitWaitMs: EXIT_WAIT_MS, closeWaitMs: 3_000, lockWaitMs: 5_000, promptWaitMs: 4_000 }

const SESSIONLESS_PROMPT = 'Read the roster and wait for the human.'
const CAIRN_RE = /^[A-Z][A-Z0-9]*-\d+$/

export const DEFAULT_CONFIG: DroveConfig = {
  humanName: 'the human',
  plannerModel: { claude: 'claude-opus-5-5', codex: '' },
  plannerEffort: 'high',
  workerModel: { claude: 'claude-sonnet-5-5', codex: '' },
  workerEffort: 'medium',
  promotedModel: { claude: 'claude-opus-5-5', codex: '' },
  budget: 5,
  codexBypassHookTrust: false,
  codexWorkerSandbox: 'bypass',
  claudeChannel: false,
  briefVia: 'prompt',
}

export const nodeExec: Exec = (argv, options = {}) =>
  new Promise<ExecResult>(resolve => {
    const [command, ...args] = argv
    if (!command) return resolve({ code: 127, stdout: '', stderr: 'empty argv' })
    const child = spawnProcess(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let isDone = false
    const finish = (result: ExecResult) => {
      if (isDone) return
      isDone = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: 124, stdout, stderr: `${stderr}\ntimed out after ${options.timeoutMs}ms` })
    }, options.timeoutMs ?? 60_000)
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', error => finish({ code: 127, stdout, stderr: error.message }))
    child.on('close', code => finish({ code: code ?? 1, stdout, stderr }))
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })

export const defaultDeps = (env: NodeJS.ProcessEnv = process.env): Deps => ({ exec: nodeExec, clock: { now: () => new Date() }, home: defaultHome(env) })

export const identityOrPlanner = (env: NodeJS.ProcessEnv = process.env): Identity =>
  identityFromEnv(env) ?? { home: defaultHome(env), run: '', role: 'planner', seat: PLANNER_SEAT }

const ok = (text: string, data?: unknown): CommandResult => ({ ok: true, text, ...(data === undefined ? {} : { data }) })
const failed = (code: string, text: string): CommandResult => ({ ok: false, code, text })
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const clip = (text: string, max = 300): string => text.replace(/\s+/g, ' ').trim().slice(0, max)
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const loadConfig = async (home: string): Promise<DroveConfig> => {
  const file = (await readJson<Partial<DroveConfig>>(join(home, 'config.json')).catch(() => undefined)) ?? {}
  return {
    ...DEFAULT_CONFIG,
    ...file,
    plannerModel: { ...DEFAULT_CONFIG.plannerModel, ...file.plannerModel },
    workerModel: { ...DEFAULT_CONFIG.workerModel, ...file.workerModel },
    promotedModel: { ...DEFAULT_CONFIG.promotedModel, ...file.promotedModel },
  }
}

const resolveModel = (kind: AgentKind, value: string | undefined, config: DroveConfig): string => {
  const requested = value?.trim()
  if (!requested) return config.workerModel[kind]
  const alias = requested.toLowerCase()
  if (alias === 'opus') return config.promotedModel[kind]
  if (alias === 'sonnet') return config.workerModel[kind]
  return requested
}

const newControlId = (now: Date): string => `c-${now.getTime().toString(36)}-${randomBytes(2).toString('hex')}`

type Located = { run: RunMeta } | { error: CommandResult }

const locateRun = async (deps: Deps, ref: RunRef, status?: RunMeta['status']): Promise<Located> => {
  if (ref.run) {
    const run = await loadRun(deps.home, ref.run)
    return run ? { run } : { error: failed('no-run', `no run named ${ref.run}`) }
  }
  const repo = (await git.toplevel(deps.exec, ref.repo)) ?? ref.repo
  const run = (await latestRunFor(deps.home, repo, status)) ?? (status === undefined ? undefined : await latestRunFor(deps.home, repo))
  return run ? { run } : { error: failed('no-run', `no Drove run found for ${repo}; start one with \`drove plan\``) }
}

const locateFor = (deps: Deps, identity: Identity, status?: RunMeta['status']): Promise<Located> =>
  locateRun(deps, { run: identity.run || undefined, repo: process.cwd() }, status)

const requirePlanner = (identity: Identity): CommandResult | undefined =>
  identity.role === 'planner' ? undefined : failed('forbidden', 'only the planner (or the human) can run this command')

const workspaceOf = (run: RunMeta): string | undefined => run.planner.paneId?.split(':')[0] ?? process.env.HERDR_WORKSPACE_ID

const hooksOf = async (deps: Deps, run: string, seat: string): Promise<HookRecord[]> =>
  (await readJsonlFrom<HookRecord>(join(seatDir(deps.home, run, seat), 'hooks.jsonl'), { offset: 0 })).items.slice(-60)

const hookSessionId = async (deps: Deps, run: string, seat: string): Promise<string | undefined> =>
  (await hooksOf(deps, run, seat)).findLast(hook => hook.event === 'session-start' && hook.sessionId)?.sessionId

const settle = async (condition: () => Promise<boolean>, totalMs: number): Promise<boolean> => {
  for (let waited = 0; waited <= totalMs; waited += timing.pollMs) {
    if (await condition()) return true
    await sleep(timing.pollMs)
  }
  return false
}

const isGone = (deps: Deps, target: string) => async (): Promise<boolean> => {
  const live = await herdr.getAgent(deps.exec, target)
  return !live.ok && live.code !== 'unparseable'
}

const isPaneMissing = (failure: { code: string; output: string }): boolean => /not.?found|no such|unknown/i.test(`${failure.code} ${failure.output}`)

type Stopped = { stopped: boolean; paneClosed: boolean; detail?: string }

// Claude's /exit in a worktree session opens a keep-or-remove dialog that Drove must never answer, so a Claude
// seat is stopped by closing its pane: the transcript is written as it goes and resumes by session id.
const stopAgent = async (deps: Deps, seat: Seat, waitMs: number): Promise<Stopped> => {
  const target = seat.paneId
  if (!target) return { stopped: true, paneClosed: false }
  if (seat.kind === 'claude') {
    const closed = await herdr.run(deps.exec, herdr.paneCloseArgv(target))
    if (!closed.ok && !isPaneMissing(closed)) return { stopped: false, paneClosed: false, detail: clip(closed.output) }
    return { stopped: await settle(isGone(deps, target), waitMs), paneClosed: true }
  }
  await herdr.run(deps.exec, herdr.agentTypeArgv(target, '/quit'), 15_000)
  return { stopped: await settle(isGone(deps, target), waitMs), paneClosed: false }
}

// Claude locks its worktree with its pid and a killed pane leaves that lock behind. Only a Claude-shaped lock
// whose pid is dead is cleared; a live pid or a lock somebody else took stays.
const releaseStaleLock = async (deps: Deps, run: RunMeta, seat: Seat): Promise<string | undefined> => {
  const lock = await git.worktreeLock(deps.exec, run.repo, seat.worktree).catch(() => undefined)
  const pid = lock?.claudePid
  if (pid === undefined) return undefined
  const isDead = await settle(async () => !git.isPidAlive(pid), timing.lockWaitMs)
  if (!isDead) return `its worktree is locked by a running Claude (pid ${pid}), so the lock was left alone`
  await git.unlockWorktree(deps.exec, run.repo, seat.worktree).catch(() => undefined)
  return undefined
}

const launchRequest = (
  deps: Deps,
  parts: Pick<LaunchRequest, 'identity' | 'kind' | 'repo' | 'cwd' | 'model' | 'effort' | 'roleText'> & Partial<CodexLaunchRequest>,
  config: DroveConfig,
): CodexLaunchRequest => ({
  droveEntry: DROVE_ENTRY,
  bypassHookTrust: parts.kind === 'codex' && config.codexBypassHookTrust,
  bypassSandbox: config.codexWorkerSandbox !== 'workspace-write',
  ...parts,
})

// A Codex seat resumes with the CODEX_HOME it started with, because its session lives under that home's sessions/
// (DROVE-34). A seat with none recorded started before Drove owned one and keeps the inline launch line and ~/.codex.
const codexHomeOf = async (deps: Deps, seat: Seat): Promise<Pick<CodexLaunchRequest, 'codexHome'>> =>
  seat.kind === 'codex' && seat.codexHome ? { codexHome: await readCodexHome(seat.codexHome, deps.codexUserHome ?? userCodexHome(deps.home)) } : {}

const writeLaunchJson = async (deps: Deps, run: string, seat: string, spec: Parameters<typeof redactSpec>[0]): Promise<void> => {
  await writeJsonAtomic(join(seatDir(deps.home, run, seat), 'launch.json'), redactSpec(spec))
}

const START_FAILURE_LINES = 60

const captureStartFailure = async (deps: Deps, run: RunMeta, seat: string, paneId: string | undefined, failure: { code: string; output: string }): Promise<{ hint?: string; file: string }> => {
  const readBoth = async (source: herdr.ReadSource) => {
    const byAgent = await herdr.readScreen(deps.exec, herdr.agentName(run.id, seat), START_FAILURE_LINES, source)
    return byAgent.ok || !paneId ? byAgent : await herdr.readPane(deps.exec, paneId, START_FAILURE_LINES, source)
  }
  const section = (title: string, read: herdr.HerdrResult<string>): string => `== ${title} ==\n${read.ok ? read.value : `(could not read the pane: ${read.code})\n${read.output}`}`.trimEnd()
  const visible = await readBoth('visible')
  const recent = await readBoth('recent-unwrapped')
  const file = join(seatDir(deps.home, run.id, seat), 'start-failure.txt')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${section('visible screen', visible)}\n\n${section('recent output', recent)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  const dialog = [visible, recent].map(read => (read.ok ? findDialog(read.value) : undefined)).find(hit => hit !== undefined)
  await recordEvent(deps, run.id, { type: 'seat.start_failed', seat, data: { code: failure.code, ...(dialog ? { reason: dialog.reason } : {}), ...(paneId ? { pane: paneId } : {}), file } })
  return { ...(dialog ? { hint: dialog.hint } : {}), file }
}

const AGENT_SCREEN: Record<AgentKind, RegExp> = { claude: /Claude Code v\d/, codex: /OpenAI Codex/ }
const ADOPTABLE: ReadonlySet<HerdrStatus> = new Set<HerdrStatus>(['working', 'idle', 'done'])

type Adopted = { state: Seat['state']; sessionId?: string }

const stateOfHerdr = (status: HerdrStatus): Seat['state'] => (status === 'working' ? 'working' : status === 'done' ? 'done' : 'idle')

const adoptFailedStart = async (deps: Deps, seatName: string, kind: AgentKind, paneId: string): Promise<Adopted | undefined> => {
  const listed = await herdr.listAgents(deps.exec)
  const agent = listed.ok ? listed.value.find(entry => entry.paneId === paneId || entry.name === seatName) : undefined
  if (agent && (agent.kind === undefined || agent.kind === kind) && ADOPTABLE.has(agent.status)) {
    const screen = await herdr.readPane(deps.exec, paneId, 40, 'visible')
    if (screen.ok && findDialog(screen.value)) return undefined
    return { state: stateOfHerdr(agent.status), ...(agent.sessionId ? { sessionId: agent.sessionId } : {}) }
  }
  if (agent) return undefined
  const screen = await herdr.readPane(deps.exec, paneId, 40, 'visible')
  return screen.ok && !findDialog(screen.value) && AGENT_SCREEN[kind].test(screen.value) ? { state: 'starting' } : undefined
}

const resolveBriefVia = (config: DroveConfig, env: NodeJS.ProcessEnv = process.env): DroveConfig['briefVia'] => {
  const override = env.DROVE_BRIEF_VIA
  if (override === 'launch-arg') return 'launch-arg'
  if (override === 'prompt' || override === 'herdr-prompt') return 'prompt'
  return config.briefVia === 'launch-arg' ? 'launch-arg' : 'prompt'
}

const hintText = (captured: { hint?: string; file: string }): string => `${captured.hint ? ` Hint: ${captured.hint}.` : ''} Pane output saved to ${captured.file}.`

export const refreshRoster = async (deps: Deps, run: RunMeta): Promise<void> => {
  const listed = await herdr.listAgents(deps.exec)
  if (!listed.ok) return
  const now = deps.clock.now()
  const seats = openSeats(await loadRoster(deps.home, run.id))
  const derived = await Promise.all(
    seats.map(async seat => {
      const live = listed.value.find(agent => (seat.paneId ? agent.paneId === seat.paneId : agent.name === herdr.agentName(run.id, seat.name)))
      const hooks = await hooksOf(deps, run.id, seat.name)
      const screen = shouldReadScreen(live, hooks) ? await herdr.readScreen(deps.exec, herdr.agentTarget(run.id, seat), 40, 'visible') : undefined
      const sessionId = live?.sessionId ?? [...hooks].reverse().find(hook => hook.event === 'session-start' && hook.sessionId)?.sessionId
      return { seat, sessionId, derived: deriveState(seat, { herdr: live, hooks, ...(seat.lastReport ? { lastReport: seat.lastReport } : {}), ...(screen?.ok ? { screen: screen.value } : {}) }, now) }
    }),
  )
  await updateRoster(deps.home, run.id, roster => ({
    ...roster,
    seats: roster.seats.map(entry => {
      const hit = derived.find(item => item.seat.name === entry.name)
      if (!hit) return entry
      const next = applyDerived(entry, hit.derived, now)
      return hit.sessionId && !next.sessionId ? { ...next, sessionId: hit.sessionId } : next
    }),
  }))
}

// ---------- plan ----------

export const plan = async (deps: Deps, request: PlanRequest): Promise<CommandResult> => {
  const paneId = process.env.HERDR_PANE_ID
  if (!paneId) return failed('not-in-herdr', 'drove plan must run inside a herdr pane (HERDR_PANE_ID is unset)')
  const repo = await git.toplevel(deps.exec, request.repo)
  if (!repo) return failed('not-a-repo', `${request.repo} is not inside a git repository`)
  const config = await loadConfig(deps.home)
  const now = deps.clock.now()
  const kind = request.kind
  if (kind !== 'claude' && kind !== 'codex') return failed('usage', '--kind must be claude or codex')
  if (request.effort && !EFFORTS.includes(request.effort)) return failed('usage', `--effort must be one of ${EFFORTS.join(', ')}`)
  const model = request.model ?? config.plannerModel[kind]
  const effort = request.effort ?? config.plannerEffort
  const sessionId = kind === 'claude' ? randomUUID() : undefined

  let run: RunMeta
  if (request.run) {
    const existing = await loadRun(deps.home, request.run)
    if (!existing) return failed('no-run', `no run named ${request.run}`)
    run = { ...existing, goal: request.goal ?? existing.goal, planner: { ...existing.planner, kind, paneId, model, effort, ...(sessionId ? { sessionId } : { sessionId: undefined }) } }
  } else {
    const base = await git.baseRef(deps.exec, repo).catch(() => undefined)
    if (!base) return failed('no-base', `no main or master branch found in ${repo}`)
    run = {
      v: 1,
      id: newRunId(repo, now),
      repo,
      base,
      hasRemote: await git.hasRemote(deps.exec, repo),
      createdAt: now.toISOString(),
      status: 'up',
      ...(request.goal ? { goal: request.goal } : {}),
      budget: config.budget,
      planner: { kind, paneId, model, effort, viaMod: false, ...(sessionId ? { sessionId } : {}) },
    }
  }
  await saveRun(deps.home, run)
  await updateRoster(deps.home, run.id, roster => roster)
  await recordEvent(deps, run.id, { type: 'run.up', data: { planner: kind, pane: paneId, attached: Boolean(request.run) } })

  const identity: Identity = { home: deps.home, run: run.id, role: 'planner', seat: PLANNER_SEAT }
  const launch = launchRequest(
    deps,
    {
      identity, kind, repo, cwd: repo, model, effort,
      roleText: plannerRole(run, config, kind),
      initialPrompt: request.goal ?? (kind === 'codex' ? SESSIONLESS_PROMPT : undefined),
      channel: kind === 'claude' && config.claudeChannel,
      ...(sessionId ? { sessionId } : {}),
    },
    config,
  )
  const spec = specFor(launch)
  await writeLaunchFiles(spec)
  return ok(`Run ${run.id} is up; starting the ${kind} planner.`, { argv: execArgv(spec), env: spec.env, cwd: spec.cwd } satisfies ProcessPlan)
}

// ---------- spawn ----------

type Placement = { paneId: string; createdTab?: string }

// DROVE-23: powerlevel10k's instant prompt draws a finished-looking prompt while .zshrc is still loading and the tty
// is canonical, which is exactly when a long typed launch line gets cut at 1024 bytes. With it off, the prompt only
// appears once init is done and zle owns the tty, so the readiness gate can trust what it sees.
const PANE_ENV = { POWERLEVEL9K_INSTANT_PROMPT: 'off' }

const placePane = async (deps: Deps, run: RunMeta, placed: readonly Seat[], cwd: string, agentEnv: Record<string, string>): Promise<Placement | CommandResult> => {
  const env = { ...agentEnv, ...PANE_ENV }
  const slot = gridSlot(placed)
  const isTabAlive = run.tabId ? (await herdr.run(deps.exec, herdr.tabGetArgv(run.tabId), 10_000)).ok : false
  if (slot && isTabAlive) {
    const split = await herdr.run(deps.exec, herdr.paneSplitArgv(slot.anchor, slot.direction, cwd, env))
    const pane = split.ok ? herdr.parseNewPane(split.value) : undefined
    return pane ? { paneId: pane.paneId } : failed('herdr', `herdr could not split a worker pane: ${split.ok ? split.value : split.output}`.slice(0, 400))
  }
  if (isTabAlive && run.tabId) await herdr.run(deps.exec, herdr.tabCloseArgv(run.tabId))
  const workspace = workspaceOf(run)
  if (!workspace) return failed('not-in-herdr', 'the run has no planner pane and HERDR_WORKSPACE_ID is unset, so no workers tab can be opened')
  const made = await herdr.run(deps.exec, herdr.tabCreateArgv(workspace, cwd, `workers · ${basename(run.repo)}`, env))
  const pane = made.ok ? herdr.parseNewPane(made.value) : undefined
  if (!pane?.tabId) return failed('herdr', `herdr could not open the workers tab: ${made.ok ? made.value : made.output}`.slice(0, 400))
  await saveRun(deps.home, { ...run, tabId: pane.tabId })
  return { paneId: pane.paneId, createdTab: pane.tabId }
}

const isPlacement = (value: Placement | CommandResult): value is Placement => 'paneId' in value

const closeEmptyTab = async (deps: Deps, run: RunMeta, roster: { seats: readonly Seat[] }): Promise<void> => {
  const stillPlaced = roster.seats.some(seat => seat.paneId && !['closed', 'gone', 'down'].includes(seat.state))
  if (stillPlaced || !run.tabId) return
  await herdr.run(deps.exec, herdr.tabCloseArgv(run.tabId))
  await saveRun(deps.home, { ...run, tabId: undefined })
}

// herdr types the launch line into the pane's shell. Until zle owns the tty the kernel is in canonical mode and cuts
// the line at 1024 bytes (DROVE-23), so wait for a prompt that has stopped changing before typing.
const SHELL_PROMPT_END = /[%$#>❯➜»]$/

const awaitShellPrompt = async (deps: Deps, paneId: string): Promise<boolean> => {
  let previous: string | undefined
  for (let waited = 0; waited <= timing.promptWaitMs; waited += timing.pollMs) {
    const screen = await herdr.readPane(deps.exec, paneId, 5, 'visible')
    const text = screen.ok ? screen.value.trimEnd() : ''
    if (text && text === previous && SHELL_PROMPT_END.test(text)) return true
    previous = text
    await sleep(timing.pollMs)
  }
  return false
}

type StartAttempt = { started: herdr.HerdrResult<string>; adopted: Adopted | undefined; paneId: string; createdTab: string | undefined }

// Waits for the shell, starts the agent and, when it never shows up, resets the pane once and tries again.
const startWithRetry = async (
  deps: Deps,
  run: RunMeta,
  start: { seat: string; kind: AgentKind; argv: readonly string[]; paneId: string; createdTab?: string; place: () => Promise<Placement | CommandResult> },
): Promise<StartAttempt> => {
  const attempt = async (paneId: string): Promise<Pick<StartAttempt, 'started' | 'adopted'>> => {
    await awaitShellPrompt(deps, paneId)
    const name = herdr.agentName(run.id, start.seat)
    const started = await herdr.retryWhileBusy(deps.exec, herdr.agentStartArgv(name, start.kind, paneId, start.argv), BUSY_RETRY_MS)
    const adopted = !started.ok && started.code !== 'agent_not_ready' ? await adoptFailedStart(deps, name, start.kind, paneId) : undefined
    return { started, adopted }
  }
  const first = await attempt(start.paneId)
  const isLost = !first.started.ok && !first.adopted && first.started.code !== 'agent_not_ready'
  const result: StartAttempt = { ...first, paneId: start.paneId, createdTab: start.createdTab }
  if (!isLost) return result
  await recordEvent(deps, run.id, { type: 'seat.state', seat: start.seat, data: { startRetry: true, code: first.started.ok ? '' : first.started.code, pane: start.paneId } })
  await herdr.run(deps.exec, start.createdTab ? herdr.tabCloseArgv(start.createdTab) : herdr.paneCloseArgv(start.paneId))
  const placed = await start.place()
  if (!isPlacement(placed)) return result
  return { ...(await attempt(placed.paneId)), paneId: placed.paneId, createdTab: placed.createdTab }
}

class OverBudget extends Error {}
class SeatTaken extends Error {}

const keptWatcherFields = (recorded: Seat | undefined): Partial<Seat> => ({
  ...(recorded?.lastReport ? { lastReport: recorded.lastReport, owes: recorded.owes } : {}),
  ...(recorded?.hasNudged !== undefined ? { hasNudged: recorded.hasNudged } : {}),
})

// Runs on one repo share `.claude/worktrees/<seat>` and the seat's branch, so a seat that another run still holds
// open must not be spawned again under the same name: both workers would write into one worktree.
const heldByAnotherRun = async (deps: Deps, run: RunMeta, seat: Pick<Seat, 'name' | 'worktree' | 'branch'>): Promise<string | undefined> => {
  const names = await readdir(join(deps.home, 'runs')).catch(() => [] as string[])
  for (const name of names.filter(entry => entry !== run.id)) {
    const other = await loadRun(deps.home, name).catch(() => undefined)
    if (other?.repo !== run.repo) continue
    const held = openSeats(await loadRoster(deps.home, other.id)).find(entry => entry.worktree === seat.worktree || entry.branch === seat.branch)
    if (held) return `seat ${seat.name} would use worktree ${seat.worktree} and branch ${seat.branch}, which the open seat ${held.name} of run ${other.id} in this repo already holds; pick another seat name, or stop that seat first (drove close, or drove down --run ${other.id})`
  }
  return undefined
}

export const spawn = async (deps: Deps, identity: Identity, request: SpawnRequest): Promise<CommandResult> => {
  const denied = requirePlanner(identity)
  if (denied) return denied
  if (!SEAT_RE.test(request.seat) || request.seat === PLANNER_SEAT) return failed('usage', `seat names must match ${SEAT_RE} and not be "planner"; got "${request.seat}"`)
  if (request.kind !== 'claude' && request.kind !== 'codex') return failed('usage', '--kind must be claude or codex')
  if (request.cairn && !CAIRN_RE.test(request.cairn)) return failed('usage', `--cairn must look like DROVE-5; got "${request.cairn}"`)
  if (request.effort && !EFFORTS.includes(request.effort)) return failed('usage', `--effort must be one of ${EFFORTS.join(', ')}`)
  const brief = request.brief.trim()
  if (!brief) return failed('usage', 'a worker needs a brief')
  const located = await locateFor(deps, identity, 'up')
  if ('error' in located) return located.error
  const { run } = located
  if (run.status !== 'up') return failed('run-down', `run ${run.id} is down; start it with \`drove up\``)

  const config = await loadConfig(deps.home)
  const now = deps.clock.now()
  const iso = now.toISOString()
  const kind = request.kind
  const model = resolveModel(kind, request.model, config)
  const effort = request.effort ?? config.workerEffort
  const isClaude = kind === 'claude'
  const worktree = worktreePath(run.repo, request.seat)
  const branch = isClaude ? git.claudeBranchName(request.seat) : branchName(request.seat)
  const launchCwd = isClaude ? run.repo : worktree
  const sessionId = kind === 'claude' ? randomUUID() : undefined
  const seat: Seat = {
    name: request.seat, kind, ...(request.cairn ? { cairn: request.cairn } : {}), model, effort, worktree, branch,
    state: 'starting', stateAt: iso, spawnedAt: iso, owes: 'none', attention: [], ...(sessionId ? { sessionId } : {}),
    ...(isClaude ? {} : { codexHome: codexHomeDir(deps.home, run.id) }),
  }

  const clash = await heldByAnotherRun(deps, run, seat)
  if (clash) return failed('seat-taken', clash)

  try {
    await updateRoster(deps.home, run.id, roster => {
      const existing = findSeat(roster, seat.name)
      if (existing && !['closed', 'gone', 'down'].includes(existing.state)) throw new SeatTaken(`a seat named ${seat.name} is already open; pick another name or message it`)
      if (isOverBudget(roster, run.budget)) throw new OverBudget(`the pane budget of ${run.budget} is full; ask the human to run \`drove budget ${run.budget + 1}\``)
      return upsertSeat(roster, seat)
    })
  } catch (error) {
    if (error instanceof SeatTaken) return failed('seat-taken', error.message)
    if (error instanceof OverBudget) return failed('over-budget', error.message)
    throw error
  }

  let isWorktreeNew = false
  const rollback = async (paneId: string | undefined, createdTab: string | undefined): Promise<void> => {
    if (createdTab) {
      await herdr.run(deps.exec, herdr.tabCloseArgv(createdTab))
      await saveRun(deps.home, { ...run, tabId: undefined })
    } else if (paneId) await herdr.run(deps.exec, herdr.paneCloseArgv(paneId))
    await updateRoster(deps.home, run.id, roster => ({ ...roster, seats: roster.seats.filter(entry => entry.name !== seat.name) }))
    if (isWorktreeNew) {
      await git.removeWorktree(deps.exec, run.repo, worktree, isClaude).catch(() => undefined)
      await git.deleteBranch(deps.exec, run.repo, branch)
    }
  }

  const baseNotes: string[] = []
  try {
    if (isClaude) {
      isWorktreeNew = !existsSync(worktree)
      const base = await git.baseRef(deps.exec, run.repo, run.base)
      if (request.base) baseNotes.push(`--base ${request.base} was ignored: Claude creates its own worktree.`)
      if (!(await git.isHeadAt(deps.exec, run.repo, base))) baseNotes.push(`Claude branches ${branch} from the main checkout's current HEAD (${(await git.headBranch(deps.exec, run.repo)) ?? 'detached'}), which is not ${base}; rebase it if the base matters.`)
    } else if (!existsSync(worktree)) {
      await git.addWorktree(deps.exec, run.repo, worktree, branch, await git.baseRef(deps.exec, run.repo, request.base ?? run.base))
      isWorktreeNew = true
    }
  } catch (error) {
    await rollback(undefined, undefined)
    return failed('git', messageOf(error))
  }

  const token = mintToken()
  await writeToken(join(seatDir(deps.home, run.id, seat.name), 'token'), token)
  const workerIdentity: Identity = { home: deps.home, run: run.id, role: 'worker', seat: seat.name, token }
  const isBriefInline = isShellSafeArg(brief.trim())
  const footer = isBriefInline ? `${brief.trim()} ${briefFooter(seat.name, request.cairn).trimStart()}` : `${brief}${briefFooter(seat.name, request.cairn)}`
  const isRoleInBrief = kind === 'codex'
  const roleText = workerRole(seat, run, config)
  const briefText = isRoleInBrief ? `${roleText}\n\n${footer}` : footer
  const isViaPrompt = resolveBriefVia(config) === 'prompt' || !isShellSafeArg(briefText)
  const initialPrompt = isViaPrompt ? undefined : briefText
  const spec = specFor(
    launchRequest(deps, { identity: workerIdentity, kind, repo: run.repo, cwd: launchCwd, model, effort, roleText: isRoleInBrief ? '' : roleText, initialPrompt, ...(sessionId ? { sessionId } : {}), ...(await codexHomeOf(deps, seat)) }, config),
  )
  await writeLaunchFiles(spec)
  await writeLaunchJson(deps, run.id, seat.name, spec)

  const roster = await loadRoster(deps.home, run.id)
  const placed = openSeats(roster).filter(entry => entry.name !== seat.name && entry.paneId)
  const placement = await placePane(deps, run, placed, launchCwd, spec.env)
  if (!isPlacement(placement)) {
    await rollback(undefined, undefined)
    return placement
  }
  const { started, adopted, paneId, createdTab } = await startWithRetry(deps, run, {
    seat: seat.name, kind, argv: spec.argv, paneId: placement.paneId, createdTab: placement.createdTab,
    place: () => placePane(deps, run, placed, launchCwd, spec.env),
  })
  const live = started.ok ? await herdr.getAgent(deps.exec, paneId) : undefined
  const captured = started.ok || adopted ? undefined : await captureStartFailure(deps, run, seat.name, paneId, started)

  if (!started.ok && started.code === 'agent_not_ready') {
    const screen = await herdr.readScreen(deps.exec, paneId, 40, 'visible')
    const dialog = screen.ok ? matchDialog(seat.name, screen.value, now) : undefined
    const attention = dialog ?? { seat: seat.name, reason: 'dialog' as const, detail: 'The agent stopped on a startup dialog; answer it in the pane. Drove will not.', at: iso }
    await updateRoster(deps.home, run.id, current => upsertSeat(current, { ...seat, paneId, state: 'blocked', attention: [attention] }))
    await recordEvent(deps, run.id, { type: 'attention', seat: seat.name, data: { reason: attention.reason } })
    if (isViaPrompt) await queueBrief(deps, run, seat.name, briefText)
    return ok(`Worker ${seat.name} started in pane ${paneId} but stopped on a dialog (${attention.reason}): ${attention.detail} ${isViaPrompt ? 'The brief is queued.' : 'The brief is part of its launch and runs once the dialog is answered.'}`, { state: 'blocked', paneId })
  }
  if (!started.ok && !adopted) {
    await rollback(paneId, createdTab)
    return failed('herdr', `herdr could not start ${kind} in pane ${paneId}, so the pane was closed again and no worker exists: ${clip(started.output)}.${captured ? hintText(captured) : ''}`)
  }

  const initialState: Seat['state'] = adopted ? adopted.state : isViaPrompt ? 'idle' : 'working'
  const liveSession = (live?.ok ? live.value.sessionId : undefined) ?? adopted?.sessionId
  await updateRoster(deps.home, run.id, current =>
    upsertSeat(current, {
      ...seat,
      ...keptWatcherFields(findSeat(current, seat.name)),
      paneId,
      state: initialState,
      ...(initialState === 'working' ? { lastWorkingAt: iso } : {}),
      ...(liveSession && !seat.sessionId ? { sessionId: liveSession } : {}),
    }),
  )
  const startNote = adopted && !started.ok ? `herdr's agent start ${started.code === 'timeout' ? 'timed out' : `failed (${started.code})`} but the ${kind} agent is up in the pane, so the seat was kept.` : undefined
  await recordEvent(deps, run.id, {
    type: 'seat.spawn',
    seat: seat.name,
    data: { kind, model, effort, pane: paneId, worktree, branch, cairn: request.cairn, ...(adopted && !started.ok ? { ...(started.code === 'timeout' ? { startTimeout: true } : { startError: started.code }) } : {}), ...(baseNotes.length > 0 ? { notes: baseNotes } : {}) },
  })
  const via = isViaPrompt ? await queueBrief(deps, run, seat.name, briefText) : 'launch-arg'
  if (!isViaPrompt) await recordEvent(deps, run.id, { type: 'control.sent', seat: seat.name, data: { kind: 'brief', via: 'launch-arg' } })
  return ok(`Worker ${seat.name} (${kind}${model ? ` ${model}` : ''} ${effort}) is running in pane ${paneId}, worktree ${worktree} on branch ${branch}. Brief: ${via}. Its reports will come to you.${startNote ? ` Note: ${startNote}` : ''}${baseNotes.map(note => ` Note: ${note}`).join('')}`, { paneId, worktree, branch })
}

const queueBrief = async (deps: Deps, run: RunMeta, seat: string, text: string): Promise<string> => {
  const control: Control = { v: 1, id: newControlId(deps.clock.now()), run: run.id, from: 'planner', to: seat, kind: 'brief', expects: 'review', body: text, at: deps.clock.now().toISOString() }
  const delivery = await deliverControl(deps, run, control)
  if (!delivery.ok) return delivery.queued ? `queued (${delivery.reason})` : `not delivered (${delivery.reason})`
  const iso = deps.clock.now().toISOString()
  await updateRoster(deps.home, run.id, current => {
    const entry = findSeat(current, seat)
    return entry && (entry.state === 'idle' || entry.state === 'starting') ? upsertSeat(current, { ...entry, state: 'working', stateAt: iso, lastWorkingAt: iso }) : current
  })
  return 'unconfirmed' in delivery && delivery.unconfirmed ? `${delivery.via} (typed; herdr did not confirm the agent took it within its wait, which a long first turn explains)` : delivery.via
}

// ---------- send / prompt ----------

const defaultExpects = (request: SendRequest): Control['expects'] => request.expects ?? (request.kind === 'verdict' && request.verdict === 'changes' ? 'review' : 'none')

export const send = async (deps: Deps, identity: Identity, request: SendRequest): Promise<CommandResult> => {
  const denied = requirePlanner(identity)
  if (denied) return denied
  const located = await locateFor(deps, identity)
  if ('error' in located) return located.error
  const { run } = located
  const seat = findSeat(await loadRoster(deps.home, run.id), request.seat)
  if (!seat || ['closed', 'gone', 'down'].includes(seat.state)) return failed('no-seat', `no open seat named ${request.seat}`)
  const notes = request.body.trim()
  if (request.kind === 'verdict' && request.verdict !== 'approve' && request.verdict !== 'changes') return failed('usage', 'a verdict needs --verdict approve or changes')
  if (request.kind === 'verdict' && request.verdict === 'changes' && !notes) return failed('usage', 'say which changes are needed')
  if (request.kind !== 'verdict' && request.kind !== 'nudge' && !notes) return failed('usage', 'the message is empty')
  const body =
    request.kind === 'verdict'
      ? request.verdict === 'approve'
        ? [notes, notes.includes(approvedText()) ? '' : approvedText()].filter(Boolean).join('\n\n')
        : `${notes}\n\nFix these, verify again, then send a done report.`
      : notes
  const control: Control = {
    v: 1, id: newControlId(deps.clock.now()), run: run.id, from: 'planner', to: seat.name, kind: request.kind,
    expects: defaultExpects(request), ...(request.verdict ? { verdict: request.verdict } : {}), body, at: deps.clock.now().toISOString(),
  }
  const delivery = await deliverControl(deps, run, control)
  if (!delivery.ok && !delivery.queued) return failed('delivery', `not delivered to ${seat.name}: ${delivery.reason}`)
  if (request.kind === 'verdict' || request.kind === 'answer') {
    await updateRoster(deps.home, run.id, roster => ({ ...roster, seats: roster.seats.map(entry => (entry.name === seat.name ? { ...entry, owes: 'none' } : entry)) }))
  }
  const label = request.kind === 'verdict' ? `verdict ${request.verdict}` : request.kind
  return delivery.ok
    ? ok(`Sent ${label} to ${seat.name} via ${delivery.via} (id ${control.id}, expects ${control.expects}).`, { id: control.id, via: delivery.via })
    : ok(`Queued ${label} for ${seat.name} (id ${control.id}): ${delivery.reason}. It will be sent when the pane is deliverable.`, { id: control.id, queued: true })
}

export const prompt = async (deps: Deps, identity: Identity, seatName: string, text: string): Promise<CommandResult> => {
  const denied = requirePlanner(identity)
  if (denied) return denied
  const located = await locateFor(deps, identity)
  if ('error' in located) return located.error
  const seat = findSeat(await loadRoster(deps.home, located.run.id), seatName)
  if (!seat || ['closed', 'gone', 'down'].includes(seat.state)) return failed('no-seat', `no open seat named ${seatName} in run ${located.run.id}`)
  if (!text.trim()) return failed('usage', 'the text is empty')
  const deliverable = await isDeliverable(deps, seat)
  if (!deliverable.ok) return failed('blocked', `not typed: ${deliverable.reason}`)
  const delivery = await herdrPromptAdapter(deps).deliver(seat, text)
  return delivery.ok ? ok(`Typed into ${seat.name}.`) : failed('delivery', delivery.reason)
}

// ---------- promote ----------

const isSettled = (seat: Seat): boolean => {
  if (seat.state !== 'idle' && seat.state !== 'done') return false
  return !seat.lastWorkingAt || (seat.lastReport !== undefined && Date.parse(seat.lastReport.at) >= Date.parse(seat.lastWorkingAt))
}

const promoteBody = (request: PromoteRequest, config: DroveConfig, seat: Seat): string => {
  const direction = request.model === config.workerModel[seat.kind] && request.effort === config.workerEffort ? 'Moved back to' : 'Promoted to'
  return `${direction} ${request.model || 'the default model'} at ${request.effort} effort${request.reason ? `: ${request.reason}` : ''}. Carry on.`
}

const markRestarting = async (deps: Deps, runId: string, name: string): Promise<Pick<Seat, 'state' | 'stateAt'> | undefined> => {
  let before: Pick<Seat, 'state' | 'stateAt'> | undefined
  const iso = deps.clock.now().toISOString()
  await updateRoster(deps.home, runId, roster => {
    const live = findSeat(roster, name)
    if (!live) return roster
    before = { state: live.state, stateAt: live.stateAt }
    return upsertSeat(roster, { ...live, state: 'starting', stateAt: iso, restartingSince: iso })
  })
  return before
}

const clearRestarting = async (deps: Deps, runId: string, name: string): Promise<void> => {
  await updateRoster(deps.home, runId, roster => {
    const live = findSeat(roster, name)
    if (!live?.restartingSince) return roster
    const { restartingSince: _cleared, ...rest } = live
    return upsertSeat(roster, rest)
  })
}

const restoreState = async (deps: Deps, runId: string, name: string, before: Pick<Seat, 'state' | 'stateAt'> | undefined): Promise<void> => {
  if (!before) return
  await updateRoster(deps.home, runId, roster => {
    const live = findSeat(roster, name)
    if (!live) return roster
    const { restartingSince: _cleared, ...rest } = live
    return upsertSeat(roster, { ...rest, ...before })
  })
}

export const promote = async (deps: Deps, identity: Identity, request: PromoteRequest): Promise<CommandResult> => {
  const denied = requirePlanner(identity)
  if (denied) return denied
  if (!EFFORTS.includes(request.effort)) return failed('usage', `--effort must be one of ${EFFORTS.join(', ')}`)
  const located = await locateFor(deps, identity)
  if ('error' in located) return located.error
  const { run } = located
  const config = await loadConfig(deps.home)
  const seat = findSeat(await loadRoster(deps.home, run.id), request.seat)
  if (!seat || ['closed', 'gone', 'down'].includes(seat.state)) return failed('no-seat', `no open seat named ${request.seat}`)
  const model = !request.model?.trim() && seat.kind === 'codex' ? seat.model : resolveModel(seat.kind, request.model, config)
  const change = { model, effort: request.effort }
  const control: Control = {
    v: 1, id: newControlId(deps.clock.now()), run: run.id, from: 'planner', to: seat.name, kind: model === config.workerModel[seat.kind] && request.effort === config.workerEffort ? 'demote' : 'promote',
    expects: 'none', ...(model ? { model } : {}), effort: request.effort, body: promoteBody({ ...request, model }, config, seat), at: deps.clock.now().toISOString(),
  }

  if (seat.kind === 'claude' && run.planner.viaMod) {
    await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...seat, ...change, owes: 'none' }))
    const delivery = await deliverControl(deps, run, control)
    return delivery.ok || delivery.queued
      ? ok(`${seat.name} now runs on ${model} at ${request.effort} effort from its next request.`)
      : failed('delivery', `not delivered to ${seat.name}: ${delivery.reason}`)
  }

  if (!isSettled(seat) && seat.owes === 'none') {
    await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...seat, pendingPromote: { ...change, ...(request.reason ? { reason: request.reason } : {}) } }))
    return ok(`Queued until ${seat.name} is idle: a restart is refused mid-turn or while it owes a report.`, { queued: true })
  }
  const sessionId = seat.sessionId ?? (await hookSessionId(deps, run.id, seat.name))
  if (!sessionId) return failed('no-session', `${seat.name} has no saved session id yet, so it cannot be resumed`)
  if (!seat.paneId) return failed('no-pane', `${seat.name} has no pane`)

  const token = await readToken(join(seatDir(deps.home, run.id, seat.name), 'token'))
  if (!token) return failed('no-token', `no token for ${seat.name}`)
  const before = await markRestarting(deps, run.id, seat.name)
  try {
    const stop = await stopAgent(deps, seat, timing.exitWaitMs)
    if (!stop.stopped) {
      await restoreState(deps, run.id, seat.name, before)
      return failed('restart', `${seat.name} did not stop after ${seat.kind === 'claude' ? 'its pane was closed' : '/quit'}${stop.detail ? ` (${stop.detail})` : ''}. Check the pane.`)
    }
    const lockNote = seat.kind === 'claude' ? await releaseStaleLock(deps, run, seat) : undefined

    const updated: Seat = { ...seat, ...change, sessionId, state: 'starting', stateAt: deps.clock.now().toISOString(), pendingPromote: undefined }
    const identityOfSeat: Identity = { home: deps.home, run: run.id, role: 'worker', seat: seat.name, token }
    const controlText = formatControl(control, token)
    const isInline = resolveBriefVia(config) === 'launch-arg' && isShellSafeArg(controlText)
    const spec = specFor(
      launchRequest(deps, { identity: identityOfSeat, kind: seat.kind, repo: run.repo, cwd: seat.worktree, model, effort: request.effort, roleText: seat.kind === 'codex' ? '' : workerRole(updated, run, config), resumeId: sessionId, ...(isInline ? { initialPrompt: controlText } : {}), ...(await codexHomeOf(deps, seat)) }, config),
    )
    await writeLaunchFiles(spec)
    await writeLaunchJson(deps, run.id, seat.name, spec)
    let paneId = seat.paneId
    if (seat.kind === 'claude') {
      const others = openSeats(await loadRoster(deps.home, run.id)).filter(entry => entry.name !== seat.name && entry.paneId)
      const placement = await placePane(deps, run, others, seat.worktree, spec.env)
      if (!isPlacement(placement)) {
        await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...updated, paneId: undefined, state: 'gone', attention: [{ seat: seat.name, reason: 'gone', detail: `no pane for the promote restart (${clip(placement.text, 160)}); run \`drove up --seat ${seat.name}\``, at: deps.clock.now().toISOString() }] }))
        return failed('restart', `${seat.name} exited but no new pane could be placed in its worktree: ${clip(placement.text)}. Relaunch it with \`drove up --seat ${seat.name}\`.`)
      }
      paneId = placement.paneId
      updated.paneId = paneId
    }
    const others = openSeats(await loadRoster(deps.home, run.id)).filter(entry => entry.name !== seat.name && entry.paneId)
    const attempt = await startWithRetry(deps, run, {
      seat: seat.name, kind: seat.kind, argv: spec.argv, paneId,
      place: () => placePane(deps, run, others, seat.worktree, spec.env),
    })
    const { started, adopted } = attempt
    paneId = attempt.paneId
    updated.paneId = paneId
    if (!started.ok && !adopted) {
      const captured = await captureStartFailure(deps, run, seat.name, paneId, started)
      await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...updated, state: 'gone', attention: [{ seat: seat.name, reason: 'gone', detail: `restart for promote failed (${clip(started.output, 160)}); run \`drove up --seat ${seat.name}\``, at: deps.clock.now().toISOString() }] }))
      return failed('restart', `${seat.name} exited but did not come back: ${clip(started.output)}.${hintText(captured)} Relaunch it with \`drove up --seat ${seat.name}\`.`)
    }
    const typed = isInline ? undefined : await herdr.retryWhileBusy(deps.exec, herdr.agentPromptArgv(paneId, controlText), BUSY_RETRY_MS)
    const via: Transport = isInline ? 'launch-arg' : 'herdr-prompt'
    if (typed && !typed.ok && typed.code !== 'timeout') {
      await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...updated, state: 'idle', owes: 'none', hasNudged: false }))
      return failed('delivery', `${seat.name} restarted on ${model || 'the default model'} at ${request.effort} effort, but herdr could not type the ${control.kind} notice into it: ${clip(typed.output)}`)
    }
    await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...updated, state: 'working', lastWorkingAt: deps.clock.now().toISOString(), lastSentAt: deps.clock.now().toISOString(), owes: 'none', hasNudged: false }))
    const isUnconfirmed = typed !== undefined && !typed.ok
    await appendJsonl(join(seatDir(deps.home, run.id, seat.name), 'sent.jsonl'), { id: control.id, via, at: deps.clock.now().toISOString() })
    await recordEvent(deps, run.id, { type: 'control.sent', seat: seat.name, id: control.id, data: { kind: control.kind, via, model, effort: request.effort, ...(isUnconfirmed ? { unconfirmed: true } : {}), ...(adopted && !started.ok ? { startTimeout: started.code === 'timeout' } : {}) } })
    return ok(`${seat.name} restarted with resume on ${model || 'the default model'} at ${request.effort} effort.${adopted && !started.ok ? ` Note: herdr's agent start ${started.code === 'timeout' ? 'timed out' : `failed (${started.code})`} but the agent is up in the pane, so the seat was kept.` : ''}${isUnconfirmed ? ' The notice was typed; herdr did not confirm the agent took it.' : ''}${lockNote ? ` Note: ${lockNote}.` : ''}`)
  } finally {
    await clearRestarting(deps, run.id, seat.name)
  }
}

export const applyPendingPromotes = async (deps: Deps, run: RunMeta): Promise<CommandResult[]> => {
  const waiting = openSeats(await loadRoster(deps.home, run.id)).filter(seat => seat.pendingPromote && isSettled(seat))
  const identity: Identity = { home: deps.home, run: run.id, role: 'planner', seat: PLANNER_SEAT }
  const results: CommandResult[] = []
  for (const seat of waiting) {
    const pending = seat.pendingPromote
    if (pending) results.push(await promote(deps, identity, { seat: seat.name, ...pending }))
  }
  return results
}

// ---------- roster / capture ----------

export const roster = async (deps: Deps, ref: RunRef, asJson: boolean): Promise<CommandResult> => {
  const located = await locateRun(deps, ref, 'up')
  if ('error' in located) return located.error
  const { run } = located
  if (run.status === 'up') await refreshRoster(deps, run).catch(() => undefined)
  const current = await loadRoster(deps.home, run.id)
  const attention = attentionOf(current)
  if (asJson) return ok(JSON.stringify({ run, seats: current.seats, attention }, null, 2), { run, roster: current, attention })
  const lines = [`run ${run.id} · ${basename(run.repo)} · ${run.status} · budget ${run.budget}`, ...rosterLines(current, deps.clock.now())]
  if (attention.length > 0) lines.push('', 'needs attention:', ...attention.map(item => `- ${item.seat}: ${item.reason} · ${item.detail}`))
  return ok(lines.join('\n'), { run, roster: current, attention })
}

export const capture = async (deps: Deps, ref: RunRef, seatName: string, lines: number): Promise<CommandResult> => {
  const located = await locateRun(deps, ref, 'up')
  if ('error' in located) return located.error
  const seat = findSeat(await loadRoster(deps.home, located.run.id), seatName)
  if (!seat) return failed('no-seat', `no seat named ${seatName}`)
  const screen = await herdr.readScreen(deps.exec, herdr.agentTarget(located.run.id, seat), Number.isFinite(lines) && lines > 0 ? lines : 80)
  return screen.ok ? ok(screen.value) : failed('herdr', `could not read ${seat.name}: ${screen.code}`)
}

// ---------- close ----------

export const close = async (deps: Deps, identity: Identity, seatName: string, removeWorktree: boolean): Promise<CommandResult> => {
  const denied = requirePlanner(identity)
  if (denied) return denied
  const located = await locateFor(deps, identity)
  if ('error' in located) return located.error
  const { run } = located
  const seat = findSeat(await loadRoster(deps.home, run.id), seatName)
  if (!seat || seat.state === 'closed') return failed('no-seat', `no open seat named ${seatName}`)
  if (seat.paneId && seat.state !== 'gone' && seat.state !== 'down') {
    await updateRoster(deps.home, run.id, current => ({ ...current, seats: current.seats.map(entry => (entry.name === seat.name ? { ...entry, state: 'closing', attention: [] } : entry)) }))
    const stop = await stopAgent(deps, seat, timing.closeWaitMs)
    if (stop.detail) return failed('herdr', `herdr could not close pane ${seat.paneId}: ${stop.detail}`)
    if (!stop.paneClosed) {
      const closed = await herdr.run(deps.exec, herdr.paneCloseArgv(seat.paneId))
      if (!closed.ok && !isPaneMissing(closed)) return failed('herdr', `herdr could not close pane ${seat.paneId}: ${clip(closed.output)}`)
    }
  }
  const lockNote = seat.kind === 'claude' && seat.paneId ? await releaseStaleLock(deps, run, seat) : undefined
  const after = await updateRoster(deps.home, run.id, current => ({
    ...current,
    seats: current.seats.map(entry => (entry.name === seat.name ? { ...entry, state: 'closed', stateAt: deps.clock.now().toISOString(), attention: [] } : entry)),
  }))
  await recordEvent(deps, run.id, { type: 'seat.close', seat: seat.name })
  await closeEmptyTab(deps, run, after)

  const notes = [`Closed ${seat.name}${seat.paneId ? ` (pane ${seat.paneId})` : ''}.`]
  if (lockNote) notes.push(`Note: ${lockNote}.`)
  if (!removeWorktree) notes.push(`Its worktree ${seat.worktree} and branch ${seat.branch} are kept.`)
  else {
    const targets = [run.base, run.base.replace(/^origin\//, '')]
    const merged = (await Promise.all(targets.map(into => git.isMerged(deps.exec, run.repo, seat.branch, into)))).some(Boolean)
    if (!merged) notes.push(`Branch ${seat.branch} is not merged into ${run.base}, so the worktree ${seat.worktree} was kept.`)
    else {
      try {
        await git.removeWorktree(deps.exec, run.repo, seat.worktree)
        notes.push(`Removed worktree ${seat.worktree}; branch ${seat.branch} is merged and kept.`)
      } catch (error) {
        notes.push(`The worktree was kept: ${messageOf(error)}`)
      }
    }
  }
  return ok(notes.join(' '))
}

// ---------- down / up ----------

const SPAWNED_ORDER = (a: Seat, b: Seat): number => a.spawnedAt.localeCompare(b.spawnedAt)

export const down = async (deps: Deps, ref: RunRef): Promise<CommandResult> => {
  const located = await locateRun(deps, ref, 'up')
  if ('error' in located) return located.error
  const { run } = located
  if (run.status === 'down') return ok(`Run ${run.id} is already down.`)
  await refreshRoster(deps, run).catch(() => undefined)
  const current = await loadRoster(deps.home, run.id)
  const seats = current.seats.filter(seat => seat.state !== 'closed')
  const saved: string[] = []
  const unsaved: string[] = []

  for (const seat of seats) {
    const target = herdr.agentTarget(run.id, seat)
    let sessionId = seat.sessionId
    if (seat.state !== 'gone' && seat.state !== 'down') {
      const live = await herdr.getAgent(deps.exec, target)
      if (live.ok) sessionId = sessionId ?? live.value.sessionId
      if (!sessionId) sessionId = await hookSessionId(deps, run.id, seat.name)
      if (live.ok) {
        const stop = await stopAgent(deps, seat, timing.closeWaitMs)
        if (seat.paneId && !stop.paneClosed) await herdr.run(deps.exec, herdr.paneCloseArgv(seat.paneId))
      }
    }
    ;(sessionId ? saved : unsaved).push(seat.name)
    await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...seat, ...(sessionId ? { sessionId } : {}), state: 'down', stateAt: deps.clock.now().toISOString(), attention: [] }))
  }
  if (run.tabId) await herdr.run(deps.exec, herdr.tabCloseArgv(run.tabId))
  const plannerId = run.planner.sessionId ?? (await plannerSessionId(deps, run)) ?? (run.planner.paneId ? (await herdr.getAgent(deps.exec, run.planner.paneId).then(result => (result.ok ? result.value.sessionId : undefined))) : undefined)
  await saveRun(deps.home, { ...run, status: 'down', tabId: undefined, planner: { ...run.planner, ...(plannerId ? { sessionId: plannerId } : {}) } })
  await recordEvent(deps, run.id, { type: 'run.down', data: { saved, unsaved } })
  return ok(
    [`Run ${run.id} is down: ${saved.length} seat(s) saved for resume${saved.length ? ` (${saved.join(', ')})` : ''}.`, ...(unsaved.length ? [`No session id for ${unsaved.join(', ')}: they cannot be resumed.`] : []), `Resume with \`drove up --run ${run.id}\`.`].join(' '),
    { saved, unsaved },
  )
}

const resumePrompt = (seat: Seat): string | undefined =>
  seat.lastWorkingAt && (!seat.lastReport || Date.parse(seat.lastReport.at) < Date.parse(seat.lastWorkingAt)) ? resumedText() : undefined

type Relaunched = { seat: Seat; note?: string } | { error: string }

const launchRelaunch = async (deps: Deps, run: RunMeta, config: DroveConfig, seat: Seat, placed: readonly Seat[]): Promise<Relaunched> => {
  if (!seat.sessionId) return { error: `${seat.name} has no saved session id, so it cannot be resumed; close it and spawn a new one` }
  const token = (await readToken(join(seatDir(deps.home, run.id, seat.name), 'token'))) ?? mintToken()
  await writeToken(join(seatDir(deps.home, run.id, seat.name), 'token'), token)
  const identity: Identity = { home: deps.home, run: run.id, role: 'worker', seat: seat.name, token }
  const resumeText = resumePrompt(seat)
  const isInline = resolveBriefVia(config) === 'launch-arg'
  const spec = specFor(launchRequest(deps, { identity, kind: seat.kind, repo: run.repo, cwd: seat.worktree, model: seat.model, effort: seat.effort, roleText: seat.kind === 'codex' ? '' : workerRole(seat, run, config), resumeId: seat.sessionId, ...(isInline ? { initialPrompt: resumeText } : {}), ...(await codexHomeOf(deps, seat)) }, config))
  await writeLaunchFiles(spec)
  await writeLaunchJson(deps, run.id, seat.name, spec)
  const lockNote = seat.kind === 'claude' ? await releaseStaleLock(deps, run, seat) : undefined
  const before = await markRestarting(deps, run.id, seat.name)
  try {
    const placement = await placePane(deps, run, placed, seat.worktree, spec.env)
    if (!isPlacement(placement)) {
      await restoreState(deps, run.id, seat.name, before)
      return { error: placement.text }
    }
    if (placement.createdTab) run.tabId = placement.createdTab
    const attempt = await startWithRetry(deps, run, {
      seat: seat.name, kind: seat.kind, argv: spec.argv, paneId: placement.paneId, ...(placement.createdTab ? { createdTab: placement.createdTab } : {}),
      place: () => placePane(deps, run, placed, seat.worktree, spec.env),
    })
    const { started, adopted, paneId } = attempt
    if (attempt.createdTab) run.tabId = attempt.createdTab
    const captured = started.ok || adopted ? undefined : await captureStartFailure(deps, run, seat.name, paneId, started)
    if (!started.ok && !adopted && started.code !== 'agent_not_ready') {
      await herdr.run(deps.exec, herdr.paneCloseArgv(paneId))
      await restoreState(deps, run.id, seat.name, before)
      return { error: `herdr could not start ${seat.name}: ${clip(started.output)}.${captured ? hintText(captured) : ''}` }
    }
    const iso = deps.clock.now().toISOString()
    const isUp = started.ok || adopted !== undefined
    const typed = isUp && resumeText && !isInline ? await herdr.retryWhileBusy(deps.exec, herdr.agentPromptArgv(paneId, resumeText), BUSY_RETRY_MS) : undefined
    const isUndelivered = typed !== undefined && !typed.ok && typed.code !== 'timeout'
    const isResumed = Boolean(resumeText) && isUp && !isUndelivered
    const next: Seat = {
      ...seat, paneId, state: !isUp ? 'blocked' : isResumed ? 'working' : adopted?.state === 'working' ? 'working' : adopted?.state === 'starting' ? 'starting' : 'idle', stateAt: iso,
      ...(isResumed ? { lastWorkingAt: iso, lastSentAt: iso } : {}),
      attention: !isUp
        ? [{ seat: seat.name, reason: 'dialog', detail: 'The resumed agent stopped on a startup dialog; answer it in the pane.', at: iso }]
        : isUndelivered
          ? [{ seat: seat.name, reason: 'pending-delivery', detail: `the resume notice was not delivered (${clip(typed.output, 120)}); tell ${seat.name} to carry on`, at: iso }]
          : [],
    }
    await updateRoster(deps.home, run.id, roster => upsertSeat(roster, next))
    return { seat: next, ...(lockNote ? { note: lockNote } : {}) }
  } finally {
    await clearRestarting(deps, run.id, seat.name)
  }
}

const relaunchSeat = async (deps: Deps, run: RunMeta, config: DroveConfig, seat: Seat, placed: readonly Seat[]): Promise<Relaunched> => {
  const relaunched = await launchRelaunch(deps, run, config, seat, placed)
  const data = 'error' in relaunched
    ? { ok: false, resumed: false, error: clip(relaunched.error, 200), ...(seat.paneId ? { pane: seat.paneId } : {}) }
    : { ok: true, resumed: true, ...(relaunched.seat.paneId ? { pane: relaunched.seat.paneId } : {}) }
  await recordEvent(deps, run.id, { type: 'seat.relaunch', seat: seat.name, data })
  return relaunched
}

export const up = async (deps: Deps, ref: RunRef, seatName?: string): Promise<CommandResult> => {
  const located = seatName ? await locateRun(deps, ref, 'up') : await locateRun(deps, ref, 'down')
  if ('error' in located) return located.error
  let { run } = located
  const config = await loadConfig(deps.home)

  if (seatName) {
    const seat = findSeat(await loadRoster(deps.home, run.id), seatName)
    if (!seat || seat.state === 'closed') return failed('no-seat', `no seat named ${seatName} to relaunch`)
    if (seat.state !== 'gone' && seat.state !== 'down') return failed('not-dead', `${seatName} is ${seat.state}; only a gone or down seat is relaunched`)
    const placed = openSeats(await loadRoster(deps.home, run.id)).filter(entry => entry.name !== seat.name && entry.paneId)
    const relaunched = await relaunchSeat(deps, run, config, seat, placed)
    return 'error' in relaunched ? failed('relaunch', relaunched.error) : ok(`Relaunched ${seatName} in pane ${relaunched.seat.paneId} with resume.${relaunched.note ? ` Note: ${relaunched.note}.` : ''}`,{ paneId: relaunched.seat.paneId })
  }

  if (run.status !== 'down') return failed('not-down', `run ${run.id} is ${run.status}; nothing to resume`)
  const paneId = process.env.HERDR_PANE_ID
  if (!paneId) return failed('not-in-herdr', 'drove up must run inside a herdr pane (HERDR_PANE_ID is unset); the planner resumes in this pane')
  run = { ...run, status: 'up', tabId: undefined, planner: { ...run.planner, paneId } }
  await saveRun(deps.home, run)
  const seats = (await loadRoster(deps.home, run.id)).seats.filter(seat => seat.state === 'down').sort(SPAWNED_ORDER)
  const placed: Seat[] = []
  const resumed: string[] = []
  const lost: string[] = []
  for (const seat of seats) {
    const relaunched = await relaunchSeat(deps, run, config, seat, placed)
    if ('error' in relaunched) {
      lost.push(`${seat.name} (${relaunched.error})`)
      continue
    }
    placed.push(relaunched.seat)
    resumed.push(seat.name)
  }
  await saveRun(deps.home, run)
  await recordEvent(deps, run.id, { type: 'run.up', data: { resumed, lost, pane: paneId } })

  const identity: Identity = { home: deps.home, run: run.id, role: 'planner', seat: PLANNER_SEAT }
  const planner = run.planner
  const sessionId = planner.kind === 'claude' ? planner.sessionId ?? randomUUID() : undefined
  const resumeId = planner.sessionId
  const spec = specFor(
    launchRequest(deps, { identity, kind: planner.kind, repo: run.repo, cwd: run.repo, model: planner.model, effort: planner.effort, roleText: plannerRole(run, config, planner.kind), channel: planner.kind === 'claude' && config.claudeChannel, ...(resumeId ? { resumeId } : { initialPrompt: planner.kind === 'codex' ? 'The run was resumed. Read the roster and continue.' : undefined, sessionId }) }, config),
  )
  await writeLaunchFiles(spec)
  const summary = `Run ${run.id} is up: resumed ${resumed.length ? resumed.join(', ') : 'no workers'}${lost.length ? `; could not resume ${lost.join('; ')}` : ''}.${resumeId ? '' : ' The planner had no saved session id, so it starts fresh.'}`
  return ok(summary, { argv: execArgv(spec), env: spec.env, cwd: spec.cwd } satisfies ProcessPlan)
}

// ---------- budget ----------

export const budget = async (deps: Deps, ref: RunRef, size: number): Promise<CommandResult> => {
  if (process.env[ENV.role]) return failed('forbidden', 'only the human can raise the pane budget; ask them to run `drove budget <n>`')
  if (!Number.isInteger(size) || size < 1) return failed('usage', 'the budget must be a whole number of at least 1')
  const located = await locateRun(deps, ref, 'up')
  if ('error' in located) return located.error
  await saveRun(deps.home, { ...located.run, budget: size })
  return ok(`Pane budget for run ${located.run.id} is now ${size}.`, { budget: size })
}
