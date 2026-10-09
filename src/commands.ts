import { spawn as spawnProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyDerived, deriveState, findDialog, matchDialog } from './detect.ts'
import { BUSY_RETRY_MS, deliverControl, herdrPromptAdapter, isDeliverable, plannerSessionId, recordEvent } from './deliver.ts'
import * as git from './git.ts'
import * as herdr from './herdr.ts'
import { execArgv, isShellSafeArg, redactSpec, specFor, writeLaunchFiles } from './launch.ts'
import { branchName, defaultHome, ENV, identityFromEnv, newRunId, PLANNER_SEAT, plannerDir, SEAT_RE, seatDir, worktreePath } from './paths.ts'
import { approvedText, briefFooter, plannerRole, resumedText, workerRole } from './prompts.ts'
import { formatControl } from './protocol.ts'
import { attentionOf, findSeat, gridSlot, isOverBudget, latestRunFor, loadRoster, loadRun, openSeats, rosterLines, saveRun, updateRoster, upsertSeat } from './roster.ts'
import { appendJsonl, mintToken, readJson, readJsonlFrom, readToken, writeJsonAtomic, writeToken } from './store.ts'
import type {
  AgentKind, CommandResult, Control, Deps, DroveConfig, Effort, Exec, ExecResult, HookRecord, Identity, LaunchRequest, PromoteRequest, RunMeta, Seat, SendRequest, SpawnRequest, Transport,
} from './types.ts'

export type PlanRequest = { repo: string; kind: AgentKind; model?: string; effort?: Effort; goal?: string; run?: string }
export type RunRef = { run?: string; repo: string }
export type ProcessPlan = { argv: string[]; env: Record<string, string>; cwd: string }

export const DROVE_ENTRY = fileURLToPath(new URL('./cli.ts', import.meta.url))
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const timing = { pollMs: 500, exitWaitMs: 20_000, closeWaitMs: 3_000 }

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
  claudeChannel: false,
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

const quitText = (kind: AgentKind): string => (kind === 'claude' ? '/exit' : '/quit')

const quitAgent = async (deps: Deps, seat: Seat, waitMs: number): Promise<boolean> => {
  const target = seat.paneId ?? seat.name
  await herdr.run(deps.exec, herdr.agentTypeArgv(target, quitText(seat.kind)), 15_000)
  return settle(isGone(deps, target), waitMs)
}

const launchRequest = (
  deps: Deps,
  parts: Pick<LaunchRequest, 'identity' | 'kind' | 'repo' | 'cwd' | 'model' | 'effort' | 'roleText'> & Partial<LaunchRequest>,
  config: DroveConfig,
): LaunchRequest => ({
  droveEntry: DROVE_ENTRY,
  bypassHookTrust: parts.kind === 'codex' && config.codexBypassHookTrust,
  ...parts,
})

const writeLaunchJson = async (deps: Deps, run: string, seat: string, spec: Parameters<typeof redactSpec>[0]): Promise<void> => {
  await writeJsonAtomic(join(seatDir(deps.home, run, seat), 'launch.json'), redactSpec(spec))
}

const START_FAILURE_LINES = 60

const captureStartFailure = async (deps: Deps, run: RunMeta, seat: string, paneId: string | undefined, failure: { code: string; output: string }): Promise<{ hint?: string; file: string }> => {
  const byAgent = await herdr.readScreen(deps.exec, seat, START_FAILURE_LINES)
  const screen = byAgent.ok || !paneId ? byAgent : await herdr.readPane(deps.exec, paneId, START_FAILURE_LINES)
  const text = screen.ok ? screen.value : `(could not read the pane: ${screen.code})\n${screen.output}`
  const file = join(seatDir(deps.home, run.id, seat), 'start-failure.txt')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  const dialog = screen.ok ? findDialog(text) : undefined
  await recordEvent(deps, run.id, { type: 'seat.start_failed', seat, data: { code: failure.code, ...(dialog ? { reason: dialog.reason } : {}), ...(paneId ? { pane: paneId } : {}), file } })
  return { ...(dialog ? { hint: dialog.hint } : {}), file }
}

const hintText = (captured: { hint?: string; file: string }): string => `${captured.hint ? ` Hint: ${captured.hint}.` : ''} Pane output saved to ${captured.file}.`

export const refreshRoster = async (deps: Deps, run: RunMeta): Promise<void> => {
  const listed = await herdr.listAgents(deps.exec)
  if (!listed.ok) return
  const now = deps.clock.now()
  const seats = openSeats(await loadRoster(deps.home, run.id))
  const derived = await Promise.all(
    seats.map(async seat => {
      const live = listed.value.find(agent => (seat.paneId ? agent.paneId === seat.paneId : agent.name === seat.name))
      const hooks = await hooksOf(deps, run.id, seat.name)
      const screen = live?.status === 'blocked' ? await herdr.readScreen(deps.exec, seat.paneId ?? seat.name, 40, 'detection') : undefined
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

const placePane = async (deps: Deps, run: RunMeta, placed: readonly Seat[], cwd: string, env: Record<string, string>): Promise<Placement | CommandResult> => {
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

class OverBudget extends Error {}
class SeatTaken extends Error {}

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
  }

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
  const isRoleInBrief = kind === 'codex' && process.env.DROVE_ROLE_IN_BRIEF === '1'
  const roleText = workerRole(seat, run, config)
  const briefText = isRoleInBrief ? `${roleText}\n\n${footer}` : footer
  const isViaPrompt = process.env.DROVE_BRIEF_VIA === 'herdr-prompt' || !isShellSafeArg(briefText)
  const initialPrompt = isViaPrompt ? undefined : briefText
  const spec = specFor(
    launchRequest(deps, { identity: workerIdentity, kind, repo: run.repo, cwd: launchCwd, model, effort, roleText: isRoleInBrief ? '' : roleText, initialPrompt, ...(sessionId ? { sessionId } : {}) }, config),
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
  const { paneId, createdTab } = placement

  const started = await herdr.retryWhileBusy(deps.exec, herdr.agentStartArgv(seat.name, kind, paneId, spec.argv), BUSY_RETRY_MS)
  const live = started.ok ? await herdr.getAgent(deps.exec, seat.name) : undefined
  const isRecovered = !started.ok && started.code !== 'agent_not_ready' && (await herdr.getAgent(deps.exec, seat.name)).ok
  const captured = started.ok ? undefined : await captureStartFailure(deps, run, seat.name, paneId, started)

  if (!started.ok && started.code === 'agent_not_ready') {
    const screen = await herdr.readScreen(deps.exec, seat.name, 40, 'detection')
    const dialog = screen.ok ? matchDialog(seat.name, screen.value, now) : undefined
    const attention = dialog ?? { seat: seat.name, reason: 'dialog' as const, detail: 'The agent stopped on a startup dialog; answer it in the pane. Drove will not.', at: iso }
    await updateRoster(deps.home, run.id, current => upsertSeat(current, { ...seat, paneId, state: 'blocked', attention: [attention] }))
    await recordEvent(deps, run.id, { type: 'attention', seat: seat.name, data: { reason: attention.reason } })
    if (isViaPrompt) await queueBrief(deps, run, seat.name, briefText)
    return ok(`Worker ${seat.name} started in pane ${paneId} but stopped on a dialog (${attention.reason}): ${attention.detail} ${isViaPrompt ? 'The brief is queued.' : 'The brief is part of its launch and runs once the dialog is answered.'}`, { state: 'blocked', paneId })
  }
  if (!started.ok && !isRecovered) {
    await rollback(paneId, createdTab)
    return failed('herdr', `herdr could not start ${kind} in pane ${paneId}, so the pane was closed again and no worker exists: ${clip(started.output)}.${captured ? hintText(captured) : ''}`)
  }

  const isWorking = !isViaPrompt
  await updateRoster(deps.home, run.id, current =>
    upsertSeat(current, {
      ...seat,
      paneId,
      state: isWorking ? 'working' : 'idle',
      ...(isWorking ? { lastWorkingAt: iso } : {}),
      ...(live?.ok && live.value.sessionId && !seat.sessionId ? { sessionId: live.value.sessionId } : {}),
    }),
  )
  await recordEvent(deps, run.id, { type: 'seat.spawn', seat: seat.name, data: { kind, model, effort, pane: paneId, worktree, branch, cairn: request.cairn, ...(baseNotes.length > 0 ? { notes: baseNotes } : {}) } })
  const via = isViaPrompt ? await queueBrief(deps, run, seat.name, briefText) : 'launch-arg'
  if (!isViaPrompt) await recordEvent(deps, run.id, { type: 'control.sent', seat: seat.name, data: { kind: 'brief', via: 'launch-arg' } })
  return ok(`Worker ${seat.name} (${kind}${model ? ` ${model}` : ''} ${effort}) is running in pane ${paneId}, worktree ${worktree} on branch ${branch}. Brief: ${via}. Its reports will come to you.${baseNotes.map(note => ` Note: ${note}`).join('')}`, { paneId, worktree, branch })
}

const queueBrief = async (deps: Deps, run: RunMeta, seat: string, text: string): Promise<string> => {
  const control: Control = { v: 1, id: newControlId(deps.clock.now()), run: run.id, from: 'planner', to: seat, kind: 'brief', expects: 'review', body: text, at: deps.clock.now().toISOString() }
  const delivery = await deliverControl(deps, run, control)
  return delivery.ok ? delivery.via : delivery.queued ? `queued (${delivery.reason})` : `not delivered (${delivery.reason})`
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
  const model = resolveModel(seat.kind, request.model, config)
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
  if (!seat.sessionId) return failed('no-session', `${seat.name} has no saved session id yet, so it cannot be resumed`)
  if (!seat.paneId) return failed('no-pane', `${seat.name} has no pane`)

  const token = await readToken(join(seatDir(deps.home, run.id, seat.name), 'token'))
  if (!token) return failed('no-token', `no token for ${seat.name}`)
  const quit = await quitAgent(deps, seat, timing.exitWaitMs)
  if (!quit) return failed('restart', `${seat.name} did not exit after ${quitText(seat.kind)}; nothing was changed. Check the pane.`)

  const updated: Seat = { ...seat, ...change, state: 'starting', stateAt: deps.clock.now().toISOString(), pendingPromote: undefined }
  const identityOfSeat: Identity = { home: deps.home, run: run.id, role: 'worker', seat: seat.name, token }
  const controlText = formatControl(control, token)
  const isInline = isShellSafeArg(controlText)
  const spec = specFor(
    launchRequest(deps, { identity: identityOfSeat, kind: seat.kind, repo: run.repo, cwd: seat.worktree, model, effort: request.effort, roleText: workerRole(updated, run, config), resumeId: seat.sessionId, ...(isInline ? { initialPrompt: controlText } : {}) }, config),
  )
  await writeLaunchFiles(spec)
  await writeLaunchJson(deps, run.id, seat.name, spec)
  let paneId = seat.paneId
  if (seat.kind === 'claude') {
    await herdr.run(deps.exec, herdr.paneCloseArgv(seat.paneId))
    const others = openSeats(await loadRoster(deps.home, run.id)).filter(entry => entry.name !== seat.name && entry.paneId)
    const placement = await placePane(deps, run, others, seat.worktree, spec.env)
    if (!isPlacement(placement)) {
      await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...updated, paneId: undefined, state: 'gone', attention: [{ seat: seat.name, reason: 'gone', detail: `no pane for the promote restart (${clip(placement.text, 160)}); run \`drove up --seat ${seat.name}\``, at: deps.clock.now().toISOString() }] }))
      return failed('restart', `${seat.name} exited but no new pane could be placed in its worktree: ${clip(placement.text)}. Relaunch it with \`drove up --seat ${seat.name}\`.`)
    }
    paneId = placement.paneId
    updated.paneId = paneId
  }
  const started = await herdr.retryWhileBusy(deps.exec, herdr.agentStartArgv(seat.name, seat.kind, paneId, spec.argv), BUSY_RETRY_MS)
  if (!started.ok) {
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
  await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...updated, state: 'working', lastWorkingAt: deps.clock.now().toISOString(), owes: 'none', hasNudged: false }))
  await appendJsonl(join(seatDir(deps.home, run.id, seat.name), 'sent.jsonl'), { id: control.id, via, at: deps.clock.now().toISOString() })
  await recordEvent(deps, run.id, { type: 'control.sent', seat: seat.name, id: control.id, data: { kind: control.kind, via, model, effort: request.effort } })
  return ok(`${seat.name} restarted with resume on ${model || 'the default model'} at ${request.effort} effort.`)
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
  const screen = await herdr.readScreen(deps.exec, seat.paneId ?? seat.name, Number.isFinite(lines) && lines > 0 ? lines : 80)
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
    await quitAgent(deps, seat, timing.closeWaitMs)
    const closed = await herdr.run(deps.exec, herdr.paneCloseArgv(seat.paneId))
    if (!closed.ok && !/not.?found|no such|unknown/i.test(`${closed.code} ${closed.output}`)) return failed('herdr', `herdr could not close pane ${seat.paneId}: ${clip(closed.output)}`)
  }
  const after = await updateRoster(deps.home, run.id, current => ({
    ...current,
    seats: current.seats.map(entry => (entry.name === seat.name ? { ...entry, state: 'closed', stateAt: deps.clock.now().toISOString(), attention: [] } : entry)),
  }))
  await recordEvent(deps, run.id, { type: 'seat.close', seat: seat.name })
  await closeEmptyTab(deps, run, after)

  const notes = [`Closed ${seat.name}${seat.paneId ? ` (pane ${seat.paneId})` : ''}.`]
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
    const target = seat.paneId ?? seat.name
    let sessionId = seat.sessionId
    if (seat.state !== 'gone' && seat.state !== 'down') {
      const live = await herdr.getAgent(deps.exec, target)
      if (live.ok) sessionId = sessionId ?? live.value.sessionId
      if (!sessionId) sessionId = (await hooksOf(deps, run.id, seat.name)).findLast(hook => hook.event === 'session-start' && hook.sessionId)?.sessionId
      if (live.ok) {
        await quitAgent(deps, seat, timing.closeWaitMs)
        if (seat.paneId) await herdr.run(deps.exec, herdr.paneCloseArgv(seat.paneId))
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

const relaunchSeat = async (deps: Deps, run: RunMeta, config: DroveConfig, seat: Seat, placed: readonly Seat[]): Promise<{ seat: Seat } | { error: string }> => {
  if (!seat.sessionId) return { error: `${seat.name} has no saved session id, so it cannot be resumed; close it and spawn a new one` }
  const token = (await readToken(join(seatDir(deps.home, run.id, seat.name), 'token'))) ?? mintToken()
  await writeToken(join(seatDir(deps.home, run.id, seat.name), 'token'), token)
  const identity: Identity = { home: deps.home, run: run.id, role: 'worker', seat: seat.name, token }
  const spec = specFor(launchRequest(deps, { identity, kind: seat.kind, repo: run.repo, cwd: seat.worktree, model: seat.model, effort: seat.effort, roleText: workerRole(seat, run, config), resumeId: seat.sessionId, initialPrompt: resumePrompt(seat) }, config))
  await writeLaunchFiles(spec)
  await writeLaunchJson(deps, run.id, seat.name, spec)
  const placement = await placePane(deps, run, placed, seat.worktree, spec.env)
  if (!isPlacement(placement)) return { error: placement.text }
  if (placement.createdTab) run.tabId = placement.createdTab
  const started = await herdr.retryWhileBusy(deps.exec, herdr.agentStartArgv(seat.name, seat.kind, placement.paneId, spec.argv), BUSY_RETRY_MS)
  const captured = started.ok ? undefined : await captureStartFailure(deps, run, seat.name, placement.paneId, started)
  if (!started.ok && started.code !== 'agent_not_ready') {
    await herdr.run(deps.exec, herdr.paneCloseArgv(placement.paneId))
    return { error: `herdr could not start ${seat.name}: ${clip(started.output)}.${captured ? hintText(captured) : ''}` }
  }
  const iso = deps.clock.now().toISOString()
  const next: Seat = {
    ...seat, paneId: placement.paneId, state: started.ok ? (resumePrompt(seat) ? 'working' : 'idle') : 'blocked', stateAt: iso,
    ...(started.ok && resumePrompt(seat) ? { lastWorkingAt: iso } : {}), attention: started.ok ? [] : [{ seat: seat.name, reason: 'dialog', detail: 'The resumed agent stopped on a startup dialog; answer it in the pane.', at: iso }],
  }
  await updateRoster(deps.home, run.id, roster => upsertSeat(roster, next))
  return { seat: next }
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
    return 'error' in relaunched ? failed('relaunch', relaunched.error) : ok(`Relaunched ${seatName} in pane ${relaunched.seat.paneId} with resume.`, { paneId: relaunched.seat.paneId })
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
