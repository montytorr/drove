import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { AgentKind, Effort, OrchBridge, OrchFeedEntry, OrchModStatus, OrchOrchestrator, OrchWorkerSelf, RunMeta, Seat, SeatRole } from '../types'
import { BOARD_ID, EXPAND_INDENT, buildBoard, needsAnimation, timelineRoom } from './board'
import type { BoardRow, Cell, Tone } from './board'
import { BRIDGE_EXIT, backoffMs, feedOf, parseLine, splitLines, splitWake, toastOf, wakeHeadlines } from './bridge'
import type { BridgeLine, FeedDraft } from './bridge'
import * as drove from './drove'
import { type LeanSpawnTrims, modelNotice, orchestratorSection, workerModelSection } from './prompts'
import { CAIRN_RE, DEFAULT_HUMAN_NAME, DROVE_OPEN, HUMAN, NAME_RE, isEffort, isExpects, locateEnvelope, goalFromPrompt, oneLine, raiseEffort, renderControl, repoFlagOf, shortModel, verifyEnvelope } from './protocol'
import { effortLetter, findSeat, isAsking, modelLetter, openSeats, pushFeed, statusGlyph } from './roster'

const STORE_PREFIX = 'drove:session:'
const LEGACY_PREFIX = 'session:'
const STORE_MAX_AGE_MS = 14 * 24 * 3_600_000
const COLOR = {
  crust: '#11111b',
  text: '#cdd6f4',
  surface1: '#585b70',
  overlay: '#7f849c',
  blue: '#89b4fa',
  mauve: '#cba6f7',
  peach: '#fab387',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  red: '#f38ba8',
} as const

const orchestratorAtom = atom({ plugin: 'orchestrator', key: 'orchestrator' } as const, null)
const seatsAtom = atom({ plugin: 'orchestrator', key: 'seats' } as const, [] as Seat[])
const statusAtom = atom({ plugin: 'orchestrator', key: 'status' } as const, {} as Record<string, OrchModStatus>)
const asksAtAtom = atom({ plugin: 'orchestrator', key: 'asksAt' } as const, {} as Record<string, number>)
const bridgeAtom = atom({ plugin: 'orchestrator', key: 'bridge' } as const, null)
const workerAtom = atom({ plugin: 'orchestrator', key: 'worker' } as const, null)
const feedAtom = atom({ plugin: 'orchestrator', key: 'feed' } as const, [] as OrchFeedEntry[])
const leadAtom = atom({ plugin: 'orchestrator', key: 'lead' } as const, null)
const frameAtom = atom({ plugin: 'orchestrator', key: 'frame' } as const, 0)
const boardBgAtom = atom({ plugin: 'orchestrator', key: 'boardBg' } as const, true)
const scrollAtom = atom({ plugin: 'orchestrator', key: 'scrollBack' } as const, 0)
const expandedAtom = atom({ plugin: 'orchestrator', key: 'expanded' } as const, null)
const pendingGoalAtom = atom({ plugin: 'orchestrator', key: 'pendingGoal' } as const, null)
const pendingWakesAtom = atom({ plugin: 'orchestrator', key: 'pendingWakes' } as const, [] as string[])
let feedCount = 0
const RETRY_MS = 2_000
const PENDING_WAKES_MAX = 20
const FULL_MAX = 4000
const BOARD_BG = '#1e1e2e'
const FRAME_MS = 250
const SPAWN_TIMEOUT_MS = 300_000
const MERGE_TIMEOUT_MS = 600_000
const COMMAND_TIMEOUT_MS = 120_000
const GUARD_TIMEOUT_MS = 15_000

type Config = {
  orchestratorModel: string
  orchestratorEffort: Effort
  workerModel: string
  promotedModel: string
  workerEffort: Effort
  maxWorkers: number
  effortRouting: boolean
  droveEntry: string
  nodePath: string
}

const config: Config = {
  orchestratorModel: 'claude-opus-5-5',
  orchestratorEffort: 'high',
  workerModel: 'claude-sonnet-5-5',
  promotedModel: 'claude-opus-5-5',
  workerEffort: 'medium',
  maxWorkers: 5,
  effortRouting: false,
  droveEntry: '',
  nodePath: 'node',
}

const configure = (options: PluginOptions) => {
  const text = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value.trim() : fallback)
  config.orchestratorModel = text(options.orchestratorModel, config.orchestratorModel)
  config.workerModel = text(options.workerModel, config.workerModel)
  config.promotedModel = text(options.promotedModel, config.promotedModel)
  config.droveEntry = text(options.droveEntry, config.droveEntry)
  config.nodePath = text(options.nodePath, config.nodePath)
  if (isEffort(options.orchestratorEffort)) config.orchestratorEffort = options.orchestratorEffort
  if (isEffort(options.workerEffort)) config.workerEffort = options.workerEffort
  const max = Number(options.maxWorkers)
  if (Number.isFinite(max) && max >= 1) config.maxWorkers = Math.floor(max)
  config.effortRouting = options.effortRouting === true
}

const resolveModel = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const alias = value.trim().toLowerCase()
  if (alias === 'opus') return config.promotedModel
  if (alias === 'sonnet') return config.workerModel
  return value.trim()
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Background work (timers, the bridge loop) can outlive the module's environment, so it never rejects.
const quietly = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch {
    // the environment went away, or the engine refused the call
  }
}

const soon = ($: EngineInterface, ms: number, work: () => Promise<unknown>) => $.clock.after(ms, () => void quietly(work))

let animator: { cancel: () => void } | undefined
let pendingRouting = false
let routingTurnId: string | undefined
let isDrovePlanner = false
let bridgeEpoch = 0
let bridgeTries = 0
let bridgeStream: { return: (value?: never) => Promise<unknown> } | undefined
let lastRun: RunMeta | undefined
const bodies = new Map<string, string[]>()

const isSummariser = async ($: EngineInterface): Promise<boolean> => {
  try {
    const values = await Promise.all([
      $.env.get('CAIRN_SUMMARISER'),
      $.env.get('QUARRY_SUMMARISER'),
      $.env.get('AGENT_MEMORY_SUMMARISER'),
    ])
    return values.includes('1')
  } catch {
    return false
  }
}

const herdrPane = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    return (await $.env.get('HERDR_PANE_ID')) || undefined
  } catch {
    return undefined
  }
}

const droveHome = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    return (await $.env.get('DROVE_HOME')) || undefined
  } catch {
    return undefined
  }
}

const homeDir = async ($: EngineInterface): Promise<string> => (await droveHome($)) ?? `${(await $.env.get('HOME')) ?? ''}/.drove`

// Drove's own humanName (~/.drove/config.json), so the mod names the human as Drove's prompts do.
const humanNameOf = async ($: EngineInterface): Promise<string> => {
  try {
    const name = (JSON.parse(await $.fs.read(`${await homeDir($)}/config.json`)) as { humanName?: unknown }).humanName
    return typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_HUMAN_NAME
  } catch {
    return DEFAULT_HUMAN_NAME
  }
}

const readJsonAt = async ($: EngineInterface, path: string): Promise<Record<string, unknown>> => {
  try {
    const value = JSON.parse(await $.fs.read(path)) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const stringsOf = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean) : undefined

// Entry names in a folder, whatever shape the engine lists them in (a name, or an object that has one).
const namesIn = async ($: EngineInterface, dir: string): Promise<string[]> => {
  const listed: unknown = await $.fs.list(dir).catch(() => [])
  return Array.isArray(listed) ? listed.map(entry => (typeof entry === 'string' ? entry : typeof (entry as { name?: unknown } | null)?.name === 'string' ? (entry as { name: string }).name : '')).filter(name => name && !name.startsWith('.')) : []
}

// The names Claude lists as the user's skills and agent types: skills/<name>/SKILL.md, the claude.ai ones synced as
// anthropic-skills:<name>, commands/*.md, and agents/**/*.md by file name. Same rule as readClaudeSkills in src/launch.ts.
const skillNamesOf = async ($: EngineInterface, claudeDir: string): Promise<string[]> => {
  const own = (await namesIn($, `${claudeDir}/skills`)).filter(name => name !== 'synced')
  const ownSkills = await Promise.all(own.map(async name => (await $.fs.exists(`${claudeDir}/skills/${name}/SKILL.md`).catch(() => false) ? [name] : [])))
  const accounts = await namesIn($, `${claudeDir}/skills/synced`)
  const synced = await Promise.all(accounts.map(async account => {
    const names = await namesIn($, `${claudeDir}/skills/synced/${account}`)
    return (await Promise.all(names.map(async name => (await $.fs.exists(`${claudeDir}/skills/synced/${account}/${name}/SKILL.md`).catch(() => false) ? [`anthropic-skills:${name}`] : [])))).flat()
  }))
  const commands = (await namesIn($, `${claudeDir}/commands`)).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3))
  return [...new Set([...ownSkills.flat(), ...synced.flat(), ...commands])]
}

const agentNamesOf = async ($: EngineInterface, claudeDir: string, dir = `${claudeDir}/agents`, depth = 0): Promise<string[]> => {
  const names = await namesIn($, dir)
  const found = await Promise.all(names.map(async name => (name.endsWith('.md') ? [name.slice(0, -3)] : depth < 2 ? agentNamesOf($, claudeDir, `${dir}/${name}`, depth + 1) : [])))
  return [...new Set(found.flat())]
}

const keysOf = (value: unknown): string[] => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [])

// What a spawned worker loads under Drove's settings, and the MCP server and plugin names the orchestrator can choose
// from. Read only, best effort, names only; held for the session because the prompt is composed every request.
let leanTrims: Promise<LeanSpawnTrims> | undefined
const trimsOf = ($: EngineInterface): Promise<LeanSpawnTrims> => {
  leanTrims ??= (async () => {
    const [home, userHome, claudeConfigDir, codexHome, cwd] = await Promise.all([homeDir($), $.env.get('HOME'), $.env.get('CLAUDE_CONFIG_DIR'), $.env.get('CODEX_HOME'), $.session.cwd()])
    const claudeDir = claudeConfigDir || `${userHome ?? ''}/.claude`
    const [droveConfig, claudeJson, projectMcp, settings, codexConfig, skills, agents] = await Promise.all([
      readJsonAt($, `${home}/config.json`),
      readJsonAt($, `${claudeConfigDir || userHome || ''}/.claude.json`),
      readJsonAt($, `${cwd}/.mcp.json`),
      readJsonAt($, `${claudeDir}/settings.json`),
      $.fs.read(`${codexHome || `${userHome ?? ''}/.codex`}/config.toml`).catch(() => undefined),
      skillNamesOf($, claudeDir),
      agentNamesOf($, claudeDir),
    ])
    const local = (claudeJson.projects as Record<string, { mcpServers?: unknown } | undefined> | undefined)?.[cwd]?.mcpServers
    const mcp = [...new Set([...keysOf(claudeJson.mcpServers), ...keysOf(projectMcp.mcpServers), ...keysOf(local)])].filter(name => name !== 'drove')
    const dirs = typeof (settings.env as { CLAUDE_CODE_PLUGIN_DIRS?: unknown } | undefined)?.CLAUDE_CODE_PLUGIN_DIRS === 'string'
      ? ((settings.env as { CLAUDE_CODE_PLUGIN_DIRS: string }).CLAUDE_CODE_PLUGIN_DIRS.split(':').map(entry => entry.trim()).filter(Boolean))
      : []
    const dirNames = await Promise.all(dirs.map(async dir => {
      const name = (await readJsonAt($, `${dir.replace(/^~(?=\/)/, userHome ?? '~')}/.claude-plugin/plugin.json`)).name
      return typeof name === 'string' && name.trim() ? name.trim() : dir.split('/').filter(Boolean).at(-1) ?? dir
    }))
    const enabled = Object.entries((settings.enabledPlugins as Record<string, unknown> | undefined) ?? {}).filter(([, on]) => on === true).map(([key]) => key.split('@')[0] ?? key)
    const plugins = [...new Set([...enabled, ...dirNames])].filter(name => name !== 'orchestrator')
    const codexMcp = codexConfig === undefined ? undefined : [...new Set([...codexConfig.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)].map(match => match[1] ?? '').filter(name => name && name !== 'drove'))]
    return {
      ...(stringsOf(droveConfig.workerMcp) ? { workerMcp: stringsOf(droveConfig.workerMcp) } : {}),
      ...(stringsOf(droveConfig.workerPlugins) ? { workerPlugins: stringsOf(droveConfig.workerPlugins) } : {}),
      ...(stringsOf(droveConfig.workerSkills) ? { workerSkills: stringsOf(droveConfig.workerSkills) } : {}),
      ...(stringsOf(droveConfig.workerAgents) ? { workerAgents: stringsOf(droveConfig.workerAgents) } : {}),
      ...(typeof droveConfig.workerUserMemory === 'boolean' ? { workerUserMemory: droveConfig.workerUserMemory } : {}),
      ...(typeof droveConfig.workerUserHooks === 'boolean' ? { workerUserHooks: droveConfig.workerUserHooks } : {}),
      mcp, plugins, ...(skills.length > 0 ? { skills } : {}), ...(agents.length > 0 ? { agents } : {}), ...(codexMcp ? { codexMcp } : {}),
    }
  })()
  return leanTrims
}

const entryOf = ($: EngineInterface): string => drove.entryOf($.plugin.root, config.droveEntry)

type RunInit = { env?: Record<string, string>; stdin?: string; timeoutMs?: number; cwd?: string }

const runDrove = async ($: EngineInterface, args: readonly string[], init: RunInit = {}): Promise<drove.Ran> => {
  try {
    const ran = await $.process.run([config.nodePath, entryOf($), ...args], {
      ...(init.cwd ? { cwd: init.cwd } : {}),
      env: init.env ?? {},
      ...(init.stdin !== undefined ? { stdin: init.stdin } : {}),
      timeoutMs: init.timeoutMs ?? COMMAND_TIMEOUT_MS,
    })
    return { exitCode: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr }
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: `drove-unavailable: ${messageOf(error)}` }
  }
}

const plannerRun = async ($: EngineInterface, args: readonly string[], init: RunInit = {}): Promise<drove.Ran> => {
  const orchestrator = await read($, orchestratorAtom)
  if (!orchestrator) return { exitCode: 1, stdout: '', stderr: 'off: Orchestrator mode is off.' }
  return runDrove($, args, { ...init, cwd: orchestrator.repo, env: drove.plannerEnv(orchestrator.run, await droveHome($)) })
}

type ToolAnswer = { deny: string } | { result: string }

const answerOf = (ran: drove.Ran): ToolAnswer => {
  if (ran.exitCode === 0) return { result: ran.stdout.trim() }
  const failure = drove.failureOf(ran)
  return { deny: `Drove: ${failure.text} [${failure.code}]` }
}

const pushBody = (key: string, text: string) => bodies.set(key, [...(bodies.get(key) ?? []), text])
const dropBody = (key: string) => bodies.set(key, (bodies.get(key) ?? []).slice(0, -1))

const persist = async ($: EngineInterface) => {
  try {
    const [orchestrator, pendingGoal, pendingWakes, sessionId, now] = await Promise.all([read($, orchestratorAtom), read($, pendingGoalAtom), read($, pendingWakesAtom), $.session.id(), $.clock.now()])
    const key = `${STORE_PREFIX}${sessionId}`
    if (orchestrator) {
      await $.store.set(key, {
        run: orchestrator.run,
        goal: orchestrator.goal,
        startedAt: orchestrator.startedAt,
        savedAt: now,
        ...(pendingGoal ? { pendingGoal } : {}),
        ...(pendingWakes.length > 0 ? { pendingWakes } : {}),
      })
    }
    else await $.store.delete(key)
  } catch {
    // persistence is best effort: the run itself lives in Drove's state
  }
}

const pruneStore = async ($: EngineInterface) => {
  try {
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX) && !key.startsWith(LEGACY_PREFIX)) continue
      const saved = (await $.store.get(key)) as { savedAt?: number } | undefined
      if (!saved || typeof saved.savedAt !== 'number' || now - saved.savedAt > STORE_MAX_AGE_MS) await $.store.delete(key)
    }
  } catch {
    // nothing to prune
  }
}

const ORCHESTRATOR_TOOLS = [
  {
    name: 'spawn_worker',
    description:
      'Orchestrator mode: start a worker through Drove in a new herdr pane, in its own git worktree, and give it a brief. kind claude (default, Sonnet unless you say otherwise) or codex. It reports back to you through Drove and can ask to be promoted. Up to the run’s pane budget without asking; beyond it the human is asked in a dialog. Returns once the brief is delivered.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'short unique name, [a-z][a-z0-9_-]{0,31}, e.g. w-auth' },
        brief: { type: 'string', description: 'the full, standalone task: goal, files it owns, what not to touch, acceptance criteria, how to verify' },
        kind: { type: 'string', enum: ['claude', 'codex'], description: 'claude (default) or codex' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'low: mechanical; medium: standard (default); high: tricky logic or debugging' },
        model: { type: 'string', description: 'Claude: sonnet (default) or opus, or a full model id. Codex: a model id, or leave out for Drove’s default' },
        cairn: { type: 'string', description: 'the Cairn task ref for this piece (e.g. CCS-12), filed first with cairn add --no-start; the worker claims it' },
        mcp: { type: 'array', items: { type: 'string' }, description: 'optional: the user MCP servers this worker needs, by name; [] for Drove’s alone. Left out, Drove’s workerMcp setting decides' },
        plugins: { type: 'array', items: { type: 'string' }, description: 'optional, Claude workers: the user plugins this worker needs, by name; [] for Drove’s mod alone. Left out, Drove’s workerPlugins setting decides (every enabled plugin when unset)' },
        skills: { type: 'array', items: { type: 'string' }, description: 'optional, Claude workers: the user skills this worker needs, by name; [] loads no skill at all, plugin skills follow plugins. Left out, Drove’s workerSkills setting decides (every skill when unset)' },
        agents: { type: 'array', items: { type: 'string' }, description: 'optional, Claude workers: your own agent types this worker may use, by name; [] hides all of them, built-in agents stay. Left out, Drove’s workerAgents setting decides (every agent when unset)' },
        userMemory: { type: 'boolean', description: 'optional, Claude workers: true loads your own CLAUDE.md files, false leaves them out. Left out, Drove’s workerUserMemory setting decides (loaded by default). Codex workers follow the setting alone' },
        role: { type: 'string', enum: ['implementer', 'reviewer', 'tester'], description: 'optional, default implementer. reviewer: read-only, reads the target’s diff and brief and reports a recommendation, findings and check results (needs target). tester: branches from the target’s branch head and writes tests only, owns defaulting to the usual test globs (needs target)' },
        target: { type: 'string', description: 'the worker a reviewer reviews or a tester tests; required for those roles' },
        userHooks: { type: 'boolean', description: 'optional, Claude workers: false leaves out the hooks in your own settings.json, and with them your own skills, agents and commands, which Claude reads from the same source; Drove’s hooks stay. Left out, Drove’s workerUserHooks setting decides (kept by default). Codex workers follow the setting alone' },
        owns: { type: 'array', items: { type: 'string' }, description: 'optional: globs, relative to the worktree, of the files this worker may change; Drove’s guard refuses its edits elsewhere. Left out, it may edit anywhere (a tester: the usual test globs)' },
        maxTurns: { type: 'integer', minimum: 1, description: 'optional: how many turns the worker may take before it is told to report progress or promote and stop' },
        maxTokens: { type: 'integer', minimum: 1, description: 'optional: how many tokens the worker may use, same effect at the limit as maxTurns' },
      },
      required: ['name', 'brief'],
    },
  },
  {
    name: 'message_worker',
    description: 'Orchestrator mode: send a worker a message (an answer, a correction, extra context). Say what you expect back.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        text: { type: 'string' },
        expects: { type: 'string', enum: ['review', 'answer', 'none'], description: 'what the worker owes you back; none for a plain answer it can act on' },
      },
      required: ['name', 'text'],
    },
  },
  {
    name: 'review_verdict',
    description: 'Orchestrator mode: give a worker your verdict on its done report. approve: it commits its own paths (never pushes) and confirms. changes: it fixes the points in notes and reports done again.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        verdict: { type: 'string', enum: ['approve', 'changes'] },
        notes: { type: 'string', description: 'concrete review notes; required for changes' },
      },
      required: ['name', 'verdict'],
    },
  },
  {
    name: 'promote_worker',
    description: 'Orchestrator mode: move a worker up. Raise its effort on Sonnet first (model: sonnet, effort: high or xhigh); move it to Opus (model: opus) when the problem needs deeper reasoning. A Claude worker switches from its next request; a Codex worker is restarted with resume once it is idle.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        model: { type: 'string', description: 'opus (default) or sonnet, or a full model id (Codex: a model id; default its current model)' },
        effort: { type: 'string', enum: ['medium', 'high', 'xhigh', 'max'], description: 'default high' },
        reason: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'demote_worker',
    description: 'Orchestrator mode: move a promoted worker back to Sonnet (or a Codex worker to a lower effort) once the hard part is done.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, effort: { type: 'string', enum: ['low', 'medium', 'high'] }, model: { type: 'string', description: 'Codex only: a model id' } },
      required: ['name'],
    },
  },
  {
    name: 'migrate_worker',
    description: 'Orchestrator mode: move a worker to the other agent kind (Claude to Codex, or Codex to Claude), usually because it hit its usage limit. It keeps its name, worktree, branch and Cairn task; the new agent starts fresh there with a handoff brief (its brief, commits, uncommitted changes and last reports). The turn in flight is lost.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['claude', 'codex'], description: 'the kind to move to' },
        model: { type: 'string', description: 'Claude: opus or sonnet (default) or a model id; Codex: a model id (default Codex\'s worker model)' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'default: its current effort' },
        reason: { type: 'string' },
      },
      required: ['name', 'kind'],
    },
  },
  {
    name: 'close_worker',
    description: 'Orchestrator mode: close a worker pane you opened, once its work is approved and committed or no longer needed. Its worktree and branch are kept unless remove_worktree is true and the branch is merged.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, remove_worktree: { type: 'boolean' } }, required: ['name'] },
  },
  {
    name: 'merge_worker',
    description:
      'Orchestrator mode: integrate an approved worker’s branch behind the repo’s checks. Use this, never a plain git merge (the guard denies that). Local (default): Drove runs the repo’s checks (typecheck, lint, test, or the checks list in .drove.json) in the worker’s worktree and, only when they pass, merges the branch --no-ff into the base in the main checkout (it must be on the base and clean); a failure is refused with the failing check’s output. pr: true pushes the branch, opens a pull request, reads its checks and, once green, merges it with gh and fast-forwards the local base; the answer may be "pending" with the PR URL (checks running or a review required): call again later, do not poll. Close the worker afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        pr: { type: 'boolean', description: 'go through a GitHub pull request (the repo needs a remote); default is a local merge' },
        squash: { type: 'boolean', description: 'with pr: squash-merge the pull request instead of a merge commit' },
        message: { type: 'string', description: 'the merge commit message; default "merge: <the branch’s last commit subject>"' },
        fresh: { type: 'boolean', description: 'run the checks again even when run_checks recorded a pass at the worker’s current commit on a clean tree (the merge reuses it otherwise)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'run_checks',
    description:
      'Orchestrator mode: verify a worker’s done report yourself. Runs the repo’s checks (the merge plan: the checks list in .drove.json, else typecheck, lint, test) in the worker’s worktree and records each run by commit, so merge_worker reuses a pass instead of running them again. Returns pass or fail per command, the failing command’s exit code and output tail, the commit and whether the tree was clean (only a clean tree is evidence). A passing record at the worker’s current commit is reused unless fresh: true. It never writes to the repo. Send a failure back with message_worker or review_verdict changes.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        fresh: { type: 'boolean', description: 'run the checks again even when a passing record exists for the worker’s current commit' },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_goal',
    description: 'Orchestrator mode: set the run\'s goal, one plain line of what the run is doing now. Call it when the run has no goal, when it is vague (a bare ref, a fragment), or when the human\'s ask moves on to new work. The board header shows it. cairn is the goal task\'s ref, if there is one.',
    inputSchema: {
      type: 'object',
      properties: { goal: { type: 'string', description: 'one plain line of what the run is doing now' }, cairn: { type: 'string', description: 'optional: the Cairn task ref of the goal task, e.g. DROVE-5' } },
      required: ['goal'],
    },
  },
  {
    name: 'set_owns',
    description: 'Orchestrator mode: change the files an open worker may edit, mid-run. add allows more globs (use it when a worker asks for one more path, e.g. the mirror mod/types/index.d.ts when it changes src/types.ts); set replaces the whole list. Drove’s guard takes it at the worker’s next edit and the worker is told. A reviewer is read-only and refused, an empty list is refused, and a worker spawned without owns has no limit to widen.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the worker’s seat name' },
        add: { type: 'array', items: { type: 'string' }, description: 'globs, relative to the worktree, to allow in addition to its owns' },
        set: { type: 'array', items: { type: 'string' }, description: 'globs that replace its owns; give add or set, not both' },
      },
      required: ['name'],
    },
  },
  {
    name: 'roster',
    description: 'Orchestrator mode: list the workers, their state, model, effort, last report and what you owe them.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_reports',
    description:
      "Orchestrator mode: read workers' reports in full (summary, details, what Drove expects you to do next). A wake shows one line per report; call this before acting on a report that needs review or an answer. Default: every report you have not read yet, which it then marks read.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "one worker only: its unread reports, or its latest report when none is unread" },
        all: { type: 'boolean', description: 'every report, read or not' },
      },
    },
  },
] as const

const registerOrchestratorTools = async ($: EngineInterface) => {
  for (const tool of ORCHESTRATOR_TOOLS) await $.tool.register(tool as never)
}

const record = async ($: EngineInterface, entry: FeedDraft) => {
  feedCount += 1
  const id = `${entry.at.toString(36)}-${feedCount}`
  const full = (entry.full ?? entry.summary).trim().slice(0, FULL_MAX)
  await update($, feedAtom, feed => pushFeed(feed, { ...entry, id, full, summary: oneLine(entry.summary) }))
  await update($, scrollAtom, back => (back > 0 ? back + 1 : 0))
}

const setLead = async ($: EngineInterface, activity: string) => {
  const current = await read($, leadAtom)
  if (current?.activity === activity) return
  const at = await $.clock.now()
  await update($, leadAtom, () => ({ activity, since: at }))
  ensureAnimator($)
}

const LEAD_TOOL: Record<string, (input: Record<string, unknown>) => string> = {
  mcp__orchestrator__spawn_worker: input => `starting worker ${String(input.name ?? '')}`,
  mcp__orchestrator__message_worker: input => `messaging ${String(input.name ?? '')}`,
  mcp__orchestrator__review_verdict: input => `sending ${String(input.verdict ?? '')} to ${String(input.name ?? '')}`,
  mcp__orchestrator__promote_worker: input => `promoting ${String(input.name ?? '')}`,
  mcp__orchestrator__demote_worker: input => `moving ${String(input.name ?? '')} back down`,
  mcp__orchestrator__migrate_worker: input => `moving ${String(input.name ?? '')} to ${String(input.kind ?? '')}`,
  mcp__orchestrator__close_worker: input => `closing ${String(input.name ?? '')}`,
  mcp__orchestrator__merge_worker: input => `merging ${String(input.name ?? '')}`,
  mcp__orchestrator__run_checks: input => `running ${String(input.name ?? '')}’s checks`,
  mcp__orchestrator__set_goal: () => 'setting the goal',
  mcp__orchestrator__set_owns: input => `changing what ${String(input.name ?? '')} may edit`,
  mcp__orchestrator__roster: () => 'checking the roster',
  Bash: input => `running ${oneLine(String(input.command ?? ''), 60)}`,
  Read: input => `reading ${String(input.file_path ?? '').split('/').pop() ?? ''}`,
  Grep: input => `searching for ${oneLine(String(input.pattern ?? ''), 40)}`,
  Glob: input => `listing ${oneLine(String(input.pattern ?? ''), 40)}`,
  Agent: input => `subagent: ${oneLine(String(input.description ?? ''), 50)}`,
  AskUserQuestion: () => 'asking you a question',
  Edit: input => `editing ${String(input.file_path ?? '').split('/').pop() ?? ''}`,
  MultiEdit: input => `editing ${String(input.file_path ?? '').split('/').pop() ?? ''}`,
  Write: input => `writing ${String(input.file_path ?? '').split('/').pop() ?? ''}`,
  NotebookEdit: input => `editing ${String(input.notebook_path ?? '').split('/').pop() ?? ''}`,
  TodoWrite: () => 'updating its todo list',
}

const describeLeadTool = (tool: string, input: Record<string, unknown>): string => LEAD_TOOL[tool]?.(input) ?? `using ${tool.replace(/^mcp__[^_]+__/, '')}`

// ---------- the planner's tools: each is one drove command ----------

const spawnWorker = async ($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> => {
  const name = String(input.name ?? '').trim()
  const brief = String(input.brief ?? '').trim()
  if (!NAME_RE.test(name)) return { deny: `Worker names must match [a-z][a-z0-9_-]{0,31}; got "${name}".` }
  if (!brief) return { deny: 'A worker needs a brief.' }
  if (input.kind !== undefined && input.kind !== 'claude' && input.kind !== 'codex') return { deny: 'kind must be claude or codex.' }
  const kind: AgentKind = input.kind === 'codex' ? 'codex' : 'claude'
  const cairnText = typeof input.cairn === 'string' ? input.cairn.trim() : ''
  if (cairnText && !CAIRN_RE.test(cairnText)) return { deny: `cairn must look like CCS-12; got "${cairnText}".` }
  const effort = isEffort(input.effort) ? input.effort : config.workerEffort
  const model = kind === 'claude' ? resolveModel(input.model, config.workerModel) : typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined
  if (!(await herdrPane($))) return { deny: 'This session is not running in a herdr pane (HERDR_PANE_ID is unset), so it cannot open worker panes.' }
  const mcp = Array.isArray(input.mcp) ? input.mcp.filter((entry): entry is string => typeof entry === 'string') : undefined
  const plugins = Array.isArray(input.plugins) ? input.plugins.filter((entry): entry is string => typeof entry === 'string') : undefined
  const skills = Array.isArray(input.skills) ? input.skills.filter((entry): entry is string => typeof entry === 'string') : undefined
  const agents = Array.isArray(input.agents) ? input.agents.filter((entry): entry is string => typeof entry === 'string') : undefined
  const userMemory = typeof input.userMemory === 'boolean' ? input.userMemory : undefined
  const userHooks = typeof input.userHooks === 'boolean' ? input.userHooks : undefined
  const owns = Array.isArray(input.owns) ? input.owns.filter((entry): entry is string => typeof entry === 'string') : undefined
  if (input.role !== undefined && input.role !== 'implementer' && input.role !== 'reviewer' && input.role !== 'tester') return { deny: 'role must be implementer, reviewer or tester.' }
  const role: SeatRole = input.role === 'reviewer' || input.role === 'tester' ? input.role : 'implementer'
  const target = typeof input.target === 'string' ? input.target.trim() : ''
  if (role !== 'implementer' && !target) return { deny: `A ${role} needs target: the worker it ${role === 'reviewer' ? 'reviews' : 'tests'}.` }
  if (role === 'implementer' && target) return { deny: 'target applies to a reviewer or tester; set role.' }
  const maxTurns = typeof input.maxTurns === 'number' ? input.maxTurns : undefined
  const maxTokens = typeof input.maxTokens === 'number' ? input.maxTokens : undefined
  const args = drove.spawnArgs({ name, kind, effort, model, ...(cairnText ? { cairn: cairnText } : {}), ...(mcp ? { mcp } : {}), ...(plugins ? { plugins } : {}), ...(skills ? { skills } : {}), ...(agents ? { agents } : {}), ...(userMemory !== undefined ? { userMemory } : {}), ...(userHooks !== undefined ? { userHooks } : {}), ...(role !== 'implementer' ? { role, target } : {}), ...(owns ? { owns } : {}), ...(maxTurns ? { maxTurns } : {}), ...(maxTokens ? { maxTokens } : {}) })
  const label = `${kind === 'codex' ? `Codex${model ? ` ${model}` : ''}` : shortModel(model ?? '')} ${effort}`
  pushBody(`${name}:brief`, `${label} · ${brief}`)
  let ran = await plannerRun($, args, { stdin: brief, timeoutMs: SPAWN_TIMEOUT_MS })
  if (ran.exitCode !== 0 && drove.failureOf(ran).code === 'over-budget') {
    const [orchestrator, seats] = await Promise.all([read($, orchestratorAtom), read($, seatsAtom)])
    const open = openSeats(seats).length
    const budget = orchestrator?.budget ?? config.maxWorkers
    let answer = ''
    try {
      answer = await $.ui.ask(`Open worker pane ${open + 1} (${name}, ${label})? ${open} are open; the budget is ${budget}.`, { header: 'Worker pane', options: ['Open it', 'Not now'] })
    } catch {
      answer = ''
    }
    if (answer !== 'Open it' || !orchestrator) {
      dropBody(`${name}:brief`)
      return { deny: `${await humanNameOf($)} did not approve worker pane ${open + 1}. Reuse or close an open worker first.` }
    }
    const raised = await runDrove($, drove.budgetArgs(orchestrator.run, budget + 1), { cwd: orchestrator.repo, env: (await droveHome($)) ? { DROVE_HOME: (await droveHome($)) ?? '' } : {} })
    if (raised.exitCode !== 0) {
      dropBody(`${name}:brief`)
      return answerOf(raised)
    }
    await update($, orchestratorAtom, current => (current ? { ...current, budget: budget + 1 } : current))
    ran = await plannerRun($, args, { stdin: brief, timeoutMs: SPAWN_TIMEOUT_MS })
  }
  if (ran.exitCode !== 0) {
    dropBody(`${name}:brief`)
    return answerOf(ran)
  }
  $.ui.toast(`Worker ${name}: ${label}`)
  return { result: `${ran.stdout.trim()} Its reports will arrive here as messages; do not poll.` }
}

const messageWorker = async ($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> => {
  const name = String(input.name ?? '').trim()
  const text = String(input.text ?? '').trim()
  if (!text) return { deny: 'The message is empty.' }
  const expects = isExpects(input.expects) ? input.expects : 'none'
  pushBody(`${name}:message`, text)
  const ran = await plannerRun($, drove.messageArgs(name, expects), { stdin: text })
  if (ran.exitCode !== 0) dropBody(`${name}:message`)
  return answerOf(ran)
}

const reviewVerdict = async ($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> => {
  const name = String(input.name ?? '').trim()
  const verdict = input.verdict === 'approve' ? 'approve' : input.verdict === 'changes' ? 'changes' : undefined
  if (!verdict) return { deny: 'verdict must be approve or changes.' }
  const notes = String(input.notes ?? '').trim()
  if (verdict === 'changes' && !notes) return { deny: 'Say which changes are needed in notes.' }
  pushBody(`${name}:verdict`, `${verdict}${notes ? `: ${notes}` : ''}`)
  const ran = await plannerRun($, drove.verdictArgs(name, verdict), { stdin: notes })
  if (ran.exitCode !== 0) dropBody(`${name}:verdict`)
  return answerOf(ran)
}

const moveWorker = async ($: EngineInterface, input: Record<string, unknown>, direction: 'promote' | 'demote'): Promise<ToolAnswer> => {
  const name = String(input.name ?? '').trim()
  const seat = findSeat(await read($, seatsAtom), name)
  if (!seat) return { deny: `No open worker is named ${name}.` }
  const given = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined
  const model = seat.kind === 'claude' ? (direction === 'promote' ? resolveModel(given, config.promotedModel) : config.workerModel) : (given ?? (seat.model || undefined))
  const modelName = model ? shortModel(model) : 'current model'
  const effort = isEffort(input.effort) ? input.effort : direction === 'promote' ? 'high' : config.workerEffort
  const reason = String(input.reason ?? '').trim()
  pushBody(`${name}:${direction}`, `${modelName} ${effort}${reason ? `: ${reason}` : ''}`)
  const ran = await plannerRun($, drove.promoteArgs(name, model, effort, reason || undefined), { timeoutMs: SPAWN_TIMEOUT_MS })
  if (ran.exitCode !== 0) {
    dropBody(`${name}:${direction}`)
    return answerOf(ran)
  }
  $.ui.toast(`${name} → ${modelName} ${effort}`)
  return answerOf(ran)
}

const migrateWorker = async ($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> => {
  const name = String(input.name ?? '').trim()
  const seat = findSeat(await read($, seatsAtom), name)
  if (!seat) return { deny: `No open worker is named ${name}.` }
  const kind = input.kind === 'claude' || input.kind === 'codex' ? input.kind : undefined
  if (!kind) return { deny: 'kind must be claude or codex.' }
  if (kind === seat.kind) return { deny: `${name} is already a ${kind} worker; use promote_worker or demote_worker to change its model or effort.` }
  const given = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined
  const model = kind === 'claude' ? resolveModel(given, config.workerModel) : given
  const effort = isEffort(input.effort) ? input.effort : undefined
  const reason = String(input.reason ?? '').trim()
  pushBody(`${name}:migrate`, `${kind}${model ? ` ${shortModel(model)}` : ''}${reason ? `: ${reason}` : ''}`)
  const ran = await plannerRun($, drove.migrateArgs({ name, kind, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(reason ? { reason } : {}) }), { timeoutMs: SPAWN_TIMEOUT_MS })
  if (ran.exitCode !== 0) {
    dropBody(`${name}:migrate`)
    return answerOf(ran)
  }
  $.ui.toast(`${name} → ${kind}`)
  return answerOf(ran)
}

const closeWorker = async ($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> =>
  answerOf(await plannerRun($, drove.closeArgs(String(input.name ?? '').trim(), input.remove_worktree === true)))

const mergeWorker = async ($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> => {
  const name = String(input.name ?? '').trim()
  if (!NAME_RE.test(name)) return { deny: `Worker names must match [a-z][a-z0-9_-]{0,31}; got "${name}".` }
  const message = typeof input.message === 'string' && input.message.trim() ? input.message.trim() : undefined
  return answerOf(await plannerRun($, drove.mergeArgs({ name, pr: input.pr === true, squash: input.squash === true, fresh: input.fresh === true, ...(message ? { message } : {}) }), { timeoutMs: MERGE_TIMEOUT_MS }))
}

const runChecksTool = async ($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> => {
  const name = String(input.name ?? '').trim()
  if (!NAME_RE.test(name)) return { deny: `Worker names must match [a-z][a-z0-9_-]{0,31}; got "${name}".` }
  return answerOf(await plannerRun($, drove.checksArgs(name, input.fresh === true), { timeoutMs: MERGE_TIMEOUT_MS }))
}

const setGoalTool = async ($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> => {
  const goal = String(input.goal ?? '').replace(/\s+/g, ' ').trim()
  if (!goal) return { deny: 'The goal is empty; give one plain line of what the run is doing.' }
  const cairn = typeof input.cairn === 'string' && input.cairn.trim() ? input.cairn.trim() : undefined
  if (cairn && !CAIRN_RE.test(cairn)) return { deny: `cairn must look like CCS-12; got "${cairn}".` }
  const orchestrator = await read($, orchestratorAtom)
  if (!orchestrator) return { deny: OFF }
  const ran = await plannerRun($, drove.goalArgs(orchestrator.run, cairn), { stdin: goal })
  if (ran.exitCode === 0) {
    await update($, orchestratorAtom, current => (current ? { ...current, goal } : current))
    await persist($)
  }
  return answerOf(ran)
}

const globsOf = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean) : undefined

const setOwnsTool = async ($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> => {
  const name = String(input.name ?? '').trim()
  if (!NAME_RE.test(name)) return { deny: `Worker names must match [a-z][a-z0-9_-]{0,31}; got "${name}".` }
  const add = globsOf(input.add)
  const set = globsOf(input.set)
  if ((add === undefined) === (set === undefined)) return { deny: 'Give add or set (a list of globs), one of them.' }
  const globs = add ?? set ?? []
  if (globs.length === 0) return { deny: 'The list is empty: an empty owns would lift the limit, so it is refused.' }
  const orchestrator = await read($, orchestratorAtom)
  if (!orchestrator) return { deny: OFF }
  return answerOf(await plannerRun($, drove.ownsArgs(orchestrator.run, name, add ? 'add' : 'set', globs)))
}

const rosterTool = async ($: EngineInterface): Promise<ToolAnswer> => {
  const orchestrator = await read($, orchestratorAtom)
  return orchestrator ? answerOf(await plannerRun($, drove.rosterArgs(orchestrator.run))) : { deny: OFF }
}

const readReportsTool = async ($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> => {
  const orchestrator = await read($, orchestratorAtom)
  if (!orchestrator) return { deny: OFF }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined
  return answerOf(await plannerRun($, drove.reportsArgs(orchestrator.run, name, input.all === true)))
}

// ---------- the bridge: Drove's watcher in a child process, streaming wakes, the roster and events ----------

const onBridgeLine = async ($: EngineInterface, line: BridgeLine) => {
  const now = await $.clock.now()
  if (line.t === 'ready') {
    bridgeTries = 0
    await update($, bridgeAtom, () => ({ state: 'up', since: now }) satisfies OrchBridge)
    return
  }
  if (line.t === 'busy') {
    await update($, bridgeAtom, () => ({ state: 'busy', detail: `pid ${line.pid}`, since: now }) satisfies OrchBridge)
    return
  }
  if (line.t === 'fatal') {
    await update($, bridgeAtom, () => ({ state: 'failed', detail: line.text, since: now }) satisfies OrchBridge)
    return
  }
  if (line.t === 'error') {
    $.ui.log(`orchestrator: drove bridge ${line.step}: ${line.message}`, { to: 'debug' })
    return
  }
  if (line.t === 'run') {
    lastRun = line.run
    await update($, orchestratorAtom, current => (current ? { ...current, budget: line.run.budget, goal: line.run.goal ?? current.goal } : current))
    return
  }
  if (line.t === 'roster') {
    const [before, asksAt] = await Promise.all([read($, statusAtom), read($, asksAtAtom)])
    const nextAsks = { ...asksAt }
    for (const seat of line.roster.seats) {
      const was = before[seat.name]?.asking
      const is = line.status[seat.name]?.asking
      if (is && !was) {
        nextAsks[seat.name] = now
        $.ui.toast(`${seat.name} is waiting for you in its pane: ${oneLine(is, 120)}`, { timeoutMs: 15_000 })
        await record($, { at: now, from: seat.name, to: HUMAN, kind: 'asking', summary: is })
      } else if (!is && was) {
        delete nextAsks[seat.name]
        await record($, { at: now, from: HUMAN, to: seat.name, kind: 'answered', summary: 'answered in its pane' })
      }
    }
    await update($, seatsAtom, () => line.roster.seats)
    await update($, statusAtom, () => line.status)
    await update($, asksAtAtom, () => nextAsks)
    ensureAnimator($)
    return
  }
  if (line.t === 'events') {
    if (line.isInitial && (await read($, feedAtom)).length > 0) return
    for (const event of line.events) {
      const draft = feedOf(event, bodies)
      if (!draft) continue
      await record($, draft)
      if (line.isInitial) continue
      if (draft.kind === 'gone') $.ui.toast(`${draft.from}'s pane is gone`)
      if (draft.kind === 'blocked') $.ui.toast(`${draft.from} is ${draft.summary}`, { timeoutMs: 10_000 })
      if (draft.kind === 'failed' || draft.kind === 'attention') $.ui.toast(`${draft.from === '⌘' ? draft.to : draft.from}: ${oneLine(draft.summary, 100)}`, { timeoutMs: 10_000 })
    }
    return
  }
  const blocks = splitWake(line.text)
  if (blocks.length > 0) {
    await update($, feedAtom, feed => {
      const next = [...feed]
      for (const block of blocks) {
        for (let at = next.length - 1; at >= 0; at -= 1) {
          const entry = next[at]
          if (entry && entry.from === block.seat && entry.kind === block.kind && entry.full === entry.summary) {
            next[at] = { ...entry, full: block.text.slice(0, FULL_MAX) }
            break
          }
        }
      }
      return next
    })
    $.ui.toast(toastOf(blocks))
    if (config.effortRouting && blocks.some(({ kind }) => kind !== 'done')) pendingRouting = true
  }
  const wake = line.text
  // A wake is submitted as one line per report, all the person sees and all the model gets: a row appended at turn.start lands after the
  // turn's request is built, so the planner reads the full reports with read_reports.
  const text = blocks.length > 0 ? wakeHeadlines(blocks) : wake
  await sendWake($, text)
}

const superviseBridge = async ($: EngineInterface, run: string, epoch: number) => {
  const [sessionId, home, startedAt] = await Promise.all([$.session.id(), droveHome($), $.clock.now()])
  if (epoch !== bridgeEpoch) return
  await update($, bridgeAtom, current => (current?.state === 'busy' ? current : ({ state: 'starting', since: startedAt }) satisfies OrchBridge))
  let buffer = ''
  let stderr = ''
  let isBusy = false
  let fatal: string | undefined
  let code: number | null | undefined
  try {
    const stream = $.process.spawn({ argv: [config.nodePath, entryOf($), ...drove.bridgeArgs(run, sessionId)], env: home ? { DROVE_HOME: home } : {} })
    bridgeStream = stream as never
    for await (const chunk of stream) {
      if (epoch !== bridgeEpoch) break
      if (chunk.stream === 'stderr') {
        stderr = `${stderr}${chunk.text}`.slice(-600)
        continue
      }
      const split = splitLines(buffer + chunk.text)
      buffer = split.rest
      for (const raw of split.lines) {
        const line = parseLine(raw)
        if (!line) continue
        if (line.t === 'busy') isBusy = true
        if (line.t === 'fatal') fatal = line.text
        await onBridgeLine($, line)
      }
    }
    if (epoch === bridgeEpoch) code = (await stream.result.catch(() => undefined))?.code
  } catch (error) {
    stderr = `${stderr}${messageOf(error)}`
  }
  if (epoch !== bridgeEpoch) return
  bridgeStream = undefined
  const now = await $.clock.now()
  if (code === BRIDGE_EXIT.detached) {
    await detach($, run)
    return
  }
  if (code === BRIDGE_EXIT.fatal || fatal) {
    await update($, bridgeAtom, () => ({ state: 'failed', detail: oneLine(fatal ?? stderr, 160), since: now }) satisfies OrchBridge)
    $.ui.toast(`Orchestrator: the Drove bridge stopped: ${oneLine(fatal ?? stderr, 120)}`, { timeoutMs: 15_000 })
    return
  }
  bridgeTries = now - startedAt > 60_000 ? 0 : bridgeTries + 1
  if (bridgeTries === 3) $.ui.toast(`Orchestrator: the Drove bridge keeps exiting (${oneLine(stderr || `exit ${code ?? '?'}`, 100)}); retrying`, { timeoutMs: 15_000 })
  await update($, bridgeAtom, () => (isBusy ? { state: 'busy', since: now } : { state: 'starting', detail: oneLine(stderr || `exited ${code ?? '?'}`, 160), since: now }) satisfies OrchBridge)
  soon($, backoffMs(bridgeTries, isBusy), async () => {
    if (epoch === bridgeEpoch) await superviseBridge($, run, epoch)
  })
}

const startBridge = ($: EngineInterface, run: string) => {
  bridgeEpoch += 1
  bridgeTries = 0
  const epoch = bridgeEpoch
  void quietly(() => superviseBridge($, run, epoch))
}

// Ending the stream kills the child; nothing waits on it, so turning the mode off never hangs on the bridge.
const endBridge = () => {
  bridgeEpoch += 1
  const stream = bridgeStream
  bridgeStream = undefined
  if (stream) void quietly(() => stream.return())
}

const stopBridge = async ($: EngineInterface) => {
  endBridge()
  await update($, bridgeAtom, () => null)
}

const clearOrchestration = async ($: EngineInterface) => {
  await stopBridge($)
  await closeBoard($)
  await update($, orchestratorAtom, () => null)
  await update($, seatsAtom, () => [])
  await update($, statusAtom, () => ({}))
  await update($, asksAtAtom, () => ({}))
  await update($, feedAtom, () => [])
  await update($, scrollAtom, () => 0)
  await update($, expandedAtom, () => null)
  await update($, leadAtom, () => null)
  await update($, pendingGoalAtom, () => null)
  await update($, pendingWakesAtom, () => [])
  await persist($)
}

const detach = async ($: EngineInterface, run: string) => {
  const isDown = lastRun?.id === run && lastRun.status === 'down'
  await clearOrchestration($)
  $.ui.toast(isDown ? `Drove run ${run} is down; orchestrator mode is off.` : `Drove run ${run} has another planner now; orchestrator mode is off here.`, { timeoutMs: 15_000 })
}

// ---------- worker side: a Claude worker that Drove launched ----------

let workerToken: string | undefined
let isModelNoticePending = false
let workerStatus: OrchModStatus = {}
let workerStatusAt = 0
let workerCtxSent: number | undefined
let isWorkerAsking = false
const STATUS_EVERY_MS = 10_000

const workerPaths = (self: OrchWorkerSelf) => ({
  roster: `${self.home}/runs/${self.run}/roster.json`,
  status: `${self.home}/runs/${self.run}/seats/${self.name}/mod.json`,
  token: `${self.home}/runs/${self.run}/seats/${self.name}/token`,
})

// The module variable is lost when the mod reloads while workerAtom survives, so the seat token is re-read from the env, then from its file.
const workerTokenOf = async ($: EngineInterface, self: OrchWorkerSelf): Promise<string | undefined> => {
  if (workerToken) return workerToken
  try {
    workerToken = (await $.env.get('DROVE_TOKEN')) || undefined
  } catch {
    // fall back to the seat's token file
  }
  if (workerToken) return workerToken
  try {
    workerToken = (await $.fs.read(workerPaths(self).token)).trim() || undefined
  } catch {
    // no token: the envelope reads as unverified
  }
  return workerToken
}

const refreshSelf = async ($: EngineInterface) => {
  const self = await read($, workerAtom)
  if (!self) return
  try {
    const roster = JSON.parse(await $.fs.read(workerPaths(self).roster)) as { seats?: Seat[] }
    const seat = roster.seats?.find(({ name }) => name === self.name)
    if (seat && (seat.model !== self.model || seat.effort !== self.effort)) {
      await update($, workerAtom, current => (current ? { ...current, model: seat.model || undefined, effort: seat.effort } : current))
      $.ui.invalidate('prompt.section')
    }
  } catch {
    // keep the last known model and effort
  }
}

const writeStatus = async ($: EngineInterface, patch: OrchModStatus) => {
  const self = await read($, workerAtom)
  if (!self) return
  try {
    const now = await $.clock.now()
    workerStatusAt = now
    workerStatus = { ...workerStatus, ...patch, at: new Date(now).toISOString() }
    workerCtxSent = workerStatus.ctx
    await $.fs.write(workerPaths(self).status, JSON.stringify(workerStatus))
  } catch {
    // the board just misses one update
  }
}

const noteActivity = async ($: EngineInterface, text: string) => {
  if (isWorkerAsking || text === workerStatus.activity) return
  if ((await $.clock.now()) - workerStatusAt < STATUS_EVERY_MS) return
  await writeStatus($, { activity: text })
}

const questionOf = (input: Record<string, unknown>): string => {
  const questions = input.questions
  const first = Array.isArray(questions) ? (questions[0] as { question?: unknown } | undefined) : undefined
  return typeof first?.question === 'string' ? first.question : 'a question'
}

const startWorker = async ($: EngineInterface) => {
  const [run, seat, token, home] = await Promise.all([$.env.get('DROVE_RUN'), $.env.get('DROVE_SEAT'), $.env.get('DROVE_TOKEN'), homeDir($)])
  if (!run || !seat) return
  workerToken = token || undefined
  await update($, workerAtom, current => (current?.name === seat && current.run === run ? current : { name: seat, run, home }))
  await refreshSelf($)
}

// The turn a promote notice wakes is not work that owes a report; a progress report after it keeps Drove from reading it as idle-without-report.
const acknowledgeModel = async ($: EngineInterface) => {
  const self = await read($, workerAtom)
  if (!self) return
  const args = { kind: 'progress', summary: `now running on ${self.model ? shortModel(self.model) : 'its current model'}${self.effort ? ` at ${self.effort} effort` : ''}`, expects: 'none' }
  try {
    await runDrove($, ['mod', 'report'], { stdin: JSON.stringify(args) })
  } catch {
    // the roster just misses one progress line
  }
}

const handleControl = async ($: EngineInterface, text: string): Promise<string | undefined> => {
  const located = locateEnvelope(text)
  if (!located) return undefined
  const self = await read($, workerAtom)
  const isVerified = self ? await verifyEnvelope(located.envelope, await workerTokenOf($, self)) : false
  const { fields } = located.envelope
  let notice = ''
  if (isVerified && (fields.kind === 'promote' || fields.kind === 'demote')) {
    const effort = isEffort(fields.effort) ? fields.effort : undefined
    await update($, workerAtom, current => (current ? { ...current, ...(fields.model ? { model: fields.model } : {}), ...(effort ? { effort } : {}) } : current))
    $.ui.toast(`${fields.kind === 'promote' ? 'Promoted' : 'Moved'} to ${fields.model ? shortModel(fields.model) : 'the same model'} at ${effort ?? 'the same'} effort`)
    $.ui.invalidate('prompt.section')
    const moved = await read($, workerAtom)
    notice = `\n${modelNotice(moved?.model, moved?.effort)}`
    isModelNoticePending = true
  }
  return `${located.before}${renderControl(located.envelope, isVerified)}${notice}`
}

// ---------- board, pills, mode ----------

let animatorRuns = false

const animate = async ($: EngineInterface) => {
  try {
    const [orchestrator, seats, asksAt, lead, now] = await Promise.all([read($, orchestratorAtom), read($, seatsAtom), read($, asksAtAtom), read($, leadAtom), $.clock.now()])
    if (!orchestrator || !needsAnimation(lead, seats, asksAt, now) || !(await isBoardOpen($))) {
      animator?.cancel()
      animator = undefined
      animatorRuns = false
      return
    }
    await update($, frameAtom, frame => (frame + 1) % 1000)
  } catch {
    animator?.cancel()
    animator = undefined
    animatorRuns = false
  }
}

const ensureAnimator = ($: EngineInterface) => {
  if (animatorRuns) return
  animatorRuns = true
  animator = $.clock.every(FRAME_MS, () => void animate($))
}

const isBoardOpen = async ($: EngineInterface): Promise<boolean> => {
  try {
    return (await $.ui.panes()).some(pane => pane.id === BOARD_ID)
  } catch {
    return false
  }
}

const openBoard = async ($: EngineInterface) => {
  try {
    await $.ui.open({ id: BOARD_ID, title: 'orchestra' })
    ensureAnimator($)
  } catch {
    // no surface to draw on (a -p run)
  }
}

const closeBoard = async ($: EngineInterface) => {
  try {
    await $.ui.close({ id: BOARD_ID })
  } catch {
    // not open
  }
}

type Attached = { ok: true; run: RunMeta } | { ok: false; text: string }

const attachRun = async ($: EngineInterface, input: { goal?: string; run?: string; budget?: number; cwd?: string }): Promise<Attached> => {
  const [sessionId, paneId, sessionCwd, home] = await Promise.all([$.session.id(), herdrPane($), $.session.cwd(), droveHome($)])
  const cwd = input.cwd ?? sessionCwd
  const ran = await runDrove(
    $,
    drove.attachArgs({ sessionId, paneId, goal: input.goal, model: config.orchestratorModel, effort: config.orchestratorEffort, budget: input.budget, run: input.run }),
    { cwd, env: home ? { DROVE_HOME: home } : {} },
  )
  const result = drove.jsonResultOf<{ run: RunMeta }>(ran)
  const run = drove.runOf(result)
  return run ? { ok: true, run } : { ok: false, text: result.ok ? 'Drove returned no run' : `${result.text} [${result.code}]` }
}

// The mod held a goal the run never got: write it through Drove, so run.json, the board and the other planners see it.
const pushGoal = async ($: EngineInterface, run: RunMeta, goal: string) => {
  const home = await droveHome($)
  const ran = await runDrove($, drove.goalArgs(run.id), { stdin: goal, cwd: run.repo, env: drove.plannerEnv(run.id, home) })
  if (ran.exitCode === 0) run.goal = goal
}

const restore = async ($: EngineInterface) => {
  try {
    const sessionId = await $.session.id()
    const legacy = (await $.store.get(`${LEGACY_PREFIX}${sessionId}`)) as { orchestrator?: unknown; workers?: { status?: string }[] } | undefined
    if (legacy?.orchestrator) {
      const open = (legacy.workers ?? []).filter(({ status }) => status !== 'closed' && status !== 'gone').length
      $.ui.toast(`An orchestration from the old orchestrator mod was found for this session; its ${open} open worker(s) were not adopted (they use the retired protocol). Close their panes by hand.`, { timeoutMs: 20_000 })
      await $.store.delete(`${LEGACY_PREFIX}${sessionId}`)
    }
    const saved = (await $.store.get(`${STORE_PREFIX}${sessionId}`)) as { run?: string; goal?: string; startedAt?: number; pendingGoal?: string; pendingWakes?: string[] } | undefined
    if (!saved?.run) return
    const attached = await attachRun($, { run: saved.run })
    if (!attached.ok) {
      await $.store.delete(`${STORE_PREFIX}${sessionId}`)
      await update($, orchestratorAtom, () => null)
      $.ui.toast(`Orchestrator: run ${saved.run} could not be re-attached (${attached.text}); orchestrator mode is off.`, { timeoutMs: 15_000 })
      return
    }
    const now = await $.clock.now()
    const heldGoal = (await read($, orchestratorAtom))?.goal ?? saved.goal
    if (!attached.run.goal && heldGoal) await pushGoal($, attached.run, heldGoal)
    await update($, orchestratorAtom, current => ({
      run: attached.run.id,
      repo: attached.run.repo,
      goal: attached.run.goal ?? current?.goal ?? saved.goal,
      startedAt: current?.startedAt ?? saved.startedAt ?? now,
      budget: attached.run.budget,
    }))
    lastRun = attached.run
    await registerOrchestratorTools($)
    await openBoard($)
    startBridge($, attached.run.id)
    // A prompt set pending before this load never finished (the process ended, or a hot reload cancelled its timer): the person's next prompt carries it.
    const pendingGoal = (await read($, pendingGoalAtom)) ?? (typeof saved.pendingGoal === 'string' ? saved.pendingGoal : null)
    const atomWakes = await read($, pendingWakesAtom)
    const pendingWakes = atomWakes.length > 0 ? atomWakes : stringsOf(saved.pendingWakes) ?? []
    if (pendingGoal) {
      await update($, pendingGoalAtom, () => pendingGoal)
      $.ui.toast(`Drove: the goal was not sent to the planner. Press Enter (or type anything) to start.`, { timeoutMs: 15_000 })
    }
    if (pendingWakes.length > 0) {
      await update($, pendingWakesAtom, () => pendingWakes)
      $.ui.toast(`Drove: a worker report could not be delivered to the planner. Press Enter to receive it.`, { timeoutMs: 15_000 })
    }
  } catch {
    // nothing saved
  }
}

const statusText = async ($: EngineInterface): Promise<string> => {
  const [orchestrator, bridge] = await Promise.all([read($, orchestratorAtom), read($, bridgeAtom)])
  if (!orchestrator) return 'Orchestrator mode is off. `/orchestrate <goal>` turns it on.'
  const roster = await plannerRun($, drove.rosterArgs(orchestrator.run))
  return [
    `Orchestrator mode is on · Drove run ${orchestrator.run} on ${orchestrator.repo}${orchestrator.goal ? ` · goal: ${orchestrator.goal}` : ''} · bridge ${bridge?.state ?? 'not started'}${bridge?.detail ? ` (${bridge.detail})` : ''}.`,
    roster.exitCode === 0 ? roster.stdout.trim() : `roster unavailable: ${drove.failureOf(roster).text}`,
  ].join('\n')
}

// $.prompt.submit rejects when the engine refuses the call and resolves { drop } when a hook (another plugin's, or a settings hook) refuses
// the prompt. Either way the prompt never reached the planner, and nothing else records it.
const submitPrompt = async ($: EngineInterface, input: { text: string; asUser?: true }): Promise<{ isSent: boolean; reason?: string }> => {
  try {
    const result = await $.prompt.submit(input)
    return result.drop === undefined ? { isSent: true } : { isSent: false, reason: result.drop }
  } catch (error) {
    return { isSent: false, reason: messageOf(error) }
  }
}

// Submit once the session is idle, retry once, then hand the failure over. isWanted is asked before each attempt: a person's own prompt may
// have carried the text by then.
const deliverPrompt = (
  $: EngineInterface,
  input: { text: string; asUser?: true },
  handlers: { isWanted: () => Promise<boolean>; onSent: () => Promise<void>; onFailed: (reason?: string) => Promise<void> },
) => {
  const attempt = async (isLast: boolean) => {
    if (!(await handlers.isWanted())) return
    const sent = await submitPrompt($, input)
    if (sent.isSent) await handlers.onSent()
    else if (isLast) await handlers.onFailed(sent.reason)
    else soon($, RETRY_MS, () => attempt(true))
  }
  soon($, 0, () => attempt(false))
}

const reasonOf = (reason?: string): string => (reason ? ` (${oneLine(reason, 100)})` : '')

// The goal is pending from the first attempt until a submit lands, in the atom (it outlives a hot reload, which cancels the timers) and in
// the store (it outlives the process); `restore` toasts one that was never cleared. Drove has no command that writes an event to a run, so
// a goal.unsent event is not recorded: the toast and the pending goal are.
const sendGoal = async ($: EngineInterface, goal: string) => {
  await update($, pendingGoalAtom, () => goal)
  await persist($)
  deliverPrompt($, { text: goal, asUser: true }, {
    isWanted: async () => (await read($, pendingGoalAtom)) === goal,
    onSent: async () => {
      await update($, pendingGoalAtom, current => (current === goal ? null : current))
      await persist($)
    },
    onFailed: async reason => {
      $.ui.toast(`Drove: the goal was not sent to the planner${reasonOf(reason)}. Press Enter (or type anything) to start.`, { timeoutMs: 15_000 })
    },
  })
}

// Drove counts a wake as delivered once the bridge line is written and never redelivers it, so a wake is pending here until a submit lands,
// and goes ahead of the person's next prompt, like a pending goal.
let lastWakeToastAt = 0

const sendWake = async ($: EngineInterface, text: string) => {
  await update($, pendingWakesAtom, list => [...list, text].slice(-PENDING_WAKES_MAX))
  await persist($)
  deliverPrompt($, { text }, {
    isWanted: async () => (await read($, pendingWakesAtom)).includes(text),
    onSent: async () => {
      await update($, pendingWakesAtom, list => {
        const at = list.indexOf(text)
        return at < 0 ? list : [...list.slice(0, at), ...list.slice(at + 1)]
      })
      await persist($)
    },
    onFailed: async reason => {
      const now = await $.clock.now()
      if (now - lastWakeToastAt < 10_000) return
      lastWakeToastAt = now
      $.ui.toast(`Drove: a worker report could not be delivered to the planner${reasonOf(reason)}. Press Enter to receive it.`, { timeoutMs: 15_000 })
    },
  })
}

// Where the session started ($.session.root: it follows /cd but not a shell cd), against the repository its cwd resolves to now.
// A planner's own `cd` moves the cwd, so a drifted session would otherwise bind a run to a repository nobody chose.
const launchDrift = async ($: EngineInterface): Promise<{ cwd: string; root: string; repo: string } | undefined> => {
  try {
    const [cwd, root, repo] = await Promise.all([$.session.cwd(), $.session.root(), $.session.repo()])
    if (!repo) return undefined
    const top = repo.root.replace(/\/+$/, '')
    return root === top || root.startsWith(`${top}/`) ? undefined : { cwd, root, repo: top }
  } catch {
    return undefined
  }
}

const launchDirOf = async ($: EngineInterface): Promise<string> => {
  try {
    return await $.session.root()
  } catch {
    return $.session.cwd()
  }
}

// `~` and a relative dir resolve against the home and the session's launch directory, never the drifted cwd.
const dirOf = async ($: EngineInterface, dir: string): Promise<string> => {
  if (dir.startsWith('/')) return dir.replace(/\/+$/, '') || '/'
  if (dir === '~' || dir.startsWith('~/')) return `${(await $.env.get('HOME')) ?? ''}${dir.slice(1)}`.replace(/\/+$/, '')
  return `${(await launchDirOf($)).replace(/\/+$/, '')}/${dir.replace(/^\.\//, '')}`
}

const REPO_FORM = '`/orchestrate --repo <dir> <goal>` attaches to the repository at <dir>.'

const helpText = (): string =>
  [
    'Orchestrator mode turns this session into a Drove planner.',
    '`/orchestrate <goal>`: on, in the repository this session is in; the planner starts on the goal.',
    '`/orchestrate --repo <dir> [goal]`: on, in the repository at <dir>. When it is already on, it switches only if the current run has no open workers.',
    '`/orchestrate status`, `/orchestrate board`, `/orchestrate board bg`, `/orchestrate off`.',
  ].join('\n')

// A fresh run, a switched one or a re-attached one: bind this session to it and tell the planner where it is.
const startRun = async ($: EngineInterface, run: RunMeta, goal: string, previous: OrchOrchestrator | null) => {
  const now = await $.clock.now()
  await update($, orchestratorAtom, () => ({ run: run.id, repo: run.repo, goal: goal || run.goal, startedAt: now, budget: run.budget }) satisfies OrchOrchestrator)
  lastRun = run
  await registerOrchestratorTools($)
  await persist($)
  await setLead($, goal ? 'planning' : 'waiting for a goal')
  await openBoard($)
  startBridge($, run.id)
  if (goal) await sendGoal($, goal)
  return {
    text: [
      `Orchestrator mode is on: Drove run ${run.id} on \`${run.repo}\`, ${shortModel(config.orchestratorModel)} at ${config.orchestratorEffort} effort or more, no code edits, up to ${run.budget} worker panes before a dialog.`,
      previous ? `Switched from run ${previous.run} on \`${previous.repo}\`; it had no open workers and stays up in Drove.` : '',
      goal ? '' : 'Give it a goal in your next prompt.',
    ]
      .filter(Boolean)
      .join('\n'),
    context: [`${await humanNameOf($)} switched this session into orchestrator mode on \`${run.repo}\`${goal ? ` for: ${goal}` : ''}. Follow the "Orchestrator mode" section of your instructions from now on.`],
  }
}

const turnOn = async ($: EngineInterface, goal: string, options: { repo?: string } = {}) => {
  const current = await read($, orchestratorAtom)
  if (current && !options.repo) {
    if (goal) {
      await update($, orchestratorAtom, state => (state ? { ...state, goal } : state))
      await persist($)
      await sendGoal($, goal)
    }
    return { text: `Orchestrator mode is already on (Drove run ${current.run} on \`${current.repo}\`).` }
  }
  if (!(await herdrPane($))) return { text: 'This session is not in a herdr pane (HERDR_PANE_ID is unset), so it cannot orchestrate workers. Start Claude in a herdr pane first.' }
  if (current) {
    const open = openSeats(await read($, seatsAtom))
    if (open.length > 0) {
      return { text: `Orchestrator mode is on in Drove run ${current.run} on \`${current.repo}\` with ${open.length} open worker(s) (${open.map(({ name }) => name).join(', ')}), so it will not switch to ${options.repo}. Close them, or \`/orchestrate off\`, then run this again.` }
    }
  }
  let cwd: string | undefined
  if (options.repo) cwd = await dirOf($, options.repo)
  else {
    const drift = await launchDrift($)
    if (drift) {
      let answer = ''
      try {
        answer = await $.ui.ask(`Attach to \`${drift.repo}\`? This session started in \`${drift.root}\`.`, { header: 'Drove repo', options: ['Attach', 'Cancel'] })
      } catch {
        answer = ''
      }
      if (answer !== 'Attach') {
        return { text: `Orchestrator mode was not turned on: this session started in \`${drift.root}\` and is now in \`${drift.cwd}\`, in \`${drift.repo}\`. ${REPO_FORM}` }
      }
    }
  }
  const attached = await attachRun($, { goal: goal || undefined, budget: current?.budget ?? config.maxWorkers, ...(cwd ? { cwd } : {}) })
  if (!attached.ok) return { text: `Orchestrator mode could not ${current ? 'switch' : 'start'}: Drove said ${attached.text}${options.repo || !attached.text.includes('not-a-repo') ? '' : ` ${REPO_FORM}`}` }
  if (current && attached.run.id === current.run) {
    if (goal) {
      await update($, orchestratorAtom, state => (state ? { ...state, goal } : state))
      await persist($)
      await sendGoal($, goal)
    }
    return { text: `Orchestrator mode is already on (Drove run ${current.run} on \`${current.repo}\`).` }
  }
  if (current) await clearOrchestration($)
  return startRun($, attached.run, goal, current)
}

const turnOff = async ($: EngineInterface) => {
  const [orchestrator, seats] = await Promise.all([read($, orchestratorAtom), read($, seatsAtom)])
  if (!orchestrator) return { text: 'Orchestrator mode is already off.' }
  const open = openSeats(seats)
  let isClosing = false
  if (open.length > 0) {
    try {
      isClosing = (await $.ui.ask(`Stop the ${open.length} open worker(s) (${open.map(({ name }) => name).join(', ')}) with drove down? Their sessions are saved for drove up.`, ['Stop them', 'Leave them running'])) === 'Stop them'
    } catch {
      isClosing = false
    }
  }
  const down = isClosing ? await runDrove($, drove.downArgs(orchestrator.run), { cwd: orchestrator.repo, env: (await droveHome($)) ? { DROVE_HOME: (await droveHome($)) ?? '' } : {} }) : undefined
  await clearOrchestration($)
  const closing = down ? (down.exitCode === 0 ? ` ${down.stdout.trim()}` : ` drove down failed: ${drove.failureOf(down).text}`) : open.length > 0 ? ` ${open.length} worker(s) left running in run ${orchestrator.run}; \`/orchestrate\` in this session re-attaches it.` : ''
  return {
    text: `Orchestrator mode is off.${closing}`,
    context: [`${await humanNameOf($)} turned orchestrator mode off: you may edit code again, and the orchestrator tools no longer work.`],
  }
}

const OFF = 'Orchestrator mode is off.'
const toolFailure = (error: unknown): string => `The orchestrator tool failed: ${messageOf(error)}`

type Pill = { key: string; text: string; bg: string }

const STATE_COLOR: Record<Seat['state'], string> = {
  starting: COLOR.surface1,
  working: COLOR.blue,
  idle: COLOR.green,
  done: COLOR.green,
  blocked: COLOR.red,
  'needs-input': COLOR.red,
  unknown: COLOR.surface1,
  gone: COLOR.surface1,
  closing: COLOR.surface1,
  closed: COLOR.surface1,
  down: COLOR.surface1,
}

const TONE: Record<Tone, string> = {
  lead: COLOR.mauve,
  working: COLOR.blue,
  good: COLOR.green,
  warn: COLOR.yellow,
  alert: COLOR.red,
  muted: COLOR.overlay,
  dim: COLOR.surface1,
  text: COLOR.text,
  you: COLOR.peach,
}

export const pillsFor = (orchestrator: OrchOrchestrator | null, seats: readonly Seat[], status: Readonly<Record<string, OrchModStatus>>, self: OrchWorkerSelf | null): Pill[] => {
  if (orchestrator) {
    const open = openSeats(seats)
    return [
      { key: 'role', text: `⌘ orchestrator · ${open.length}/${orchestrator.budget}`, bg: COLOR.mauve },
      ...open.map(seat => {
        const asking = isAsking(seat, status[seat.name])
        return {
          key: `w:${seat.name}`,
          text: `${asking ? '?' : statusGlyph(seat.state)} ${seat.name} ${modelLetter(seat)}·${effortLetter(seat.effort)}`,
          bg: asking ? COLOR.red : STATE_COLOR[seat.state],
        }
      }),
    ]
  }
  if (self) {
    const model = self.model ?? config.workerModel
    return [
      { key: 'role', text: `⚒ ${self.name} → planner`, bg: COLOR.peach },
      { key: 'model', text: `${shortModel(model)}${self.effort ? ` · ${self.effort}` : ''}`, bg: model === config.workerModel ? COLOR.surface1 : COLOR.yellow },
    ]
  }
  return []
}

export const register: Register = (on, options) => {
  configure(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    leanTrims = undefined
    lastWakeToastAt = 0
    if (!e.isInteractive || (await isSummariser($))) return started
    const role = await $.env.get('DROVE_ROLE')
    if (role === 'worker') {
      await startWorker($)
      return started
    }
    isDrovePlanner = role === 'planner'
    await $.command.register({
      name: 'orchestrate',
      description: 'Turn this session into a Drove planner: Opus plans, delegates to Claude or Codex workers in herdr panes, and reviews; it never edits code',
      argumentHint: '[goal] | --repo <dir> [goal] | status | board | board bg | off | help',
    })
    if (isDrovePlanner) return started
    await restore($)
    try {
      if ((await $.store.get('boardBg')) === false) await update($, boardBgAtom, () => false)
    } catch {
      // default: no background
    }
    void pruneStore($)
    return started
  })

  on('session.end', async ($, e, next) => {
    endBridge()
    animator?.cancel()
    animator = undefined
    animatorRuns = false
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('command.run', { command: 'orchestrate' }, async ($, e) => {
    if (await read($, workerAtom)) return { text: 'This session is a Drove worker; it cannot orchestrate.' }
    if (isDrovePlanner) return { text: 'This session is already a Drove planner (started by drove plan); use its drove tools.' }
    const args = e.args.trim()
    if (args === 'status') return { text: await statusText($) }
    if (args === 'off') return turnOff($)
    if (args === 'board bg') {
      const isOn = !(await read($, boardBgAtom))
      await update($, boardBgAtom, () => isOn)
      try {
        await $.store.set('boardBg', isOn)
      } catch {
        // kept for this session only
      }
      return { text: isOn ? `Board background painted ${BOARD_BG} (Catppuccin Mocha base). \`/orchestrate board bg\` again to remove it.` : 'Board background removed.' }
    }
    if (args === 'board') {
      if (!(await read($, orchestratorAtom))) return { text: 'Orchestrator mode is off. `/orchestrate <goal>` turns it on.' }
      if (await isBoardOpen($)) {
        await closeBoard($)
        return { text: 'Board hidden. `/orchestrate board` shows it again.' }
      }
      await openBoard($)
      return { text: 'Board shown.' }
    }
    if (args === 'help') return { text: helpText() }
    const flag = repoFlagOf(args)
    if (flag) return 'error' in flag ? { text: `${flag.error}\n${helpText()}` } : turnOn($, flag.goal, { repo: flag.repo })
    return turnOn($, args)
  })

  on('tool.call', { tool: 'mcp__orchestrator__spawn_worker' as never }, async ($, e): Promise<ToolAnswer> =>
    (await read($, orchestratorAtom)) ? spawnWorker($, e as Record<string, unknown>) : { deny: OFF },
  ).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__message_worker' as never }, async ($, e): Promise<ToolAnswer> =>
    (await read($, orchestratorAtom)) ? messageWorker($, e as Record<string, unknown>) : { deny: OFF },
  ).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__review_verdict' as never }, async ($, e): Promise<ToolAnswer> =>
    (await read($, orchestratorAtom)) ? reviewVerdict($, e as Record<string, unknown>) : { deny: OFF },
  ).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__promote_worker' as never }, async ($, e): Promise<ToolAnswer> =>
    (await read($, orchestratorAtom)) ? moveWorker($, e as Record<string, unknown>, 'promote') : { deny: OFF },
  ).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__demote_worker' as never }, async ($, e): Promise<ToolAnswer> =>
    (await read($, orchestratorAtom)) ? moveWorker($, e as Record<string, unknown>, 'demote') : { deny: OFF },
  ).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__migrate_worker' as never }, async ($, e): Promise<ToolAnswer> =>
    (await read($, orchestratorAtom)) ? migrateWorker($, e as Record<string, unknown>) : { deny: OFF },
  ).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__close_worker' as never }, async ($, e): Promise<ToolAnswer> =>
    (await read($, orchestratorAtom)) ? closeWorker($, e as Record<string, unknown>) : { deny: OFF },
  ).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__merge_worker' as never }, async ($, e): Promise<ToolAnswer> =>
    (await read($, orchestratorAtom)) ? mergeWorker($, e as Record<string, unknown>) : { deny: OFF },
  ).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__run_checks' as never }, async ($, e): Promise<ToolAnswer> =>
    (await read($, orchestratorAtom)) ? runChecksTool($, e as Record<string, unknown>) : { deny: OFF },
  ).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__set_goal' as never }, async ($, e): Promise<ToolAnswer> => setGoalTool($, e as Record<string, unknown>)).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__set_owns' as never }, async ($, e): Promise<ToolAnswer> => setOwnsTool($, e as Record<string, unknown>)).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__roster' as never }, async ($): Promise<ToolAnswer> => rosterTool($)).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__read_reports' as never }, async ($, e): Promise<ToolAnswer> => readReportsTool($, e as Record<string, unknown>)).catch(($, e, next) => ({
    deny: toolFailure(next.error),
  }))

  on('tool.call', async ($, e, next) => {
    const [orchestrator, self] = await Promise.all([read($, orchestratorAtom), read($, workerAtom)])
    if (orchestrator) {
      if (drove.GUARDED_TOOLS.has(e.tool)) {
        const [cwd, sessionId, home] = await Promise.all([$.session.cwd(), $.session.id(), droveHome($)])
        const ran = await runDrove($, ['guard', 'pre-tool-use'], {
          cwd,
          env: drove.plannerEnv(orchestrator.run, home),
          stdin: drove.guardStdin(e.tool, e as Record<string, unknown>, cwd, sessionId),
          timeoutMs: GUARD_TIMEOUT_MS,
        })
        const verdict = drove.guardVerdictOf(ran, entryOf($))
        if (!verdict.allow) return { deny: verdict.reason }
      }
      if (e.agentId !== undefined) return next(e)
      await setLead($, describeLeadTool(e.tool, e as Record<string, unknown>))
      try {
        return await next(e)
      } finally {
        await setLead($, 'thinking')
      }
    }
    if (self) {
      if (e.agentId !== undefined) return next(e)
      if (e.tool === 'AskUserQuestion') {
        isWorkerAsking = true
        await writeStatus($, { asking: `asking in its pane: ${questionOf(e as Record<string, unknown>)}` })
        try {
          return await next(e)
        } finally {
          isWorkerAsking = false
          await writeStatus($, { asking: undefined, activity: 'got an answer' })
        }
      }
      await noteActivity($, describeLeadTool(e.tool, e as Record<string, unknown>))
      try {
        return await next(e)
      } finally {
        if (isWorkerAsking) {
          isWorkerAsking = false
          await writeStatus($, { asking: undefined, activity: 'permission answered' })
        }
      }
    }
    return next(e)
  }).catch(async ($, e, next) => {
    if (next.called) return undefined
    const orchestrator = await read($, orchestratorAtom)
    return orchestrator ? { deny: drove.brokenGuard(`the guard hook failed: ${messageOf(next.error)}`, entryOf($)) } : next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const [orchestrator, self] = await Promise.all([read($, orchestratorAtom), read($, workerAtom)])
    if (orchestrator) return { sections: [...composed.sections, { id: 'orchestrator:role', text: orchestratorSection(orchestrator, { ...config, humanName: await humanNameOf($), trims: await trimsOf($) }), scope: 'session' as const }] }
    const model = self ? workerModelSection(self) : undefined
    if (model) return { sections: [...composed.sections, { id: 'orchestrator:worker-model', text: model, scope: 'session' as const }] }
    return composed
  })

  on('prompt.submit', async ($, e, next) => {
    const self = await read($, workerAtom)
    if (self && e.text.includes(DROVE_OPEN)) {
      const text = await handleControl($, e.text)
      return text === undefined ? next(e) : next({ ...e, text })
    }
    const orchestrator = await read($, orchestratorAtom)
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const goal = orchestrator && !orchestrator.goal && isPerson ? goalFromPrompt(e.text) : undefined
    if (orchestrator && goal) {
      await update($, orchestratorAtom, current => (current && !current.goal ? { ...current, goal } : current))
      await persist($)
      await setLead($, 'planning')
      await attachRun($, { run: orchestrator.run, goal, cwd: orchestrator.repo })
    }
    // A goal or a worker report that never reached the planner rides on the person's next prompt (or is that prompt, when it is empty).
    const [pendingGoal, pendingWakes] = orchestrator && isPerson ? await Promise.all([read($, pendingGoalAtom), read($, pendingWakesAtom)]) : [null, []]
    const isBlank = e.text.trim() === ''
    if ((pendingGoal || pendingWakes.length > 0) && (isBlank || goalFromPrompt(e.text) !== undefined)) {
      await update($, pendingGoalAtom, () => null)
      await update($, pendingWakesAtom, () => [])
      await persist($)
      const parts = [...(pendingGoal && !e.text.includes(pendingGoal) ? [pendingGoal] : []), ...pendingWakes, ...(isBlank ? [] : [e.text])]
      return next(parts.length === 1 && !isBlank ? e : { ...e, text: parts.join('\n\n') })
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('turn.start', async ($, e, next) => {
    if (await read($, orchestratorAtom)) await setLead($, 'thinking')
    if (await read($, workerAtom)) await refreshSelf($)
    if (pendingRouting) {
      routingTurnId = e.turnId
      pendingRouting = false
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const [orchestrator, self] = await Promise.all([read($, orchestratorAtom), read($, workerAtom)])
    if (orchestrator) {
      const model = e.model.startsWith(config.orchestratorModel) ? e.model : config.orchestratorModel
      const effort = config.effortRouting && e.turnId === routingTurnId ? 'medium' : raiseEffort(e.effort, config.orchestratorEffort)
      if (model !== e.model || effort !== e.effort) return yield* next({ ...e, model, effort })
      return yield* next(e)
    }
    if (self) {
      const model = self.model && !e.model.startsWith(self.model) ? self.model : e.model
      const effort = self.effort ?? e.effort
      if (model !== e.model || effort !== e.effort) return yield* next({ ...e, model, effort })
    }
    return yield* next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [orchestrator, seats, status, self] = await Promise.all([read($, orchestratorAtom), read($, seatsAtom), read($, statusAtom), read($, workerAtom)])
    const pills = pillsFor(orchestrator, seats, status, self)
    if (pills.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" flexWrap="wrap">
          {pills.map(({ key, text, bg }, at) => (
            <Box key={key} flexDirection="row" flexShrink={0}>
              {at === 0 ? null : <Text color={COLOR.surface1}>{'│ '}</Text>}
              <Text color={bg === COLOR.surface1 ? COLOR.overlay : bg} bold={at === 0}>
                {`${text} `}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  on('session.measure', async ($, e, next) => {
    if (await read($, workerAtom)) {
      const { percent, tokens, window } = e.context
      const value = percent ?? (tokens !== undefined && window > 0 ? (tokens / window) * 100 : undefined)
      if (value !== undefined) {
        const ctx = Math.round(value)
        if ((workerCtxSent === undefined || Math.abs(ctx - workerCtxSent) >= 3) && !isWorkerAsking && (await $.clock.now()) - workerStatusAt >= STATUS_EVERY_MS) await writeStatus($, { ctx })
      }
    }
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if ((await read($, workerAtom)) && /permission/i.test(`${e.notification_type} ${e.message}`) && !isWorkerAsking) {
      isWorkerAsking = true
      await writeStatus($, { asking: `needs permission in its pane: ${oneLine(e.message, 140)}` })
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && isModelNoticePending) {
      isModelNoticePending = false
      await acknowledgeModel($)
    }
    if (e.agentId === undefined && (await read($, orchestratorAtom))) {
      const hasWorkers = openSeats(await read($, seatsAtom)).length > 0
      await setLead($, hasWorkers ? 'waiting for workers' : 'idle')
    }
    return next(e)
  })

  on('ui.scroll', { component: 'Pane', requestId: BOARD_ID }, async ($, e) => {
    const [feed, seats] = await Promise.all([read($, feedAtom), read($, seatsAtom)])
    const most = Math.max(0, feed.length - timelineRoom(e.bodyRows, openSeats(seats).length))
    await update($, scrollAtom, back => Math.max(0, Math.min(most, Math.min(back, most) - e.by)))
    return {}
  }).catch(() => ({}))

  on('ui.render', { component: 'Pane', requestId: BOARD_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [orchestrator, seats, status, asksAt, bridge, feed, lead, frame, isPainted, scrollBack, expanded, now] = await Promise.all([
      read($, orchestratorAtom),
      read($, seatsAtom),
      read($, statusAtom),
      read($, asksAtAtom),
      read($, bridgeAtom),
      read($, feedAtom),
      read($, leadAtom),
      read($, frameAtom),
      read($, boardBgAtom),
      read($, scrollAtom),
      read($, expandedAtom),
      $.clock.now(),
    ])
    if (!orchestrator) return <Text dimColor>Orchestrator mode is off.</Text>
    const columns = e.props.bodyColumns
    const rows = e.props.scroll.bodyRows
    const board = buildBoard({
      orchestrator,
      seats,
      status,
      asksAt,
      bridge,
      feed,
      lead,
      leadModel: config.orchestratorModel,
      leadEffort: config.orchestratorEffort,
      now,
      frame,
      scrollBack,
      expanded,
      offsetMinutes: new Date(now).getTimezoneOffset(),
      columns,
      rows,
    })
    const bg = isPainted ? BOARD_BG : undefined
    const text = (item: Cell, key: string) => (
      <Text key={key} color={TONE[item.tone]} backgroundColor={bg} bold={item.isBold} wrap="truncate-end">
        {item.text}
      </Text>
    )
    const cell = (item: Cell, key: string, isFlexible: boolean) => (
      <Box key={key} width={isFlexible ? undefined : item.width} flexShrink={isFlexible ? 1 : 0} flexGrow={isFlexible ? 1 : 0} minWidth={0}>
        {text(item, `${key}:t`)}
      </Box>
    )
    const row = (key: string, cells: Cell[]) => {
      const flexible = cells.findIndex(item => item.width === undefined)
      return (
        <Box key={key} flexDirection="row" columnGap={1} width={columns}>
          {cells.map((item, at) => cell(item, `${key}:${at}`, at === flexible))}
        </Box>
      )
    }
    const toggle = (id: string | undefined) => async () => {
      if (!id) return
      await update($, expandedAtom, current => (current === id ? null : id))
    }
    const feedRow = (item: BoardRow) => {
      const cells = item.cells.slice(0, -1)
      const last = item.cells.at(-1)
      return (
        <Box key={item.key} flexDirection="column" width={columns}>
          <Box key={`${item.key}:line`} flexDirection="row" columnGap={1} width={columns}>
            {cells.map((part, at) => cell(part, `${item.key}:${at}`, false))}
            <Box key={`${item.key}:msg`} width={last?.width} flexShrink={0} overflow="hidden">
              <Button key={`${item.key}:press`} plain label={last?.text ?? ''} dimColor={last?.tone === 'dim'} onPress={toggle(item.id)} />
            </Box>
          </Box>
          {item.isExpanded ? (
            <Box key={`${item.key}:full`} flexDirection="column" paddingLeft={EXPAND_INDENT} width={columns}>
              {(item.lines ?? []).map((line, at) => (
                <Text key={`${item.key}:full:${at}`} color={TONE.text} backgroundColor={bg} wrap="truncate-end">
                  {line || ' '}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      )
    }
    const rule = `── ${board.feedTitle} `
    return (
      <Box flexDirection="column" width={columns} height={isPainted ? rows : undefined} backgroundColor={bg}>
        <Box key="head" flexDirection="row" columnGap={2} width={columns}>
          <Box flexDirection="row" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
            <Box key="brand" flexShrink={0}>{board.title[0] ? text(board.title[0], 'title:0') : null}</Box>
            <Box key="goal" flexShrink={1} minWidth={0}>{board.title[1] ? text(board.title[1], 'title:1') : null}</Box>
          </Box>
          <Box flexDirection="row" columnGap={1} flexShrink={0}>
            {board.progress.map((item, at) => text(item, `progress:${at}`))}
          </Box>
        </Box>
        <Text key="gap1" backgroundColor={bg}> </Text>
        {row(board.lead.key, board.lead.cells)}
        {board.workers.map(item => row(item.key, item.cells))}
        {board.empty ? <Text key="empty" color={TONE.muted} backgroundColor={bg}>{board.empty}</Text> : null}
        <Text key="gap2" backgroundColor={bg}> </Text>
        <Text key="rule" color={TONE.dim} backgroundColor={bg} wrap="truncate-end">{`${rule}${'─'.repeat(Math.max(0, columns - rule.length))}`}</Text>
        {board.feed.length === 0 ? <Text key="nofeed" color={TONE.muted} backgroundColor={bg}>Briefs, reports and verdicts appear here.</Text> : board.feed.map(item => feedRow(item))}
      </Box>
    )
  })
}
