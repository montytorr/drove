import { spawn as spawnProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrchModStatus } from '../mod/types/index.d.ts'
import { attentionCandidates, type AttentionDelta, attentionLine, diffItems, PANE_BUDGET_REASON, settleItems } from './attention.ts'
import { applyDerived, deriveState, EXIT_WAIT_MS, findDialog, isRestarting, matchDialog, shouldReadScreen } from './detect.ts'
import { BUSY_RETRY_MS, confirmedByHook, deliverControl, herdrPromptAdapter, isDeliverable, plannerSessionId, recordEvent } from './deliver.ts'
import * as git from './git.ts'
import * as herdr from './herdr.ts'
import { applyCopy, copyNotes, freeSlot, planCopy, portEnv, seatEnv } from './isolation.ts'
import { CHROME_SERVER, type CodexLaunchRequest, codexMcpNames, execArgv, isShellSafeArg, readClaudeMcp, readClaudePlugins, readCodexHome, redactSpec, specFor, unknownPlugins, userClaudeConfig, userClaudeDir, writeLaunchFiles } from './launch.ts'
import { branchName, codexHomeDir, defaultHome, ENV, identityFromEnv, newRunId, PLANNER_SEAT, plannerDir, runDir, SEAT_RE, seatDir, userCodexHome, worktreePath } from './paths.ts'
import { type AvailableTrims, LAB_RE, type LabSubject, approvedText, briefFooter, cairnGoalPrompt, labSubjectPrompt, plannerRole, resumedText, verifyCommands, workerRole } from './prompts.ts'
import { formatControl, REPORT_KINDS, renderReports } from './protocol.ts'
import { attentionOf, findSeat, gridSlot, isOverBudget, latestRunFor, loadRoster, loadRun, openSeats, rosterLines, saveRun, updateRoster, upsertSeat } from './roster.ts'
import { appendJsonl, mintToken, readJson, readJsonlFrom, readToken, writeJsonAtomic, writeToken } from './store.ts'
import type {
  AgentKind, Attention, AttentionItem, CommandResult, Control, Deps, DetachedStart, DroveConfig, DroveEvent, Effort, Exec, ExecResult, HerdrStatus, HookRecord, Identity, LaunchRequest, LaunchSpec, MergeGate, MergeRequest, MigrateRequest, PlannerState, PromoteRequest, Report, RunMeta, Seat, SeatRole, SendRequest, SpawnRequest, Transport,
} from './types.ts'

export type PlanRequest = { repo: string; kind: AgentKind; model?: string; effort?: Effort; goal?: string; run?: string; cairn?: string; next?: string; detached?: boolean; json?: boolean }
export type RunRef = { run?: string; repo: string }
export type ProcessPlan = { argv: string[]; env: Record<string, string>; cwd: string }

export const DROVE_ENTRY = fileURLToPath(new URL('./cli.ts', import.meta.url))
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const SEAT_ROLES: readonly SeatRole[] = ['implementer', 'reviewer', 'tester']
// What a tester owns unless the planner says otherwise (DROVE-91).
export const TESTER_OWNS: readonly string[] = ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**']
export const timing = { pollMs: 500, exitWaitMs: EXIT_WAIT_MS, closeWaitMs: 3_000, lockWaitMs: 5_000, promptWaitMs: 4_000, worktreeWaitMs: 15_000 }

const SESSIONLESS_PROMPT = 'Read the roster and wait for the human.'
const CAIRN_RE = /^[A-Z][A-Z0-9]*-\d+$/
const MCP_NAME_RE = /^[^\s,]+$/

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
  labInstance: 'croft',
  workerEnv: {},
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

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const envOf = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([name, text]) => ENV_NAME_RE.test(name) && typeof text === 'string')) : {}

const namesOf = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? [...new Set(value.filter((name): name is string => typeof name === 'string').map(name => name.trim()).filter(Boolean))] : undefined

const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1

const portsOf = (value: unknown): DroveConfig['workerPorts'] => {
  const { base, stride } = (value && typeof value === 'object' ? value : {}) as { base?: unknown; stride?: unknown }
  return typeof base === 'number' && typeof stride === 'number' && Number.isInteger(base) && Number.isInteger(stride) && base >= 1 && base <= 65535 && stride >= 1 ? { base, stride } : undefined
}

export const loadConfig = async (home: string): Promise<DroveConfig> => {
  const { workerMcp, workerSkills, workerPlugins, workerUserMemory, maxTurns, workerPorts, workerCopy, labInstance, ...file } = (await readJson<Partial<DroveConfig>>(join(home, 'config.json')).catch(() => undefined)) ?? {}
  const ports = portsOf(workerPorts)
  const copy = namesOf(workerCopy)
  const mcp = namesOf(workerMcp)
  const skills = namesOf(workerSkills)
  const plugins = namesOf(workerPlugins)
  return {
    ...DEFAULT_CONFIG,
    ...file,
    ...(ports ? { workerPorts: ports } : {}),
    ...(copy && copy.length > 0 ? { workerCopy: copy } : {}),
    ...(mcp ? { workerMcp: mcp } : {}),
    ...(skills ? { workerSkills: skills } : {}),
    ...(plugins ? { workerPlugins: plugins } : {}),
    ...(typeof workerUserMemory === 'boolean' ? { workerUserMemory } : {}),
    ...(isWhole(maxTurns) ? { maxTurns } : {}),
    ...(typeof labInstance === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(labInstance.trim()) ? { labInstance: labInstance.trim() } : {}),
    plannerModel: { ...DEFAULT_CONFIG.plannerModel, ...file.plannerModel },
    workerModel: { ...DEFAULT_CONFIG.workerModel, ...file.workerModel },
    promotedModel: { ...DEFAULT_CONFIG.promotedModel, ...file.promotedModel },
    workerEnv: envOf(file.workerEnv),
  }
}

// Owned globs are relative to the worktree; a leading ./ and duplicates mean nothing, and none at all means no limit.
const ownsOf = (value: readonly string[] | undefined): string[] | undefined => {
  const globs = [...new Set((value ?? []).map(glob => glob.trim().replace(/^(\.\/)+/, '')).filter(Boolean))]
  return globs.length > 0 ? globs : undefined
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

export const boardRun = async (deps: Deps, ref: RunRef): Promise<{ run: string } | { error: CommandResult }> => {
  const located = await locateRun(deps, ref, 'up')
  if ('run' in located) return { run: located.run.id }
  const { error } = located
  return { error: ref.run || error.ok ? error : failed('no-run', `${error.text}, or pass --run ID`) }
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
  workerEnv: config.workerEnv,
  ...parts,
})

// A Codex seat resumes with the CODEX_HOME it started with, because its session lives under that home's sessions/
// (DROVE-34). A seat with none recorded started before Drove owned one and keeps the inline launch line and ~/.codex.
const codexHomeOf = async (deps: Deps, seat: Seat): Promise<Pick<CodexLaunchRequest, 'codexHome'>> =>
  seat.kind === 'codex' && seat.codexHome ? { codexHome: await readCodexHome(seat.codexHome, deps.codexUserHome ?? userCodexHome(deps.home)) } : {}

// No allowlist anywhere keeps the user's whole MCP setup (DROVE-72); workerMcp or a seat's --mcp makes the seat lean:
// Drove's server plus the union of both lists.
const seatMcpAllow = (config: DroveConfig, seat: Pick<Seat, 'mcp'>): string[] | undefined =>
  config.workerMcp === undefined && seat.mcp === undefined ? undefined : [...new Set([...(config.workerMcp ?? []), ...(seat.mcp ?? [])])]

// The same rule for plugins (DROVE-89): workerPlugins or a seat's --plugins makes a Claude seat plugin-lean, Drove's own
// mod aside, and the seat's list adds to the run's.
const seatPluginAllow = (config: DroveConfig, seat: Pick<Seat, 'plugins'>): string[] | undefined =>
  config.workerPlugins === undefined && seat.plugins === undefined ? undefined : [...new Set([...(config.workerPlugins ?? []), ...(seat.plugins ?? [])])]

// A seat's own userMemory wins over workerUserMemory; a Codex seat cannot use it (see below).
const isSeatMemoryOff = (config: DroveConfig, seat: Pick<Seat, 'userMemory'>): boolean => (seat.userMemory ?? config.workerUserMemory) === false

type LaunchExtras = { parts: Partial<CodexLaunchRequest>; missing: string[]; unknownPlugins: string[] }

// Codex's CODEX_HOME is shared by every seat of a run and Codex reads the user's AGENTS.md from it with no per-launch
// way to skip it (probed in rust-v0.162.0: project_doc_* only gates the repo's own AGENTS.md). So a Codex seat follows
// workerUserMemory alone, and a seat's plugins and userMemory options are Claude-only.
const trimExtrasOf = async (deps: Deps, run: RunMeta, config: DroveConfig, seat: Seat): Promise<LaunchExtras> => {
  const mcpAllow = seatMcpAllow(config, seat)
  if (seat.kind === 'claude') {
    // The user's MCP servers, plugins and memory are read only when a switch asks for them (DROVE-72, DROVE-88).
    const claudeDir = deps.claudeUserDir ?? userClaudeDir()
    const pluginAllow = seatPluginAllow(config, seat)
    const userMcp = mcpAllow ? await readClaudeMcp(deps.claudeUserConfig ?? userClaudeConfig(), run.repo) : undefined
    const userPlugins = pluginAllow ? await readClaudePlugins(join(claudeDir, 'settings.json')) : undefined
    return {
      parts: {
        ...(mcpAllow && userMcp ? { mcpAllow, userMcp } : {}),
        ...(pluginAllow && userPlugins ? { pluginAllow, userPlugins } : {}),
        ...(isSeatMemoryOff(config, seat) ? { userMemory: false, claudeDir } : {}),
      },
      missing: mcpAllow && userMcp ? mcpAllow.filter(name => name !== 'drove' && name !== CHROME_SERVER && userMcp[name] === undefined) : [],
      unknownPlugins: pluginAllow && userPlugins ? unknownPlugins(pluginAllow, userPlugins) : [],
    }
  }
  const { codexHome } = await codexHomeOf(deps, seat)
  const known = codexHome ? codexMcpNames(codexHome.userConfig) : []
  return {
    parts: {
      ...(codexHome ? { codexHome } : {}),
      ...(mcpAllow ? { mcpAllow } : {}),
      ...(config.workerMcp ? { homeMcpAllow: config.workerMcp } : {}),
      ...(config.workerSkills ? { skillAllow: config.workerSkills } : {}),
      ...(config.workerUserMemory === false ? { userMemory: false } : {}),
    },
    missing: codexHome && mcpAllow ? mcpAllow.filter(name => name !== 'drove' && !known.includes(name)) : [],
    unknownPlugins: [],
  }
}

// The seat's launch env too: workerEnv with its placeholders filled and the seat's ports (DROVE-93), from the slot stored on
// the seat, so relaunch, promote, up and migrate give the same env as the first launch.
type SeatLaunchExtras = LaunchExtras & { unknownPlaceholders: string[] }

const launchExtrasOf = async (deps: Deps, run: RunMeta, config: DroveConfig, seat: Seat): Promise<SeatLaunchExtras> => {
  const extras = await trimExtrasOf(deps, run, config, seat)
  const { env, unknown } = seatEnv(config.workerEnv, config.workerPorts, { run: run.id, seat: seat.name, slot: seat.slot })
  return { ...extras, parts: { ...extras.parts, workerEnv: env }, unknownPlaceholders: unknown }
}

// Slots held by the open seats of the other runs of this home: ports are machine-wide, so runs must not share a slot.
const slotsOfOtherRuns = async (deps: Deps, runId: string): Promise<number[]> => {
  const names = await readdir(join(deps.home, 'runs')).catch(() => [] as string[])
  const rosters = await Promise.all(names.filter(name => name !== runId).map(name => loadRoster(deps.home, name).catch(() => undefined)))
  return rosters.flatMap(roster => (roster ? openSeats(roster).flatMap(entry => (entry.slot === undefined ? [] : [entry.slot])) : []))
}

// Names only, read best effort and never written: what the planner can pass as mcp and plugins (DROVE-89).
const availableTrimsOf = async (deps: Deps, run: RunMeta): Promise<AvailableTrims> => {
  const claudeDir = deps.claudeUserDir ?? userClaudeDir()
  const [claudeMcp, plugins, codexConfig] = await Promise.all([
    readClaudeMcp(deps.claudeUserConfig ?? userClaudeConfig(), run.repo).catch(() => undefined),
    readClaudePlugins(join(claudeDir, 'settings.json')).catch(() => undefined),
    readFile(join(deps.codexUserHome ?? userCodexHome(deps.home), 'config.toml'), 'utf8').catch(() => undefined),
  ])
  return {
    ...(claudeMcp ? { mcp: Object.keys(claudeMcp).filter(name => name !== 'drove') } : {}),
    ...(codexConfig !== undefined ? { codexMcp: codexMcpNames(codexConfig) } : {}),
    ...(plugins ? { plugins: [...new Set([...plugins.enabled.map(key => key.split('@')[0] ?? key), ...(plugins.dirs ?? []).map(dir => dir.name)])].filter(name => name !== 'orchestrator') } : {}),
  }
}

const missingMcpNote = (seat: Seat, missing: readonly string[]): string[] =>
  missing.length > 0 ? [`MCP server${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not in the user's ${seat.kind === 'claude' ? 'Claude' : 'Codex'} setup, so ${seat.name} runs without ${missing.length > 1 ? 'them' : 'it'}.`] : []

const unknownPluginsNote = (seat: Seat, unknown: readonly string[]): string[] =>
  unknown.length > 0 ? [`Plugin${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not enabled in the user's Claude settings, so ${seat.name} runs without ${unknown.length > 1 ? 'them' : 'it'}.`] : []

// plugins and userMemory shape a Claude seat's settings only; saying so beats a silent no-op.
const claudeOnlyNote = (seat: Seat): string[] =>
  seat.kind === 'codex' && (seat.plugins !== undefined || seat.userMemory !== undefined)
    ? [`${seat.name} is a Codex seat: ${[seat.plugins !== undefined ? 'plugins' : '', seat.userMemory !== undefined ? 'userMemory' : ''].filter(Boolean).join(' and ')} apply to Claude seats only. A Codex seat follows the workerUserMemory config key, since its CODEX_HOME is shared by the run.`]
    : []

// A Codex seat without a Drove-owned home got its role inside its brief, so a relaunch adds none.
const seatRoleText = (run: RunMeta, config: DroveConfig, seat: Seat): string => (seat.kind === 'codex' && !seat.codexHome ? '' : workerRole(run, config, seat.role))

// A seat's identity for its hooks and tools: its owns globs, and a reviewer's or tester's role, which the guard reads.
const identityOfSeat = (deps: Deps, run: RunMeta, seat: Seat, token: string): Identity => ({
  home: deps.home, run: run.id, role: 'worker', seat: seat.name, token,
  ...(seat.owns ? { owns: seat.owns } : {}),
  ...(seat.role && seat.role !== 'implementer' ? { seatRole: seat.role } : {}),
})

const LOCKFILES = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'] as const

const repoVerifyCommands = async (repo: string): Promise<string[]> => {
  const read = (name: string): Promise<string | undefined> => readFile(join(repo, name), 'utf8').catch(() => undefined)
  return verifyCommands({
    packageJson: await read('package.json'),
    makefile: (await read('Makefile')) ?? (await read('makefile')),
    lockfiles: LOCKFILES.filter(name => existsSync(join(repo, name))),
  })
}

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

const saveBrief = async (deps: Deps, run: string, seat: string, text: string): Promise<void> => {
  const file = join(seatDir(deps.home, run, seat), 'brief.md')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${text}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
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
      const screen = shouldReadScreen(live, hooks, seat) ? await herdr.readScreen(deps.exec, herdr.agentTarget(run.id, seat), 40, 'visible') : undefined
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

// ---------- cairn goal and ref checks ----------

type CairnTask = { ref: string; title: string; status: string; body: string }
type CairnRead = { task: CairnTask } | { missing: string } | { skipped: string }

const CAIRN_CLOSED = ['done', 'cancelled']
const PROJECT_RE = /^[A-Z][A-Z0-9]*$/

const cairnJson = async (deps: Deps, argv: string[]): Promise<{ value: Record<string, unknown> } | { missing: string } | { skipped: string }> => {
  try {
    const ran = await deps.exec(['cairn', ...argv], { timeoutMs: 15_000 })
    const output = `${ran.stderr}\n${ran.stdout}`.replace(cairnPreamble, '')
    const gone = /^No (task|project|subject) /m.exec(output)
    if (gone) return { missing: clip(output) }
    if (ran.code !== 0) return { skipped: `cairn exited ${ran.code}: ${clip(output)}` }
    const value: unknown = JSON.parse(ran.stdout)
    return value && typeof value === 'object' ? { value: value as Record<string, unknown> } : { skipped: 'cairn printed no JSON object' }
  } catch (error) {
    return { skipped: `cairn could not be run: ${messageOf(error)}` }
  }
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

const readCairnTask = async (deps: Deps, ref: string): Promise<CairnRead> => {
  const read = await cairnJson(deps, ['show', ref, '--full', '--json'])
  if ('value' in read) return { task: { ref: textOf(read.value.ref) || ref, title: textOf(read.value.title), status: textOf(read.value.status), body: textOf(read.value.description) } }
  return read
}

const checkSpawnCairn = async (deps: Deps, ref: string): Promise<{ error: CommandResult } | { note?: string }> => {
  const read = await readCairnTask(deps, ref)
  if ('missing' in read) return { error: failed('no-task', `Cairn task ${ref} does not exist (${read.missing}); pass an open task's ref`) }
  if ('skipped' in read) return { note: `the Cairn task ${ref} was not checked (${read.skipped}).` }
  if (CAIRN_CLOSED.includes(read.task.status)) return { error: failed('task-closed', `Cairn task ${ref} is ${read.task.status}; a worker needs an open task, so file one or reopen it`) }
  return {}
}

type GoalTask = { ref: string; goal: string; prompt: string }

const pickNextTask = async (deps: Deps, project: string): Promise<{ ref: string } | { error: CommandResult }> => {
  if (!PROJECT_RE.test(project)) return { error: failed('usage', `--next takes a Cairn project key like DROVE; got "${project}"`) }
  const read = await cairnJson(deps, ['next', '--project', project, '--json'])
  if ('missing' in read) return { error: failed('no-task', `Cairn has no project ${project}`) }
  if ('skipped' in read) return { error: failed('cairn', `could not ask Cairn for the next task in ${project}: ${read.skipped}`) }
  const pick = read.value.pick
  const ref = pick && typeof pick === 'object' ? textOf((pick as Record<string, unknown>).ref) : ''
  return ref ? { ref } : { error: failed('no-task', `Cairn has no task to pick up in ${project}`) }
}

const readLabSubject = async (deps: Deps, instance: string, ref: string): Promise<{ subject: LabSubject } | { error: CommandResult }> => {
  const read = await cairnJson(deps, ['--instance', instance, 'subject', 'show', ref, '--json'])
  if ('missing' in read) return { error: failed('no-task', `Lab subject ${ref} does not exist on the ${instance} instance (${read.missing})`) }
  if ('skipped' in read) return { error: failed('cairn', `could not read Lab subject ${ref}: ${read.skipped}`) }
  const { value } = read
  const title = textOf(value.title)
  if (!title) return { error: failed('cairn', `Lab subject ${ref} has no title to use as a goal`) }
  const todos = (Array.isArray(value.todos) ? value.todos : [])
    .map(todo => (todo && typeof todo === 'object' ? (todo as Record<string, unknown>) : {}))
    .map(todo => ({ ref: textOf(todo.ref), title: textOf(todo.title), status: textOf(todo.status) }))
    .filter(todo => todo.ref && !CAIRN_CLOSED.includes(todo.status))
  return { subject: { ref: textOf(value.ref) || ref, title, body: textOf(value.body), todos } }
}

const resolveGoalTask = async (deps: Deps, request: Pick<PlanRequest, 'goal' | 'cairn' | 'next'>, labInstance: string): Promise<GoalTask | { error: CommandResult } | undefined> => {
  if (request.cairn === undefined && request.next === undefined) return undefined
  if (request.cairn !== undefined && request.next !== undefined) return { error: failed('usage', '--from-cairn and --next are exclusive') }
  if (request.goal) return { error: failed('usage', '--goal cannot be combined with --from-cairn or --next: the goal is the task') }
  let ref = request.cairn
  if (request.next !== undefined) {
    const picked = await pickNextTask(deps, request.next)
    if ('error' in picked) return picked
    ref = picked.ref
  }
  if (ref && LAB_RE.test(ref)) {
    const read = await readLabSubject(deps, labInstance, ref)
    if ('error' in read) return read
    const { subject } = read
    return { ref, goal: `${ref}: ${subject.title}`, prompt: labSubjectPrompt(subject, labInstance) }
  }
  if (!ref || !CAIRN_RE.test(ref)) return { error: failed('usage', `--from-cairn must look like DROVE-5 or LAB-21; got "${request.cairn ?? ''}"`) }
  const read = await readCairnTask(deps, ref)
  if ('missing' in read) return { error: failed('no-task', `Cairn task ${ref} does not exist (${read.missing})`) }
  if ('skipped' in read) return { error: failed('cairn', `could not read Cairn task ${ref}: ${read.skipped}`) }
  const { task } = read
  if (CAIRN_CLOSED.includes(task.status)) return { error: failed('task-closed', `Cairn task ${ref} is ${task.status}; pick an open task`) }
  if (!task.title) return { error: failed('cairn', `Cairn task ${ref} has no title to use as a goal`) }
  return { ref, goal: `${ref}: ${task.title}`, prompt: cairnGoalPrompt(ref, task.title, task.body) }
}

const seatLine = (seat: Seat): string => {
  const open = seat.state !== 'closed'
  return `- ${seat.name} (${seat.kind}${seat.cairn ? `, ${seat.cairn}` : ''}): ${open ? `still open, ${seat.state}${seat.sessionId ? ', resumable' : ''}` : 'closed'}; branch ${seat.branch || 'none'}`
}

// DROVE-70: best effort; a run that comes down must never be held up by Cairn.
const reportRunToCairn = async (deps: Deps, run: RunMeta, seats: readonly Seat[], at: string, labInstance: string): Promise<string | undefined> => {
  if (!run.cairn) return undefined
  const open = seats.filter(seat => seat.state !== 'closed')
  const lines = [
    `Drove run ${run.id} was taken down at ${at}.`,
    seats.length ? `Seats (${seats.length - open.length} closed, ${open.length} open):` : 'No seats were spawned.',
    ...seats.map(seatLine),
    open.length ? `Still open: ${open.map(seat => seat.cairn ?? seat.name).join(', ')}. Resume with \`drove up --run ${run.id}\`.` : 'Nothing is left open.',
  ]
  const lab = LAB_RE.test(run.cairn)
  try {
    const argv = lab ? ['cairn', '--instance', labInstance, 'subject', 'note', run.cairn, lines.join('\n')] : ['cairn', 'note', run.cairn, lines.join('\n')]
    const ran = await deps.exec(argv, { timeoutMs: 15_000 })
    if (ran.code === 0) return `Wrote a summary note on the goal ${lab ? 'subject' : 'task'} ${run.cairn}.`
    return `Note: the summary note on ${run.cairn} was not written (cairn exited ${ran.code}: ${clip(`${ran.stderr}\n${ran.stdout}`.replace(cairnPreamble, ''))}).`
  } catch (error) {
    return `Note: the summary note on ${run.cairn} was not written (${messageOf(error)}).`
  }
}

// ---------- detached start (DROVE-95) ----------

type Failed = Extract<CommandResult, { ok: false }>
type OpenedWorkspace = herdr.NewWorkspace
type DetachedPlanner = { state: Seat['state']; name: string; sessionId?: string; attention?: Attention; notes: string[] }

// --detached talks to a herdr server that is already running and never starts one: a server comes with a person's
// session, and its panes are the person's to lose.
const requireHerdrServer = async (deps: Deps): Promise<Failed | undefined> => {
  const probe = await herdr.probeServer(deps.exec)
  if (probe.ok) return undefined
  const why = clip(probe.output) || probe.code
  return failed('herdr-down', `herdr is not reachable (${why}). --detached opens a workspace in a running herdr server and does not start one: start herdr first (HERDR_SOCKET_PATH names its socket when it is not at the default path), then run this again.`) as Failed
}

const openDetachedWorkspace = async (deps: Deps, run: RunMeta, env: Record<string, string>): Promise<OpenedWorkspace | Failed> => {
  const label = `drove · ${basename(run.repo)} · ${herdr.runTag(run.id)}`
  const made = await herdr.run(deps.exec, herdr.workspaceCreateArgv(run.repo, label, { ...env, ...PANE_ENV }))
  const opened = made.ok ? herdr.parseNewWorkspace(made.value) : undefined
  return opened ?? (failed('herdr', `herdr could not open a workspace for run ${run.id}: ${clip(made.ok ? made.value : made.output)}`) as Failed)
}

// The planner is started the way a worker is: into the root pane of the workspace, as a named herdr agent, so the
// watcher, the wake and the board reach it by the pane id the run records.
const startDetachedPlanner = async (deps: Deps, run: RunMeta, spec: LaunchSpec, paneId: string, typedPrompt: string | undefined): Promise<DetachedPlanner | Failed> => {
  const kind = run.planner.kind
  const name = herdr.agentName(run.id, PLANNER_SEAT)
  await awaitShellPrompt(deps, paneId)
  const started = await herdr.retryWhileBusy(deps.exec, herdr.agentStartArgv(name, kind, paneId, spec.argv), BUSY_RETRY_MS)
  if (!started.ok && started.code === 'agent_not_ready') {
    const screen = await herdr.readScreen(deps.exec, paneId, 40, 'visible')
    const dialog = screen.ok ? matchDialog(PLANNER_SEAT, screen.value, deps.clock.now()) : undefined
    const attention: Attention = dialog ?? { seat: PLANNER_SEAT, reason: 'dialog', detail: 'The planner stopped on a startup dialog; answer it in the pane. Drove will not.', at: deps.clock.now().toISOString() }
    await recordEvent(deps, run.id, { type: 'attention', seat: PLANNER_SEAT, data: { reason: attention.reason, detail: attention.detail } })
    return { state: 'blocked', name, attention, notes: typedPrompt ? ['The goal was not typed: the planner is at a dialog. Answer it, then give the planner its goal in the pane.'] : [] }
  }
  const adopted = started.ok ? undefined : await adoptFailedStart(deps, name, kind, paneId)
  if (!started.ok && !adopted) return failed('herdr', `herdr could not start the ${kind} planner in pane ${paneId}: ${clip(started.output)}`) as Failed
  const live = started.ok ? await herdr.getAgent(deps.exec, paneId) : undefined
  const sessionId = (live?.ok ? live.value.sessionId : undefined) ?? adopted?.sessionId
  const notes: string[] = []
  if (typedPrompt) {
    const typed = await herdr.retryWhileBusy(deps.exec, herdr.agentPromptArgv(paneId, typedPrompt, 15_000), BUSY_RETRY_MS)
    if (!typed.ok && !herdr.isPromptUnconfirmed(typed.output)) notes.push(`The goal was not delivered (${clip(typed.output, 160)}); give the planner its goal in the pane.`)
  }
  return { state: adopted ? adopted.state : live?.ok ? stateOfHerdr(live.value.status) : 'working', name, ...(sessionId ? { sessionId } : {}), notes }
}

// A detached start that did not come up leaves nothing half-open: the workspace Drove made is closed, and the run is
// put back as it was (a new run is marked down, so drove up --detached can try it again).
const abandonDetached = async (deps: Deps, run: RunMeta, previous: RunMeta | undefined, failure: Failed, workspaceId?: string): Promise<CommandResult> => {
  if (workspaceId) await herdr.run(deps.exec, herdr.workspaceCloseArgv(workspaceId))
  await saveRun(deps.home, previous ?? { ...run, status: 'down' })
  if (!previous) await recordEvent(deps, run.id, { type: 'run.down', data: { reason: 'detached-start-failed', code: failure.code } })
  return failed(failure.code, `${failure.text}${previous ? '' : ` Run ${run.id} was left down; drove up --run ${run.id} --detached tries it again.`}`)
}

const detachedResult = (run: RunMeta, opened: OpenedWorkspace, started: DetachedPlanner, asJson: boolean, summary: string, extra: Pick<DetachedStart, 'resumed' | 'lost'> = {}): CommandResult => {
  const { kind, model, effort } = run.planner
  const sessionId = started.sessionId ?? run.planner.sessionId
  const data: DetachedStart = {
    run: run.id,
    repo: run.repo,
    status: run.status,
    workspace: opened.workspaceId,
    ...(opened.tabId ? { tab: opened.tabId } : {}),
    planner: { kind, pane: opened.paneId, name: started.name, model, effort, state: started.state, ...(sessionId ? { sessionId } : {}), ...(started.attention ? { attention: { reason: started.attention.reason, detail: started.attention.detail } } : {}) },
    ...(run.goal ? { goal: run.goal } : {}),
    ...(run.cairn ? { cairn: run.cairn } : {}),
    ...extra,
  }
  const blocked = started.attention ? ` The planner is waiting at a dialog (${started.attention.reason}): answer it in pane ${opened.paneId}.` : ''
  const text = `${summary}${blocked}${started.notes.map(note => ` ${note}`).join('')} Poll it with \`drove attention --run ${run.id} --json\` and \`drove roster --run ${run.id} --json\`.`
  return ok(asJson ? JSON.stringify(data, null, 2) : text, data)
}

// ---------- plan ----------

export const plan = async (deps: Deps, request: PlanRequest): Promise<CommandResult> => {
  const isDetached = request.detached === true
  const paneId = isDetached ? undefined : process.env.HERDR_PANE_ID
  if (!isDetached && !paneId) return failed('not-in-herdr', 'drove plan must run inside a herdr pane (HERDR_PANE_ID is unset); --detached opens a workspace of its own instead')
  if (isDetached) {
    const unreachable = await requireHerdrServer(deps)
    if (unreachable) return unreachable
  }
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
  const goalTask = await resolveGoalTask(deps, request, config.labInstance)
  if (goalTask && 'error' in goalTask) return goalTask.error
  const goal = goalTask?.goal ?? request.goal

  let run: RunMeta
  let previous: RunMeta | undefined
  if (request.run) {
    const existing = await loadRun(deps.home, request.run)
    if (!existing) return failed('no-run', `no run named ${request.run}`)
    previous = existing
    run = { ...existing, goal: goal ?? existing.goal, cairn: goalTask?.ref ?? existing.cairn, planner: { ...existing.planner, kind, paneId, model, effort, ...(sessionId ? { sessionId } : { sessionId: undefined }) } }
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
      ...(goal ? { goal } : {}),
      ...(goalTask ? { cairn: goalTask.ref } : {}),
      budget: config.budget,
      planner: { kind, paneId, model, effort, viaMod: false, ...(sessionId ? { sessionId } : {}) },
    }
  }
  await saveRun(deps.home, run)
  await updateRoster(deps.home, run.id, roster => roster)
  if (!isDetached) await recordEvent(deps, run.id, { type: 'run.up', data: { planner: kind, pane: paneId, attached: Boolean(request.run) } })
  if (request.run && goal && goal !== previous?.goal) await recordEvent(deps, run.id, { type: 'goal.set', data: { goal, ...(previous?.goal ? { previous: previous.goal } : {}) } })

  const identity: Identity = { home: deps.home, run: run.id, role: 'planner', seat: PLANNER_SEAT }
  const prompt = goalTask?.prompt ?? request.goal ?? (kind === 'codex' ? SESSIONLESS_PROMPT : undefined)
  // herdr types a launch line into a shell, so a goal with a newline cannot ride in it: it is typed once the planner is up.
  const typedPrompt = isDetached && prompt !== undefined && !isShellSafeArg(prompt) ? prompt : undefined
  const launch = launchRequest(
    deps,
    {
      identity, kind, repo, cwd: repo, model, effort,
      roleText: plannerRole(run, config, kind, await availableTrimsOf(deps, run)),
      initialPrompt: typedPrompt === undefined ? prompt : undefined,
      channel: kind === 'claude' && config.claudeChannel,
      ...(sessionId ? { sessionId } : {}),
    },
    config,
  )
  const spec = specFor(launch)
  if (isDetached) {
    const opened = await openDetachedWorkspace(deps, run, spec.env)
    if ('code' in opened) return abandonDetached(deps, run, previous, opened)
    run = { ...run, planner: { ...run.planner, paneId: opened.paneId } }
    await saveRun(deps.home, run)
    await recordEvent(deps, run.id, { type: 'run.up', data: { planner: kind, pane: opened.paneId, workspace: opened.workspaceId, detached: true, attached: Boolean(request.run) } })
    await writeLaunchFiles(spec)
    const started = await startDetachedPlanner(deps, run, spec, opened.paneId, typedPrompt)
    if ('code' in started) return abandonDetached(deps, run, previous, started, opened.workspaceId)
    return detachedResult(run, opened, started, request.json === true, `Run ${run.id} is up in its own herdr workspace ${opened.workspaceId}; the ${kind} planner is ${started.state}${goalTask ? ` on ${LAB_RE.test(goalTask.ref) ? 'Lab subject' : 'Cairn task'} ${goalTask.ref}` : ''}.`)
  }
  await writeLaunchFiles(spec)
  return ok(`Run ${run.id} is up; starting the ${kind} planner${goalTask ? ` on ${LAB_RE.test(goalTask.ref) ? 'Lab subject' : 'Cairn task'} ${goalTask.ref}` : ''}.`, { argv: execArgv(spec), env: spec.env, cwd: spec.cwd } satisfies ProcessPlan)
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
  const badMcp = request.mcp?.find(name => !MCP_NAME_RE.test(name))
  if (badMcp !== undefined) return failed('usage', `--mcp takes server names separated by commas; got "${badMcp}"`)
  const badPlugin = request.plugins?.find(name => !MCP_NAME_RE.test(name))
  if (badPlugin !== undefined) return failed('usage', `--plugins takes plugin names separated by commas; got "${badPlugin}"`)
  if (request.userMemory !== undefined && typeof request.userMemory !== 'boolean') return failed('usage', '--user-memory must be on or off')
  const role = request.role ?? 'implementer'
  if (!SEAT_ROLES.includes(role)) return failed('usage', `--role must be one of ${SEAT_ROLES.join(', ')}; got "${String(role)}"`)
  const isReview = role !== 'implementer'
  if (isReview && !request.target) return failed('usage', `a ${role} needs --target <seat>: the seat it ${role === 'reviewer' ? 'reviews' : 'tests'}`)
  if (!isReview && request.target) return failed('usage', '--target applies to a reviewer or tester seat; give --role reviewer or --role tester')
  if (request.target && (!SEAT_RE.test(request.target) || request.target === PLANNER_SEAT || request.target === request.seat)) return failed('usage', `--target must name another seat of this run; got "${request.target}"`)
  if (role === 'reviewer' && ownsOf(request.owns)) return failed('usage', 'a reviewer is read-only, so --owns does not apply to it')
  const owns = ownsOf(request.owns) ?? (role === 'tester' ? [...TESTER_OWNS] : undefined)
  const badOwns = owns?.find(glob => glob.startsWith('/') || glob.startsWith('~') || glob.split('/').includes('..'))
  if (badOwns !== undefined) return failed('usage', `--owns takes globs relative to the worktree, without .. or a leading / or ~; got "${badOwns}"`)
  const badBudget = [['--max-turns', request.maxTurns], ['--max-tokens', request.maxTokens]].find(([, value]) => value !== undefined && !isWhole(value))
  if (badBudget) return failed('usage', `${badBudget[0]} must be a whole number of at least 1`)
  const brief = request.brief.trim()
  if (!brief) return failed('usage', 'a worker needs a brief')
  const located = await locateFor(deps, identity, 'up')
  if ('error' in located) return located.error
  const { run } = located
  if (run.status !== 'up') return failed('run-down', `run ${run.id} is down; start it with \`drove up\``)
  const cairnCheck = request.cairn ? await checkSpawnCairn(deps, request.cairn) : {}
  if ('error' in cairnCheck) return cairnCheck.error
  const targetSeat = request.target ? findSeat(await loadRoster(deps.home, run.id), request.target) : undefined
  if (request.target && !targetSeat) return failed('no-seat', `--target ${request.target}: no seat of run ${run.id} has that name (a reviewer or tester works on a seat that exists)`)
  if (targetSeat?.role === 'reviewer') return failed('usage', `--target ${targetSeat.name} is a reviewer, which changes nothing: target the seat it reviewed`)
  if (role === 'tester' && targetSeat && !(await git.branchExists(deps.exec, run.repo, targetSeat.branch))) return failed('git', `--target ${targetSeat.name}: its branch ${targetSeat.branch} does not exist, so a tester has nothing to branch from`)

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
    name: request.seat, kind, ...(request.cairn ? { cairn: request.cairn } : {}), ...(request.mcp ? { mcp: [...new Set(request.mcp)] } : {}),
    ...(request.plugins ? { plugins: [...new Set(request.plugins)] } : {}), ...(request.userMemory !== undefined ? { userMemory: request.userMemory } : {}),
    ...(isReview && request.target ? { role, target: request.target } : {}),
    ...(owns ? { owns } : {}), model, effort, worktree, branch,
    ...(request.maxTurns ?? config.maxTurns ? { maxTurns: request.maxTurns ?? config.maxTurns } : {}), ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
    state: 'starting', stateAt: iso, spawnedAt: iso, owes: 'none', attention: [], ...(sessionId ? { sessionId } : {}),
    ...(isClaude ? {} : { codexHome: codexHomeDir(deps.home, run.id) }),
  }

  const clash = await heldByAnotherRun(deps, run, seat)
  if (clash) return failed('seat-taken', clash)

  const otherSlots = await slotsOfOtherRuns(deps, run.id)
  try {
    await updateRoster(deps.home, run.id, roster => {
      const existing = findSeat(roster, seat.name)
      if (existing && !['closed', 'gone', 'down'].includes(existing.state)) throw new SeatTaken(`a seat named ${seat.name} is already open; pick another name or message it`)
      if (isOverBudget(roster, run.budget)) throw new OverBudget(`the pane budget of ${run.budget} is full; ask the human to run \`drove budget ${run.budget + 1}\``)
      seat.slot = freeSlot([...otherSlots, ...openSeats(roster).filter(entry => entry.name !== seat.name).map(entry => entry.slot)])
      return upsertSeat(roster, seat)
    })
  } catch (error) {
    if (error instanceof SeatTaken) return failed('seat-taken', error.message)
    if (error instanceof OverBudget) {
      // DROVE-96: a request for a pane over the budget is the human's to grant; `drove attention` lists it until then.
      const open = openSeats(await loadRoster(deps.home, run.id)).length
      const wanted = run.budget + 1
      await recordEvent(deps, run.id, { type: 'attention', seat: seat.name, data: { reason: PANE_BUDGET_REASON, open, budget: run.budget, wanted, kind, detail: `${seat.name} (${kind}) needs pane ${wanted}, over the pane budget of ${run.budget}` } })
      return failed('over-budget', error.message)
    }
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

  const baseNotes: string[] = cairnCheck.note ? [cairnCheck.note] : []
  let claudeBase: string | undefined
  let baseUsed: string | undefined
  // A tester starts from the head of its target's branch, not from the run base (DROVE-91).
  const testerBase = role === 'tester' ? targetSeat?.branch : undefined
  try {
    if (testerBase && targetSeat) {
      baseNotes.push(`${seat.name} branches from the head of ${testerBase}, the branch of ${targetSeat.name}${request.base ? `; --base ${request.base} was ignored` : ''}.`)
      if (await git.hasUncommitted(deps.exec, targetSeat.worktree)) baseNotes.push(`${targetSeat.name} has uncommitted changes in ${targetSeat.worktree}, which ${seat.name}'s branch does not hold: have ${targetSeat.name} commit first (approve it), or the tester tests the code as of its last commit.`)
    }
    if (isClaude) {
      isWorktreeNew = !existsSync(worktree)
      const wanted = await git.baseRef(deps.exec, run.repo, run.base)
      const resolved = await git.freshestBase(deps.exec, run.repo, wanted)
      claudeBase = testerBase ?? resolved.ref
      baseUsed = resolved.ref
      if (request.base && !testerBase) baseNotes.push(`--base ${request.base} was ignored: Claude creates its own worktree, which Drove then fast-forwards to the run base ${claudeBase}.`)
      if (resolved.ahead && !testerBase) baseNotes.push(`The base used was ${resolved.ref}, the local branch ahead of ${wanted}.`)
      if (resolved.note && !testerBase) baseNotes.push(resolved.note)
    } else if (!existsSync(worktree)) {
      const wanted = await git.baseRef(deps.exec, run.repo, request.base ?? run.base)
      const resolved = await git.freshestBase(deps.exec, run.repo, wanted)
      baseUsed = resolved.ref
      await git.addWorktree(deps.exec, run.repo, worktree, branch, testerBase ?? resolved.ref)
      if (resolved.ahead && !testerBase) baseNotes.push(`The base used was ${resolved.ref}, the local branch ahead of ${wanted}.`)
      if (resolved.note && !testerBase) baseNotes.push(resolved.note)
      isWorktreeNew = true
    }
  } catch (error) {
    await rollback(undefined, undefined)
    return failed('git', messageOf(error))
  }

  const copyPlan = config.workerCopy ? await planCopy(deps.exec, run.repo, config.workerCopy) : undefined
  if (copyPlan) {
    baseNotes.push(...copyNotes({ files: [], refused: copyPlan.refused }))
    if (!isClaude && existsSync(worktree)) baseNotes.push(...copyNotes({ files: [], refused: [] }, await applyCopy(run.repo, worktree, copyPlan.files)))
  }
  const ports = portEnv(config.workerPorts, seat.slot)
  if (config.workerPorts && !ports.PORT) baseNotes.push(`workerPorts: slot ${seat.slot} is past port 65535, so ${seat.name} got no PORT.`)

  const token = mintToken()
  await writeToken(join(seatDir(deps.home, run.id, seat.name), 'token'), token)
  const workerIdentity = identityOfSeat(deps, run, seat, token)
  const isBriefInline = isShellSafeArg(brief.trim())
  const footerTarget = targetSeat
    ? { seat: targetSeat.name, branch: targetSeat.branch, worktree: targetSeat.worktree, base: baseUsed ?? run.base, briefFile: join(seatDir(deps.home, run.id, targetSeat.name), 'brief.md') }
    : undefined
  const footerText = briefFooter(seat.name, request.cairn, {
    branch,
    verify: await repoVerifyCommands(run.repo),
    ...(isReview && footerTarget ? { role, target: footerTarget } : {}),
    ...(config.workerPorts && ports.PORT ? { ports: { port: Number(ports.PORT), count: config.workerPorts.stride } } : {}),
    ...(copyPlan && copyPlan.files.length > 0 ? { copied: copyPlan.files } : {}),
  })
  const briefText = isBriefInline ? `${brief.trim()} ${footerText.trimStart()}` : `${brief}${footerText}`
  const isViaPrompt = resolveBriefVia(config) === 'prompt' || !isShellSafeArg(briefText)
  const initialPrompt = isViaPrompt ? undefined : briefText
  await saveBrief(deps, run.id, seat.name, briefText)
  const extras = await launchExtrasOf(deps, run, config, seat)
  if (extras.unknownPlaceholders.length > 0) baseNotes.push(`workerEnv has placeholders Drove does not know, left as written: ${extras.unknownPlaceholders.join(', ')}. Known: {seat}, {run}, {slot}${config.workerPorts ? ', {port}' : ' and {port} (set workerPorts)'}.`)
  baseNotes.push(...missingMcpNote(seat, extras.missing), ...unknownPluginsNote(seat, extras.unknownPlugins), ...claudeOnlyNote(seat))
  const spec = specFor(
    launchRequest(deps, { identity: workerIdentity, kind, repo: run.repo, cwd: launchCwd, model, effort, roleText: seatRoleText(run, config, seat), initialPrompt, ...(sessionId ? { sessionId } : {}), ...extras.parts }, config),
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

  if (isClaude && claudeBase) baseNotes.push(...(await alignClaudeWorktree(deps, worktree, branch, claudeBase)))
  if (isClaude && copyPlan && copyPlan.files.length > 0 && existsSync(worktree)) baseNotes.push(...copyNotes({ files: [], refused: [] }, await applyCopy(run.repo, worktree, copyPlan.files)))

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
    data: { kind, model, effort, pane: paneId, worktree, branch, cairn: request.cairn, ...(isReview ? { role, target: request.target } : {}), ...(adopted && !started.ok ? { ...(started.code === 'timeout' ? { startTimeout: true } : { startError: started.code }) } : {}), ...(baseNotes.length > 0 ? { notes: baseNotes } : {}) },
  })
  const via = isViaPrompt ? await queueBrief(deps, run, seat.name, briefText) : 'launch-arg'
  if (!isViaPrompt) await recordEvent(deps, run.id, { type: 'control.sent', seat: seat.name, data: { kind: 'brief', via: 'launch-arg' } })
  return ok(`${isReview ? `${role === 'reviewer' ? 'Reviewer' : 'Tester'}` : 'Worker'} ${seat.name} (${kind}${model ? ` ${model}` : ''} ${effort}${isReview ? `, ${role === 'reviewer' ? 'reviewing' : 'testing'} ${request.target}` : ''}) is running in pane ${paneId}, worktree ${worktree} on branch ${branch}. Brief: ${via}. Its reports will come to you.${startNote ? ` Note: ${startNote}` : ''}${baseNotes.map(note => ` Note: ${note}`).join('')}`, { paneId, worktree, branch })
}

// Claude creates its worktree from origin/main once the agent is up; bring it to the run base before the brief goes in.
const alignClaudeWorktree = async (deps: Deps, worktree: string, branch: string, base: string): Promise<string[]> => {
  for (let waited = 0; !existsSync(worktree) && waited < timing.worktreeWaitMs; waited += timing.pollMs) await sleep(timing.pollMs)
  if (!existsSync(worktree)) return [`Claude's worktree ${worktree} did not appear within ${Math.round(timing.worktreeWaitMs / 1000)}s, so ${branch} was not moved to ${base}; run \`git merge --ff-only ${base}\` in it if the base matters.`]
  const moved = await git.fastForwardToBase(deps.exec, worktree, base)
  switch (moved.outcome) {
    case 'at-base': return []
    case 'fast-forwarded': return [`Claude created ${branch} at ${moved.from}, behind ${base}; it was fast-forwarded to ${moved.to}.`]
    case 'diverged': return [`Claude created ${branch} at ${moved.head}, which is not an ancestor of ${base}, so it was left as is; merge or rebase ${base} in the worktree if the base matters.`]
    case 'failed': return [`Claude created ${branch} at ${moved.head} and fast-forwarding it to ${base} failed (${moved.error}), so it was left as is.`]
  }
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
  return 'unconfirmed' in delivery && delivery.unconfirmed ? `${delivery.via} (typed; herdr did not confirm the agent took it within its wait and no prompt hook record followed, which a long first turn explains)` : delivery.via
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
    const controlText = formatControl(control, token)
    const isInline = resolveBriefVia(config) === 'launch-arg' && isShellSafeArg(controlText)
    const spec = specFor(
      launchRequest(deps, { identity: identityOfSeat(deps, run, seat, token), kind: seat.kind, repo: run.repo, cwd: seat.worktree, model, effort: request.effort, roleText: seatRoleText(run, config, seat), resumeId: sessionId, ...(isInline ? { initialPrompt: controlText } : {}), ...(await launchExtrasOf(deps, run, config, seat)).parts }, config),
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
    const typedAt = deps.clock.now().getTime()
    const typed = isInline ? undefined : await herdr.retryWhileBusy(deps.exec, herdr.agentPromptArgv(paneId, controlText), BUSY_RETRY_MS)
    const via: Transport = isInline ? 'launch-arg' : 'herdr-prompt'
    if (typed && !typed.ok && typed.code !== 'timeout') {
      await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...updated, state: 'idle', owes: 'none', hasNudged: false }))
      return failed('delivery', `${seat.name} restarted on ${model || 'the default model'} at ${request.effort} effort, but herdr could not type the ${control.kind} notice into it: ${clip(typed.output)}`)
    }
    await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...updated, state: 'working', lastWorkingAt: deps.clock.now().toISOString(), owes: 'none', hasNudged: false }))
    const isUnconfirmed = typed !== undefined && !typed.ok && !(await confirmedByHook(deps, run.id, seat, typedAt))
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

// ---------- migrate ----------

const HANDOFF_LINES = 40
const HANDOFF_REPORTS = 3

export type Handoff = { from: AgentKind; reason?: string; brief?: string; base: string; log: string; diffStat: string; status: string; reports: readonly string[] }

export const handoffText = (handoff: Handoff): string => `You replace a ${handoff.from} worker that hit its usage limit (or was migrated); its turn in flight is lost.${handoff.reason ? ` Reason: ${handoff.reason}.` : ''} You keep its worktree, its branch and its Cairn task. Read what it left below, check the worktree, then carry on with the brief.

## The brief it was given
${handoff.brief ?? '(none saved: this seat was spawned before Drove saved briefs; ask the planner for it with a question report)'}

## Its commits (git log --oneline ${handoff.base}..HEAD)
${handoff.log || '(none)'}

## Uncommitted changes (git diff --stat HEAD)
${handoff.diffStat || '(none)'}

## git status --short
${handoff.status || '(clean)'}

## Its last reports
${handoff.reports.length > 0 ? handoff.reports.join('\n') : '(none)'}`

const firstLines = (text: string): string => {
  const lines = text.split('\n')
  return lines.length > HANDOFF_LINES ? [...lines.slice(0, HANDOFF_LINES), `… ${lines.length - HANDOFF_LINES} more lines`].join('\n') : text
}

const gitOutput = async (deps: Deps, worktree: string, args: readonly string[]): Promise<string> => {
  const ran = await deps.exec(['git', '-C', worktree, ...args], { timeoutMs: 30_000 })
  return ran.code === 0 ? firstLines(ran.stdout.trimEnd()) : `(git ${args.join(' ')} failed: ${clip(ran.stderr || ran.stdout, 200)})`
}

const reportLine = (report: Report): string => `- ${report.at} ${report.kind} (expects ${report.expects}): ${report.summary}${report.details ? `\n  ${clip(report.details, 600)}` : ''}`

const ROLE_START = '# Worker mode'
const ROLE_END = 'says how to reply.'

// A Codex brief saved before DROVE-72 carries the worker role in front. The new agent gets the role its own way, so it is cut.
const briefOf = (saved: string): string => {
  const end = saved.indexOf(ROLE_END)
  return saved.startsWith(ROLE_START) && end >= 0 ? saved.slice(end + ROLE_END.length).trim() : saved
}

const gatherHandoff = async (deps: Deps, run: RunMeta, seat: Seat, reason: string | undefined): Promise<Handoff> => {
  const dir = seatDir(deps.home, run.id, seat.name)
  const brief = briefOf((await readFile(join(dir, 'brief.md'), 'utf8').catch(() => '')).trim())
  const log = await gitOutput(deps, seat.worktree, ['log', '--oneline', `${run.base}..HEAD`])
  const diffStat = await gitOutput(deps, seat.worktree, ['diff', '--stat', 'HEAD'])
  const status = await gitOutput(deps, seat.worktree, ['status', '--short'])
  const reports = (await readJsonlFrom<Report>(join(dir, 'outbox.jsonl'), { offset: 0 })).items.slice(-HANDOFF_REPORTS).map(reportLine)
  return { from: seat.kind, ...(reason ? { reason } : {}), ...(brief ? { brief } : {}), base: run.base, log, diffStat, status, reports }
}

// A conversation cannot move between Claude Code and Codex, but the work can (DROVE-69): the seat keeps its name, worktree,
// branch, token and Cairn task, and the other kind starts fresh in that worktree with a handoff brief. A Claude seat runs
// from the worktree without --worktree: Claude keys folder trust by the canonical git root, which for a linked worktree
// is the main repo (Claude Code 2.1.296), so a Drove-made worktree of a trusted repo is trusted.
export const migrate = async (deps: Deps, identity: Identity, request: MigrateRequest): Promise<CommandResult> => {
  const denied = requirePlanner(identity)
  if (denied) return denied
  if (request.kind !== 'claude' && request.kind !== 'codex') return failed('usage', '--kind must be claude or codex')
  if (request.effort && !EFFORTS.includes(request.effort)) return failed('usage', `--effort must be one of ${EFFORTS.join(', ')}`)
  const located = await locateFor(deps, identity, 'up')
  if ('error' in located) return located.error
  const { run } = located
  if (run.status !== 'up') return failed('run-down', `run ${run.id} is down; start it with \`drove up\``)
  const config = await loadConfig(deps.home)
  const seat = findSeat(await loadRoster(deps.home, run.id), request.seat)
  if (!seat || ['closed', 'closing', 'down'].includes(seat.state)) return failed('no-seat', `no open seat named ${request.seat}`)
  if (seat.kind === request.kind) return failed('usage', `${seat.name} is already a ${seat.kind} worker; use promote to change its model or effort`)
  if (!existsSync(seat.worktree)) return failed('no-worktree', `${seat.name}'s worktree ${seat.worktree} is missing, so there is nothing to hand over; close the seat and spawn a new worker`)
  const token = await readToken(join(seatDir(deps.home, run.id, seat.name), 'token'))
  if (!token) return failed('no-token', `no token for ${seat.name}`)

  const kind = request.kind
  const model = resolveModel(kind, request.model, config)
  const effort = request.effort ?? seat.effort
  const iso = deps.clock.now().toISOString()
  const oldSession = seat.sessionId ?? (await hookSessionId(deps, run.id, seat.name))
  const briefText = handoffText(await gatherHandoff(deps, run, seat, request.reason))
  const before = await markRestarting(deps, run.id, seat.name)
  try {
    const stop = await stopAgent(deps, seat, timing.exitWaitMs)
    if (!stop.stopped) {
      await restoreState(deps, run.id, seat.name, before)
      return failed('restart', `${seat.name} did not stop after ${seat.kind === 'claude' ? 'its pane was closed' : '/quit'}${stop.detail ? ` (${stop.detail})` : ''}. Check the pane.`)
    }
    if (seat.paneId && !stop.paneClosed) {
      const closed = await herdr.run(deps.exec, herdr.paneCloseArgv(seat.paneId))
      if (!closed.ok && !isPaneMissing(closed)) {
        await restoreState(deps, run.id, seat.name, before)
        return failed('herdr', `${seat.name} stopped but herdr could not close pane ${seat.paneId}: ${clip(closed.output)}`)
      }
    }
    const notes = [
      seat.kind === 'claude' ? await releaseStaleLock(deps, run, seat) : undefined,
      seat.cairn ? await releaseCairnClaim(deps, seat.cairn) : undefined,
    ].filter((note): note is string => Boolean(note))

    const { sessionId: _session, codexHome: _home, pendingPromote: _pending, restartingSince: _since, ...kept } = seat
    const sessionId = kind === 'claude' ? randomUUID() : undefined
    const migrated: Seat = {
      ...kept, kind, model, effort, state: 'starting', stateAt: iso, owes: 'none', hasNudged: false, attention: [],
      ...(sessionId ? { sessionId } : {}),
      ...(kind === 'codex' ? { codexHome: codexHomeDir(deps.home, run.id) } : {}),
      migratedFrom: { kind: seat.kind, ...(oldSession ? { sessionId: oldSession } : {}), model: seat.model, at: iso, ...(request.reason ? { reason: request.reason } : {}) },
    }
    const workerIdentity = identityOfSeat(deps, run, migrated, token)
    const extras = await launchExtrasOf(deps, run, config, migrated)
    notes.push(...missingMcpNote(migrated, extras.missing), ...unknownPluginsNote(migrated, extras.unknownPlugins), ...claudeOnlyNote(migrated))
    const spec = specFor(
      launchRequest(deps, { identity: workerIdentity, kind, repo: run.repo, cwd: seat.worktree, model, effort, roleText: seatRoleText(run, config, migrated), inWorktree: true, ...(sessionId ? { sessionId } : {}), ...extras.parts }, config),
    )
    await writeLaunchFiles(spec)
    await writeLaunchJson(deps, run.id, seat.name, spec)

    const lost = async (why: string): Promise<void> => {
      const at = deps.clock.now().toISOString()
      const detail = `migrate to ${kind} failed (${clip(why, 160)}); \`drove up --seat ${seat.name}\` resumes the ${seat.kind} session, or run \`drove migrate\` again`
      await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...kept, ...(oldSession ? { sessionId: oldSession } : {}), ...(seat.codexHome ? { codexHome: seat.codexHome } : {}), paneId: undefined, state: 'gone', stateAt: at, attention: [{ seat: seat.name, reason: 'gone', detail, at }] }))
    }
    const others = openSeats(await loadRoster(deps.home, run.id)).filter(entry => entry.name !== seat.name && entry.paneId)
    const placement = await placePane(deps, run, others, seat.worktree, spec.env)
    if (!isPlacement(placement)) {
      await lost(placement.text)
      return failed('migrate', `${seat.name} stopped but no pane could be placed for ${kind}: ${clip(placement.text)}. \`drove up --seat ${seat.name}\` resumes the ${seat.kind} session.`)
    }
    const { started, adopted, paneId } = await startWithRetry(deps, run, {
      seat: seat.name, kind, argv: spec.argv, paneId: placement.paneId, ...(placement.createdTab ? { createdTab: placement.createdTab } : {}),
      place: () => placePane(deps, run, others, seat.worktree, spec.env),
    })
    const event = { from: seat.kind, to: kind, model, effort, pane: paneId, worktree: seat.worktree, branch: seat.branch, ...(request.reason ? { reason: request.reason } : {}) }

    if (!started.ok && started.code === 'agent_not_ready') {
      const screen = await herdr.readScreen(deps.exec, paneId, 40, 'visible')
      const at = deps.clock.now().toISOString()
      const attention = (screen.ok ? matchDialog(seat.name, screen.value, deps.clock.now()) : undefined) ?? { seat: seat.name, reason: 'dialog' as const, detail: 'The agent stopped on a startup dialog; answer it in the pane. Drove will not.', at }
      await updateRoster(deps.home, run.id, roster => upsertSeat(roster, { ...migrated, paneId, state: 'blocked', stateAt: at, attention: [attention] }))
      await recordEvent(deps, run.id, { type: 'seat.migrate', seat: seat.name, data: { ...event, blocked: attention.reason } })
      await queueBrief(deps, run, seat.name, briefText)
      return ok(`${seat.name} moved from ${seat.kind} to ${kind} in pane ${paneId}, but the new agent stopped on a dialog (${attention.reason}): ${attention.detail} The handoff brief is queued.${notes.map(note => ` ${note}`).join('')}`, { state: 'blocked', paneId })
    }
    if (!started.ok && !adopted) {
      const captured = await captureStartFailure(deps, run, seat.name, paneId, started)
      await herdr.run(deps.exec, herdr.paneCloseArgv(paneId))
      await lost(started.output)
      return failed('migrate', `${seat.name} stopped but ${kind} did not start: ${clip(started.output)}.${hintText(captured)} \`drove up --seat ${seat.name}\` resumes the ${seat.kind} session.`)
    }

    const live = started.ok ? await herdr.getAgent(deps.exec, paneId) : undefined
    const liveSession = (live?.ok ? live.value.sessionId : undefined) ?? adopted?.sessionId
    await updateRoster(deps.home, run.id, roster =>
      upsertSeat(roster, { ...migrated, paneId, state: adopted ? adopted.state : 'idle', stateAt: deps.clock.now().toISOString(), ...(liveSession && !sessionId ? { sessionId: liveSession } : {}) }),
    )
    await recordEvent(deps, run.id, { type: 'seat.migrate', seat: seat.name, data: event })
    const via = await queueBrief(deps, run, seat.name, briefText)
    return ok(`${seat.name} moved from ${seat.kind} to ${kind}${model ? ` ${model}` : ''} ${effort} in pane ${paneId}, worktree ${seat.worktree} on branch ${seat.branch}. Handoff brief: ${via}.${notes.map(note => ` ${note}`).join('')}`, { paneId, kind, branch: seat.branch })
  } finally {
    await clearRestarting(deps, run.id, seat.name)
  }
}

// ---------- init ----------

export const INITIAL_COMMIT = 'chore: initial empty commit'

export const initRepo = async (deps: Deps, dir: string, cwd: string, asJson: boolean): Promise<CommandResult> => {
  const target = resolve(cwd, dir)
  const entries = await readdir(target).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : error))
  if (entries instanceof Error) return failed('INIT_NOT_A_DIRECTORY', `${target} is not a directory`)
  if (entries !== undefined && entries.length > 0) {
    return failed('INIT_NOT_EMPTY', `${target} is ${entries.includes('.git') ? 'already a git repository' : 'not empty'}: drove init only makes a new repo in an empty or missing directory`)
  }
  let probe = entries === undefined ? dirname(target) : target
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  const enclosing = await git.toplevel(deps.exec, probe)
  if (enclosing) return failed('INIT_INSIDE_REPO', `${target} is inside the git repository ${enclosing}: pick a directory outside it`)
  await mkdir(target, { recursive: true })
  const made = await deps.exec(['git', '-C', target, 'init', '-b', 'main'], { timeoutMs: 30_000 })
  if (made.code !== 0) return failed('INIT_GIT_FAILED', `git init failed: ${(made.stderr || made.stdout).trim().slice(0, 300)}`)
  const committed = await deps.exec(['git', '-C', target, 'commit', '--allow-empty', '-m', INITIAL_COMMIT], { timeoutMs: 30_000 })
  if (committed.code !== 0) return failed('INIT_COMMIT_FAILED', `git commit failed in ${target}: ${(committed.stderr || committed.stdout).trim().slice(0, 300)}`)
  const sha = (await deps.exec(['git', '-C', target, 'rev-parse', '--short', 'HEAD'], { timeoutMs: 10_000 })).stdout.trim()
  const data = { path: target, branch: 'main', commit: sha }
  return ok(asJson ? JSON.stringify(data, null, 2) : `Created ${target} on main with one empty commit (${sha}). Attach the run there: /orchestrate --repo ${target}, or drove plan from that directory.`, data)
}

// ---------- roster / capture ----------

export const roster = async (deps: Deps, ref: RunRef, asJson: boolean): Promise<CommandResult> => {
  const located = await locateRun(deps, ref, 'up')
  if ('error' in located) return located.error
  const { run } = located
  if (run.status === 'up') await refreshRoster(deps, run).catch(() => undefined)
  const current = await loadRoster(deps.home, run.id)
  const attention = attentionOf(current)
  if (asJson) {
    // DROVE-95: what a poller outside the run needs besides the seats: whether the planner's pane is alive, and the
    // latest report any seat sent (each seat's own is in seats[].lastReport).
    const planner = { ...run.planner, ...(await plannerStateOf(deps, run)) }
    const lastReport = current.seats.flatMap(seat => (seat.lastReport ? [{ seat: seat.name, ...seat.lastReport }] : [])).sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null
    const body = { run, seats: current.seats, attention, planner, lastReport, updatedAt: current.updatedAt }
    return ok(JSON.stringify(body, null, 2), { ...body, roster: current })
  }
  const lines = [`run ${run.id} · ${basename(run.repo)} · ${run.status} · budget ${run.budget}`, ...rosterLines(current, deps.clock.now())]
  if (attention.length > 0) lines.push('', 'needs attention:', ...attention.map(item => `- ${item.seat}: ${item.reason} · ${item.detail}`))
  return ok(lines.join('\n'), { run, roster: current, attention })
}

const plannerStateOf = async (deps: Deps, run: RunMeta): Promise<{ state: PlannerState; detail?: string }> => {
  if (run.status === 'down') return { state: 'down' }
  const pane = run.planner.paneId
  if (!pane) return { state: 'gone' }
  const live = await herdr.getAgent(deps.exec, pane)
  if (live.ok) return { state: live.value.status }
  return isPaneMissing(live) ? { state: 'gone' } : { state: 'unreachable', detail: clip(live.output || live.code, 160) }
}

// ---------- attention (DROVE-96) ----------

export type AttentionRequest = { run?: string; all?: boolean; repo: string }

// The roster is kept fresh by the planner's watcher; one that nobody has written lately is refreshed from herdr here.
const ROSTER_FRESH_MS = 10_000

const readEvents = async (deps: Deps, run: string): Promise<DroveEvent[]> =>
  (await readJsonlFrom<DroveEvent>(join(runDir(deps.home, run), 'events.jsonl'), { offset: 0 }).catch(() => ({ items: [] as DroveEvent[] }))).items

const gatherAttention = async (deps: Deps, run: RunMeta): Promise<AttentionItem[]> => {
  const now = deps.clock.now()
  let current = await loadRoster(deps.home, run.id)
  if (run.status === 'up' && now.getTime() - Date.parse(current.updatedAt) > ROSTER_FRESH_MS) {
    await refreshRoster(deps, run).catch(() => undefined)
    current = await loadRoster(deps.home, run.id)
  }
  const owing = current.seats.filter(seat => seat.state !== 'closed' && seat.owes !== 'none')
  const reports = (await Promise.all(owing.map(seat => seatReports(deps, run, seat.name)))).flatMap(list => list.at(-1) ?? [])
  const statuses = await Promise.all(openSeats(current).map(async seat => [seat.name, await readJson<OrchModStatus>(join(seatDir(deps.home, run.id, seat.name), 'mod.json')).catch(() => undefined)] as const))
  const status = Object.fromEntries(statuses.filter((entry): entry is readonly [string, OrchModStatus] => entry[1] !== undefined))
  const probed = run.status === 'up' ? await plannerStateOf(deps, run) : undefined
  let planner: Parameters<typeof attentionCandidates>[0]['planner']
  if (probed && probed.state !== 'unreachable') {
    planner = { state: probed.state }
    if (probed.state === 'blocked' && run.planner.paneId) {
      const screen = await herdr.readPane(deps.exec, run.planner.paneId, 40, 'visible')
      const dialog = screen.ok ? matchDialog(PLANNER_SEAT, screen.value, now) : undefined
      if (dialog) planner = { state: 'blocked', detail: dialog.detail, reason: dialog.reason }
    }
  }
  const candidates = attentionCandidates({ run, roster: current, reports, status, events: await readEvents(deps, run.id), ...(planner ? { planner } : {}), at: now.toISOString() })
  return settleItems(deps.home, run.id, candidates)
}

const attentionRuns = async (deps: Deps, request: AttentionRequest): Promise<RunMeta[] | Failed> => {
  if (request.run && request.all) return failed('usage', '--run and --all are exclusive') as Failed
  if (request.all) {
    const names = await readdir(join(deps.home, 'runs')).catch(() => [] as string[])
    const runs = await Promise.all(names.map(name => loadRun(deps.home, name).catch(() => undefined)))
    return runs.filter((meta): meta is RunMeta => meta?.status === 'up').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  const located = await locateRun(deps, { run: request.run, repo: request.repo }, 'up')
  return 'error' in located ? (located.error as Failed) : [located.run]
}

type AttentionSnapshot = { v: 1; at: string; runs: string[]; items: AttentionItem[] }

const snapshotAttention = async (deps: Deps, request: AttentionRequest): Promise<AttentionSnapshot | Failed> => {
  const runs = await attentionRuns(deps, request)
  if (!Array.isArray(runs)) return runs
  const items = (await Promise.all(runs.map(run => gatherAttention(deps, run)))).flat()
  return { v: 1, at: deps.clock.now().toISOString(), runs: runs.map(run => run.id), items }
}

export const attention = async (deps: Deps, request: AttentionRequest, asJson: boolean): Promise<CommandResult> => {
  const snapshot = await snapshotAttention(deps, request)
  if ('code' in snapshot) return snapshot
  if (asJson) return ok(JSON.stringify(snapshot, null, 2), snapshot)
  const text = snapshot.items.length > 0 ? snapshot.items.map(attentionLine).join('\n') : `Nothing waits on a person${snapshot.runs.length === 0 ? ' (no run is up)' : ''}.`
  return ok(text, snapshot)
}

export type FollowOptions = { pollMs?: number; signal?: AbortSignal; sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void> }

const abortableSleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

// One delta per item that appeared or went away since the last poll; a restarted follower starts from nothing, so it
// prints every open item as new once (ids are stable across processes, so a poller dedupes on them).
export const followAttention = async (deps: Deps, request: AttentionRequest, write: (delta: AttentionDelta) => void, options: FollowOptions = {}): Promise<CommandResult> => {
  const first = await snapshotAttention(deps, request)
  if ('code' in first) return first
  const wait = options.sleep ?? abortableSleep
  let known = new Map<string, AttentionItem>()
  let snapshot: AttentionSnapshot = first
  for (;;) {
    for (const delta of diffItems(known, snapshot.items, deps.clock.now().toISOString())) write(delta)
    known = new Map(snapshot.items.map(item => [item.id, item]))
    if (options.signal?.aborted) return ok('stopped')
    await wait(options.pollMs ?? FOLLOW_POLL_MS, options.signal)
    if (options.signal?.aborted) return ok('stopped')
    const next = await snapshotAttention(deps, request).catch(() => undefined)
    if (next && !('code' in next)) snapshot = next
  }
}

const FOLLOW_POLL_MS = 3_000

export const capture = async (deps: Deps, ref: RunRef, seatName: string, lines: number): Promise<CommandResult> => {
  const located = await locateRun(deps, ref, 'up')
  if ('error' in located) return located.error
  const seat = findSeat(await loadRoster(deps.home, located.run.id), seatName)
  if (!seat) return failed('no-seat', `no seat named ${seatName}`)
  const screen = await herdr.readScreen(deps.exec, herdr.agentTarget(located.run.id, seat), Number.isFinite(lines) && lines > 0 ? lines : 80)
  return screen.ok ? ok(screen.value) : failed('herdr', `could not read ${seat.name}: ${screen.code}`)
}

// ---------- reports ----------

// The planner reads its workers' reports in full here: a wake shows it one line per report. Read ids are kept in the planner's folder.
export type ReportsRequest = { seat?: string; all?: boolean; asJson?: boolean }

const readReportsPath = (home: string, run: string): string => join(plannerDir(home, run), 'reports-read.json')

const seatReports = async (deps: Deps, run: RunMeta, seat: string): Promise<Report[]> => {
  const dir = seatDir(deps.home, run.id, seat)
  const token = await readToken(join(dir, 'token'))
  if (!token) return []
  const { items } = await readJsonlFrom<Partial<Report> | null>(join(dir, 'outbox.jsonl'), { offset: 0 })
  return items.filter((item): item is Report =>
    item?.v === 1 && item.run === run.id && item.seat === seat && item.token === token && typeof item.id === 'string' && typeof item.summary === 'string' && item.kind !== 'progress' && REPORT_KINDS.includes(item.kind as Report['kind']),
  )
}

export const reports = async (deps: Deps, identity: Identity, ref: RunRef, request: ReportsRequest): Promise<CommandResult> => {
  const denied = requirePlanner(identity)
  if (denied) return denied
  const located = await locateRun(deps, ref, 'up')
  if ('error' in located) return located.error
  const { run } = located
  const roster = await loadRoster(deps.home, run.id)
  if (request.seat && !findSeat(roster, request.seat)) return failed('no-seat', `no seat named ${request.seat}`)
  const seats = request.seat ? [request.seat] : roster.seats.map(seat => seat.name)
  const all = (await Promise.all(seats.map(seat => seatReports(deps, run, seat)))).flat().sort((a, b) => a.at.localeCompare(b.at))
  const read = new Set((await readJson<string[]>(readReportsPath(deps.home, run.id))) ?? [])
  const unread = all.filter(report => !read.has(report.id))
  const picked = request.all ? all : unread.length > 0 || !request.seat ? unread : all.slice(-1)
  if (picked.some(report => !read.has(report.id))) await writeJsonAtomic(readReportsPath(deps.home, run.id), [...read, ...picked.filter(report => !read.has(report.id)).map(report => report.id)])
  const shown = picked.map(({ v: _v, token: _token, run: _run, ...rest }) => rest)
  if (request.asJson) return ok(JSON.stringify({ run: run.id, reports: shown }, null, 2), { run: run.id, reports: shown })
  if (picked.length === 0) return ok(request.seat ? `${request.seat} has not reported yet` : 'no unread reports', { run: run.id, reports: shown })
  return ok(renderReports(picked, (await loadConfig(deps.home)).humanName), { run: run.id, reports: shown })
}

// ---------- close ----------

const BENIGN_RELEASE = /nothing was released|claim ownership changed|already (done|released)|is done\b/i
const cairnPreamble = /cairn: [^\n]*could not be checked[^\n]*\n?/gi

const releaseCairnClaim = async (deps: Deps, ref: string): Promise<string | undefined> => {
  try {
    const ran = await deps.exec(['cairn', 'release', ref, '--force'], { timeoutMs: 15_000 })
    if (ran.code === 0) return `Released the Cairn claim on ${ref}.`
    const output = `${ran.stderr}\n${ran.stdout}`.replace(cairnPreamble, '')
    if (BENIGN_RELEASE.test(output)) return undefined
    return `Note: the Cairn claim on ${ref} was not released (cairn exited ${ran.code}: ${clip(output)}); release it by hand.`
  } catch (error) {
    return `Note: the Cairn claim on ${ref} was not released (${messageOf(error)}); release it by hand.`
  }
}

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
  const releaseNote = seat.cairn ? await releaseCairnClaim(deps, seat.cairn) : undefined
  if (releaseNote) notes.push(releaseNote)
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

// ---------- merge: the gate between a worker's branch and the base ----------

const REMOTE = 'origin'
const CHECK_TIMEOUT_MS = 15 * 60_000
const GH_TIMEOUT_MS = 60_000
const TAIL_LINES = 40
const TAIL_CHARS = 4_000
// How long a PR in a repo with workflows may show no checks before it counts as a repo whose CI did not trigger.
export const CI_GRACE_MS = 10 * 60_000
// The checks run for the planner's repo, not as the planner: Drove's own identity must not leak into a test run.
const NO_IDENTITY_ENV = { DROVE_RUN: '', DROVE_ROLE: '', DROVE_SEAT: '', DROVE_TOKEN: '', DROVE_OWNS: '' }

const tailOf = (text: string): string => {
  const lines = text.split('\n').map(line => line.trimEnd())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS)
}

// The base is the source of truth for what the checks are, so a branch cannot loosen its own gate by editing them:
// `checks` in the repo's .drove.json (an empty list declares there are none), else the detected typecheck, lint and test.
export const checksOf = async (repo: string): Promise<{ commands: string[]; source: string }> => {
  const configured = await readJson<{ checks?: unknown }>(join(repo, '.drove.json')).catch(() => undefined)
  if (Array.isArray(configured?.checks)) return { commands: configured.checks.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== ''), source: '.drove.json' }
  return { commands: await repoVerifyCommands(repo), source: 'package.json scripts or Makefile targets' }
}

type CheckRun = { ok: true } | { ok: false; command: string; code: number; output: string }

const runChecks = async (deps: Deps, worktree: string, commands: readonly string[]): Promise<CheckRun> => {
  for (const command of commands) {
    const ran = await deps.exec(['sh', '-c', command], { cwd: worktree, timeoutMs: CHECK_TIMEOUT_MS, env: NO_IDENTITY_ENV })
    if (ran.code !== 0) return { ok: false, command, code: ran.code, output: tailOf(`${ran.stdout}\n${ran.stderr}`) }
  }
  return { ok: true }
}

type GhPr = { number: number; url: string; state: string; createdAt: string; mergeable: string; reviewDecision: string }
type GhCheck = { name: string; bucket: string; link: string }

const gh = (deps: Deps, repo: string, args: readonly string[]): Promise<ExecResult> => deps.exec(['gh', ...args], { cwd: repo, timeoutMs: GH_TIMEOUT_MS })

const ghJson = <T>(result: ExecResult): T | undefined => {
  try {
    return JSON.parse(result.stdout) as T
  } catch {
    return undefined
  }
}

const viewPr = async (deps: Deps, repo: string, branch: string): Promise<GhPr | undefined> => {
  const viewed = await gh(deps, repo, ['pr', 'view', branch, '--json', 'number,url,state,createdAt,mergeable,reviewDecision'])
  const pr = viewed.code === 0 ? ghJson<Partial<GhPr>>(viewed) : undefined
  if (!pr || typeof pr.number !== 'number' || typeof pr.url !== 'string') return undefined
  return { number: pr.number, url: pr.url, state: pr.state ?? '', createdAt: pr.createdAt ?? '', mergeable: pr.mergeable ?? '', reviewDecision: pr.reviewDecision ?? '' }
}

// Only a PR's own checks are read: `gh pr checks` exits 1 for failed ones and 8 for pending, so its JSON is read whatever the code.
const prChecks = async (deps: Deps, repo: string, number: number): Promise<GhCheck[] | { error: string }> => {
  const ran = await gh(deps, repo, ['pr', 'checks', String(number), '--json', 'name,bucket,link'])
  const parsed = ghJson<GhCheck[]>(ran)
  if (Array.isArray(parsed)) return parsed
  if (/no checks reported/i.test(`${ran.stderr}\n${ran.stdout}`)) return []
  return { error: clip(ran.stderr || ran.stdout || `gh exited ${ran.code}`) }
}

const hasWorkflows = async (...dirs: string[]): Promise<boolean> => {
  for (const dir of dirs) {
    const files = await readdir(join(dir, '.github', 'workflows')).catch(() => [] as string[])
    if (files.some(file => /\.ya?ml$/.test(file))) return true
  }
  return false
}

const gateText = (checks: readonly string[], source: string): string => (checks.length > 0 ? `checks passed: ${checks.join(', ')}` : `no local checks (${source})`)

export const merge = async (deps: Deps, identity: Identity, ref: RunRef, request: MergeRequest): Promise<CommandResult> => {
  const denied = requirePlanner(identity)
  if (denied) return denied
  if (request.noChecks && identity.run) return failed('forbidden', '--no-checks is for the human: run drove merge --no-checks from your own terminal (pass --run ID), not from a Drove session')
  if (request.squash && !request.pr) return failed('usage', '--squash applies to --pr only: a local merge is always a merge commit')
  const located = await locateRun(deps, { run: ref.run ?? (identity.run || undefined), repo: ref.repo }, 'up')
  if ('error' in located) return located.error
  const { run } = located
  const seat = findSeat(await loadRoster(deps.home, run.id), request.seat)
  if (!seat) return failed('no-seat', `no seat named ${request.seat}`)

  const mode = request.pr ? 'pr' : 'local'
  const base = run.base.replace(/^origin\//, '')
  const settle = async (event: 'merge.passed' | 'merge.refused' | 'merge.pending', detail: string, data: Record<string, unknown> = {}): Promise<void> => {
    const at = deps.clock.now().toISOString()
    await updateRoster(deps.home, run.id, current => ({
      ...current,
      seats: current.seats.map(entry => (entry.name === seat.name ? { ...entry, gate: { result: event.slice('merge.'.length) as MergeGate['result'], at, detail: clip(detail, 160) } } : entry)),
    }))
    await recordEvent(deps, run.id, { type: event, seat: seat.name, data: { mode, branch: seat.branch, base, detail: clip(detail, 300), ...data } })
  }
  const refuse = async (code: string, text: string, data: Record<string, unknown> = {}): Promise<CommandResult> => {
    await settle('merge.refused', text, { code, ...data })
    return failed(code, text)
  }

  if (seat.branch === base || seat.branch === git.PROTECTED_BRANCH) return refuse('bad-branch', `${seat.name}'s branch ${seat.branch} is the base or a protected branch, so there is nothing to merge`)
  if (!(await git.refExists(deps.exec, run.repo, `refs/heads/${seat.branch}`))) return refuse('no-branch', `branch ${seat.branch} does not exist in ${run.repo}`)
  if (!existsSync(seat.worktree)) return refuse('no-worktree', `${seat.name}'s worktree ${seat.worktree} is gone, so its checks cannot run`)
  if (await git.isMerged(deps.exec, run.repo, seat.branch, base)) return ok(`${seat.branch} is already merged into ${base}; nothing to do. Close ${seat.name} with drove close.`, { status: 'merged', mode })
  const unsaved = await git.dirtyLines(deps.exec, seat.worktree)
  if (unsaved.length > 0) return refuse('dirty-worktree', `${seat.name}'s worktree has uncommitted changes, which the merge would not carry and the checks would run on: ${unsaved.slice(0, 5).join('; ')}. Have the worker commit or discard them.`)

  const plan = request.noChecks ? { commands: [] as string[], source: '--no-checks' } : await checksOf(run.repo)
  if (!request.noChecks && plan.commands.length === 0 && plan.source !== '.drove.json') {
    return refuse('no-checks', `no checks are defined for ${run.repo}: add a "checks" list to its .drove.json (an empty list says there are none), or a typecheck, lint or test script. The human can pass --no-checks.`)
  }
  const check = async (): Promise<CommandResult | undefined> => {
    const result = await runChecks(deps, seat.worktree, plan.commands)
    if (result.ok) return undefined
    return refuse('checks-failed', `merge refused: "${result.command}" failed (exit ${result.code}) in ${seat.worktree}. Last output:\n${result.output || '(no output)'}`, { check: result.command, exitCode: result.code })
  }

  if (!request.pr) return mergeLocal(deps, run, seat, base, request, plan, check, settle, refuse)
  return mergePr(deps, run, seat, base, request, plan, check, settle, refuse)
}

type Gate = {
  settle: (event: 'merge.passed' | 'merge.refused' | 'merge.pending', detail: string, data?: Record<string, unknown>) => Promise<void>
  refuse: (code: string, text: string, data?: Record<string, unknown>) => Promise<CommandResult>
}

const mergeLocal = async (
  deps: Deps, run: RunMeta, seat: Seat, base: string, request: MergeRequest, plan: { commands: string[]; source: string },
  check: () => Promise<CommandResult | undefined>, settle: Gate['settle'], refuse: Gate['refuse'],
): Promise<CommandResult> => {
  const head = await git.headBranch(deps.exec, run.repo)
  if (head !== base) return refuse('wrong-branch', `the main checkout ${run.repo} is on ${head ?? 'no branch'}, not ${base}: switch it to ${base} first (git switch ${base}), then run drove merge again`)
  const unsaved = await git.dirtyLines(deps.exec, run.repo)
  if (unsaved.length > 0) return refuse('dirty-checkout', `the main checkout ${run.repo} has uncommitted changes (${unsaved.slice(0, 5).join('; ')}): commit or stash them, then run drove merge again`)
  const failure = await check()
  if (failure) return failure
  const message = request.message?.trim() || `merge: ${await git.commitSubject(deps.exec, run.repo, seat.branch)}`
  const merged = await git.mergeNoFf(deps.exec, run.repo, seat.branch, message)
  if (!merged.ok) return refuse('merge-conflict', `merge refused: ${seat.branch} does not merge cleanly into ${base} (the merge was aborted, ${base} is untouched): ${clip(merged.output, 400)}. Have the worker merge ${base} into its branch and resolve the conflicts.`)
  const detail = gateText(plan.commands, plan.source)
  await settle('merge.passed', `merged at ${merged.sha}; ${detail}`, { sha: merged.sha, checks: plan.commands, message })
  return ok(`Merged ${seat.branch} into ${base} at ${merged.sha} (--no-ff: "${message}"); ${detail}. ${base} is local and not pushed. Close ${seat.name} with drove close ${seat.name} --remove-worktree.`, { status: 'merged', mode: 'local', sha: merged.sha })
}

const prBody = (run: RunMeta, seat: Seat, subjects: readonly string[]): string =>
  [`## Commits`, ...subjects.map(subject => `- ${subject}`), '', ...(seat.cairn ? [`Cairn: ${seat.cairn}`] : []), `Drove run ${run.id}, seat ${seat.name} (${seat.branch}).`].join('\n')

const mergePr = async (
  deps: Deps, run: RunMeta, seat: Seat, base: string, request: MergeRequest, plan: { commands: string[]; source: string },
  check: () => Promise<CommandResult | undefined>, settle: Gate['settle'], refuse: Gate['refuse'],
): Promise<CommandResult> => {
  if (!(await git.hasRemote(deps.exec, run.repo))) return refuse('no-remote', `${run.repo} has no remote, so there is no pull request to open: use drove merge ${seat.name} without --pr`)
  const hasCi = await hasWorkflows(run.repo, seat.worktree)
  let isChecked = false
  if (!hasCi) {
    const failure = await check()
    if (failure) return failure
    isChecked = true
  }

  const pushed = await git.pushBranch(deps.exec, run.repo, REMOTE, seat.branch)
  if (pushed.code !== 0) return refuse('push-failed', `could not push ${seat.branch} to ${REMOTE}: ${clip(pushed.stderr || pushed.stdout)}`)

  let pr = await viewPr(deps, run.repo, seat.branch)
  if (!pr) {
    const subjects = await git.commitSubjects(deps.exec, run.repo, (await git.freshestBase(deps.exec, run.repo, run.base)).ref, seat.branch)
    const last = subjects.at(-1) ?? seat.branch
    const title = seat.cairn && !last.includes(seat.cairn) ? `${last} (${seat.cairn})` : last
    const created = await gh(deps, run.repo, ['pr', 'create', '--head', seat.branch, '--base', base, '--title', title, '--body', prBody(run, seat, subjects)])
    if (created.code !== 0) return refuse('pr-failed', `gh pr create failed: ${clip(created.stderr || created.stdout)}`)
    pr = await viewPr(deps, run.repo, seat.branch)
    if (!pr) return refuse('pr-failed', `gh pr create ran, but the pull request for ${seat.branch} cannot be read back: ${clip(created.stdout)}`)
  }
  const at = { url: pr.url, pr: pr.number }

  if (pr.state === 'CLOSED') return refuse('pr-closed', `${pr.url} is closed without merging: reopen it on GitHub, or close ${seat.name}`, at)
  if (pr.state !== 'MERGED') {
    if (pr.mergeable === 'CONFLICTING') return refuse('pr-conflicts', `${pr.url} has conflicts with ${base}: have the worker merge ${base} into its branch, then run drove merge ${seat.name} --pr again`, at)
    if (pr.reviewDecision === 'CHANGES_REQUESTED') return refuse('pr-changes-requested', `${pr.url} has changes requested on GitHub: address them, then run drove merge ${seat.name} --pr again`, at)
    const checks = await prChecks(deps, run.repo, pr.number)
    if ('error' in checks) return refuse('checks-unreadable', `could not read the checks of ${pr.url}: ${checks.error}`, at)
    const failing = checks.filter(entry => entry.bucket === 'fail' || entry.bucket === 'cancel')
    if (failing.length > 0) return refuse('checks-failed', `merge refused: ${failing.length} check${failing.length === 1 ? '' : 's'} failed on ${pr.url}:\n${failing.map(entry => `- ${entry.name}${entry.link ? ` ${entry.link}` : ''}`).join('\n')}`, { ...at, failing: failing.map(entry => entry.name) })
    const waiting = checks.filter(entry => entry.bucket === 'pending')
    const pending = async (why: string): Promise<CommandResult> => {
      await settle('merge.pending', why, at)
      return ok(`pending: ${why} on ${pr.url}. Run drove merge ${seat.name} --pr again later.`, { status: 'pending', mode: 'pr', ...at })
    }
    if (waiting.length > 0) return pending(`${waiting.length} check${waiting.length === 1 ? ' is' : 's are'} still running (${waiting.map(entry => entry.name).join(', ')})`)
    if (checks.length === 0) {
      const age = deps.clock.now().getTime() - (Date.parse(pr.createdAt) || 0)
      if (hasCi && age < CI_GRACE_MS) return pending('no checks have reported yet')
      if (!isChecked) {
        const failure = await check()
        if (failure) return failure
        isChecked = true
      }
    }
    if (pr.reviewDecision === 'REVIEW_REQUIRED') return pending('a review is required on GitHub')
    const subject = request.message?.trim() || `merge: ${await git.commitSubject(deps.exec, run.repo, seat.branch)}`
    const merged = await gh(deps, run.repo, ['pr', 'merge', String(pr.number), request.squash ? '--squash' : '--merge', '--subject', subject])
    if (merged.code !== 0) return refuse('pr-merge-failed', `gh pr merge refused ${pr.url}: ${clip(merged.stderr || merged.stdout)}`, at)
    const after = await viewPr(deps, run.repo, seat.branch)
    if (after?.state !== 'MERGED') return refuse('pr-merge-failed', `gh pr merge ran but ${pr.url} is ${after?.state ?? 'unreadable'}, not MERGED`, at)
  }

  const notes: string[] = []
  const removed = await git.deleteRemoteBranch(deps.exec, run.repo, REMOTE, seat.branch)
  if (removed.code !== 0) notes.push(`The remote branch ${seat.branch} was not deleted (${clip(removed.stderr || removed.stdout, 160)}).`)
  const head = await git.headBranch(deps.exec, run.repo)
  const unsaved = head === base ? await git.dirtyLines(deps.exec, run.repo) : []
  let sha: string | undefined
  if (head !== base) notes.push(`The main checkout is on ${head ?? 'no branch'}, not ${base}, so local ${base} was not updated: git switch ${base} and pull.`)
  else if (unsaved.length > 0) notes.push(`The main checkout has uncommitted changes, so local ${base} was not updated: commit or stash them, then git pull --ff-only.`)
  else {
    const forwarded = await git.fastForwardFromRemote(deps.exec, run.repo, REMOTE, base)
    if (forwarded.ok) sha = forwarded.sha
    else notes.push(`Local ${base} could not be fast-forwarded from ${REMOTE}/${base}: ${forwarded.error}`)
  }
  const gated = isChecked ? gateText(plan.commands, plan.source) : 'GitHub checks green'
  await settle('merge.passed', `${request.squash ? 'squash-merged' : 'merged'} ${pr.url}${sha ? `, local ${base} at ${sha}` : ''}; ${gated}`, { ...at, ...(sha ? { sha } : {}), squash: request.squash === true, checks: isChecked ? plan.commands : [] })
  return ok([`Merged ${pr.url} (${request.squash ? 'squash' : 'merge commit'}); ${gated}.`, ...notes, `Close ${seat.name} with drove close ${seat.name} --remove-worktree.`].join(' '), { status: 'merged', mode: 'pr', ...at, ...(sha ? { sha } : {}) })
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
  const cairnNote = await reportRunToCairn(deps, run, (await loadRoster(deps.home, run.id)).seats, deps.clock.now().toISOString(), (await loadConfig(deps.home)).labInstance)
  return ok(
    [`Run ${run.id} is down: ${saved.length} seat(s) saved for resume${saved.length ? ` (${saved.join(', ')})` : ''}.`, ...(unsaved.length ? [`No session id for ${unsaved.join(', ')}: they cannot be resumed.`] : []), `Resume with \`drove up --run ${run.id}\`.`, ...(cairnNote ? [cairnNote] : [])].join(' '),
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
  const identity = identityOfSeat(deps, run, seat, token)
  const resumeText = resumePrompt(seat)
  const isInline = resolveBriefVia(config) === 'launch-arg'
  const spec = specFor(launchRequest(deps, { identity, kind: seat.kind, repo: run.repo, cwd: seat.worktree, model: seat.model, effort: seat.effort, roleText: seatRoleText(run, config, seat), resumeId: seat.sessionId, ...(isInline ? { initialPrompt: resumeText } : {}), ...(await launchExtrasOf(deps, run, config, seat)).parts }, config))
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
      ...(isResumed ? { lastWorkingAt: iso } : {}),
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

type PaneLiveness = { state: 'alive' | 'gone' } | { state: 'unverified'; detail: string }

const paneLiveness = async (deps: Deps, target: string): Promise<PaneLiveness> => {
  const live = await herdr.getAgent(deps.exec, target)
  if (live.ok) return { state: 'alive' }
  return isPaneMissing(live) ? { state: 'gone' } : { state: 'unverified', detail: clip(live.output || live.code, 160) }
}

const adoptAsDown = async (deps: Deps, run: RunMeta, seat: Seat): Promise<Seat> => {
  const sessionId = seat.sessionId ?? (await hookSessionId(deps, run.id, seat.name))
  const { restartingSince: _cleared, ...rest } = seat
  const adopted: Seat = { ...rest, ...(sessionId ? { sessionId } : {}), state: 'down', stateAt: deps.clock.now().toISOString(), attention: [] }
  await updateRoster(deps.home, run.id, roster => upsertSeat(roster, adopted))
  return adopted
}

// An `up` run whose planner and seat panes are all gone is a crash: nothing ran `down`, and the watcher died too.
const probeCrashedRun = async (deps: Deps, run: RunMeta): Promise<{ seats: Seat[] } | { error: CommandResult }> => {
  const now = deps.clock.now()
  const seats = (await loadRoster(deps.home, run.id)).seats.filter(seat => seat.state !== 'closed')
  const probes = [
    ...(run.planner.paneId ? [{ label: `the planner pane ${run.planner.paneId}`, target: run.planner.paneId }] : []),
    ...seats.filter(seat => seat.state !== 'gone' && seat.state !== 'down').map(seat => ({ label: `${seat.name} (pane ${seat.paneId ?? herdr.agentTarget(run.id, seat)})`, target: herdr.agentTarget(run.id, seat) })),
  ]
  const results = await Promise.all(probes.map(async probe => ({ ...probe, liveness: await paneLiveness(deps, probe.target) })))
  const alive = results.filter(result => result.liveness.state === 'alive').map(result => result.label)
  if (alive.length) return { error: failed('not-down', `run ${run.id} is up and still has live panes: ${alive.join(', ')}; nothing to recover`) }
  const unverified = results.find(result => result.liveness.state === 'unverified')
  if (unverified && unverified.liveness.state === 'unverified') return { error: failed('herdr', `herdr could not say whether ${unverified.label} is alive: ${unverified.liveness.detail}`) }
  const restarting = seats.filter(seat => isRestarting(seat, now)).map(seat => seat.name)
  if (restarting.length) return { error: failed('not-down', `run ${run.id} has a restart in flight for ${restarting.join(', ')}; try again shortly`) }
  return { seats }
}

export type UpOptions = { detached?: boolean; json?: boolean }

export const up = async (deps: Deps, ref: RunRef, seatName?: string, options: UpOptions = {}): Promise<CommandResult> => {
  const isDetached = options.detached === true
  if (isDetached && seatName) return failed('usage', '--detached starts the whole run in a workspace of its own; it does not combine with --seat')
  const located = seatName ? await locateRun(deps, ref, 'up') : await locateRun(deps, ref, 'down')
  if ('error' in located) return located.error
  let { run } = located
  const config = await loadConfig(deps.home)

  if (seatName) {
    let seat = findSeat(await loadRoster(deps.home, run.id), seatName)
    if (!seat || seat.state === 'closed') return failed('no-seat', `no seat named ${seatName} to relaunch`)
    if (seat.state !== 'gone' && seat.state !== 'down') {
      if (isRestarting(seat, deps.clock.now())) return failed('not-dead', `${seatName} is ${seat.state} and is being restarted; try again shortly`)
      const probed = await paneLiveness(deps, herdr.agentTarget(run.id, seat))
      if (probed.state === 'alive') return failed('not-dead', `${seatName} is ${seat.state}; only a gone or down seat is relaunched`)
      if (probed.state === 'unverified') return failed('herdr', `herdr could not say whether ${seatName}'s pane ${seat.paneId ?? '?'} is alive: ${probed.detail}`)
      seat = await adoptAsDown(deps, run, seat)
    }
    const placed = openSeats(await loadRoster(deps.home, run.id)).filter(entry => entry.name !== seat.name && entry.paneId)
    const relaunched = await relaunchSeat(deps, run, config, seat, placed)
    return 'error' in relaunched ? failed('relaunch', relaunched.error) : ok(`Relaunched ${seatName} in pane ${relaunched.seat.paneId} with resume.${relaunched.note ? ` Note: ${relaunched.note}.` : ''}`,{ paneId: relaunched.seat.paneId })
  }

  const hostPane = process.env.HERDR_PANE_ID
  if (!isDetached && !hostPane) return failed('not-in-herdr', 'drove up must run inside a herdr pane (HERDR_PANE_ID is unset); the planner resumes in this pane. --detached opens a workspace of its own instead')
  if (isDetached) {
    const unreachable = await requireHerdrServer(deps)
    if (unreachable) return unreachable
  }
  let recovered: Seat[] | undefined
  if (run.status === 'up') {
    const crashed = await probeCrashedRun(deps, run)
    if ('error' in crashed) return crashed.error
    recovered = await Promise.all(crashed.seats.map(seat => adoptAsDown(deps, run, seat)))
    const plannerId = run.planner.sessionId ?? (await plannerSessionId(deps, run))
    run = { ...run, planner: { ...run.planner, ...(plannerId ? { sessionId: plannerId } : {}) } }
    await recordEvent(deps, run.id, { type: 'run.recovered', data: { seats: recovered.map(seat => seat.name), unsaved: recovered.filter(seat => !seat.sessionId).map(seat => seat.name), plannerPane: run.planner.paneId, ...(hostPane ? { pane: hostPane } : { detached: true }) } })
  }
  const identity: Identity = { home: deps.home, run: run.id, role: 'planner', seat: PLANNER_SEAT }
  const planner = run.planner
  const sessionId = planner.kind === 'claude' ? planner.sessionId ?? randomUUID() : undefined
  const resumeId = planner.sessionId
  const spec = specFor(
    launchRequest(deps, { identity, kind: planner.kind, repo: run.repo, cwd: run.repo, model: planner.model, effort: planner.effort, roleText: plannerRole(run, config, planner.kind, await availableTrimsOf(deps, run)), channel: planner.kind === 'claude' && config.claudeChannel, ...(resumeId ? { resumeId } : { initialPrompt: planner.kind === 'codex' ? 'The run was resumed. Read the roster and continue.' : undefined, sessionId }) }, config),
  )
  let opened: OpenedWorkspace | undefined
  if (isDetached) {
    const made = await openDetachedWorkspace(deps, run, spec.env)
    if ('code' in made) return made
    opened = made
  }
  const paneId = opened?.paneId ?? hostPane ?? ''
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
  await recordEvent(deps, run.id, { type: 'run.up', data: { resumed, lost, pane: paneId, ...(opened ? { workspace: opened.workspaceId, detached: true } : {}) } })

  await writeLaunchFiles(spec)
  const summary = `Run ${run.id} is up${recovered ? ` (recovered after a crash: ${recovered.length} seat(s) adopted)` : ''}: resumed ${resumed.length ? resumed.join(', ') : 'no workers'}${lost.length ? `; could not resume ${lost.join('; ')}` : ''}.${resumeId ? '' : ' The planner had no saved session id, so it starts fresh.'}`
  if (opened) {
    const started = await startDetachedPlanner(deps, run, spec, opened.paneId, undefined)
    if ('code' in started) return failed(started.code, `${started.text} The seats were resumed in workspace ${opened.workspaceId} and pane ${opened.paneId} is left open for you; close it with drove down --run ${run.id} and try again.`)
    return detachedResult(run, opened, started, options.json === true, `${summary.replace(/ is up/, ` is up in its own herdr workspace ${opened.workspaceId}`)} The ${planner.kind} planner is ${started.state}.`, { resumed, lost })
  }
  return ok(summary, { argv: execArgv(spec), env: spec.env, cwd: spec.cwd } satisfies ProcessPlan)
}

// ---------- goal ----------

export type GoalRequest = { goal: string; cairn?: string }

// The planner's one line of what the run is doing now. It replaces the goal the run started with, so the board header and the
// roster follow the work as it moves on.
export const setGoal = async (deps: Deps, ref: RunRef, request: GoalRequest): Promise<CommandResult> => {
  if (process.env[ENV.role] === 'worker') return failed('forbidden', 'only the planner or the human can set the run goal')
  const goal = request.goal.replace(/\s+/g, ' ').trim()
  if (!goal) return failed('usage', 'the goal is empty; give one plain line of what the run is doing')
  if (request.cairn && !CAIRN_RE.test(request.cairn)) return failed('usage', `--cairn must look like DROVE-5; got "${request.cairn}"`)
  const located = await locateRun(deps, ref, 'up')
  if ('error' in located) return located.error
  const { run } = located
  const next: RunMeta = { ...run, goal, ...(request.cairn ? { cairn: request.cairn } : {}) }
  await saveRun(deps.home, next)
  await recordEvent(deps, run.id, { type: 'goal.set', data: { goal, ...(request.cairn ? { cairn: request.cairn } : {}), ...(run.goal ? { previous: run.goal } : {}) } })
  return ok(`Goal of run ${run.id} set${request.cairn ? ` (Cairn task ${request.cairn})` : ''}: ${goal}`, { goal, run: next })
}

// ---------- budget ----------

export const raiseBudget = async (deps: Deps, ref: RunRef, size: number): Promise<CommandResult> => {
  if (!Number.isInteger(size) || size < 1) return failed('usage', 'the budget must be a whole number of at least 1')
  const located = await locateRun(deps, ref, 'up')
  if ('error' in located) return located.error
  await saveRun(deps.home, { ...located.run, budget: size })
  return ok(`Pane budget for run ${located.run.id} is now ${size}.`, { budget: size })
}

export const budget = async (deps: Deps, ref: RunRef, size: number): Promise<CommandResult> => {
  if (process.env[ENV.role]) return failed('forbidden', 'only the human can raise the pane budget; ask them to run `drove budget <n>`')
  return raiseBudget(deps, ref, size)
}
