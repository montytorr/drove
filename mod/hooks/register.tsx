import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { AgentKind, Effort, OrchBridge, OrchFeedEntry, OrchModStatus, OrchOrchestrator, OrchWorkerSelf, RunMeta, Seat } from '../types'
import { BOARD_ID, EXPAND_INDENT, buildBoard, needsAnimation, timelineRoom } from './board'
import type { BoardRow, Cell, Tone } from './board'
import { BRIDGE_EXIT, backoffMs, feedOf, parseLine, splitLines, splitWake, toastOf, wakeContext, wakeHeadlines } from './bridge'
import type { BridgeLine, FeedDraft } from './bridge'
import * as drove from './drove'
import { modelNotice, orchestratorSection, workerModelSection } from './prompts'
import { CAIRN_RE, DEFAULT_HUMAN_NAME, DROVE_OPEN, HUMAN, NAME_RE, isEffort, isExpects, locateEnvelope, oneLine, raiseEffort, renderControl, shortModel, verifyEnvelope } from './protocol'
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
let feedCount = 0
const FULL_MAX = 4000
const BOARD_BG = '#1e1e2e'
const FRAME_MS = 250
const SPAWN_TIMEOUT_MS = 300_000
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
    const [orchestrator, sessionId, now] = await Promise.all([read($, orchestratorAtom), $.session.id(), $.clock.now()])
    const key = `${STORE_PREFIX}${sessionId}`
    if (orchestrator) await $.store.set(key, { run: orchestrator.run, goal: orchestrator.goal, startedAt: orchestrator.startedAt, savedAt: now })
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
    name: 'roster',
    description: 'Orchestrator mode: list the workers, their state, model, effort, last report and what you owe them.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const REPORT_TOOL = {
  name: 'report',
  description:
    "Worker mode: report to your planner (the same as Drove's own report tool, mcp__drove__report). kind: done (finished and verified; expects review), question (you need a decision; for: human when only the human can decide), blocked, promote (you need a stronger model or more effort; say why), progress (optional, expects nothing). summary is one line; details carries the rest (branch, files, test output).",
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['done', 'question', 'blocked', 'promote', 'progress'] },
      summary: { type: 'string', description: 'one line' },
      details: { type: 'string' },
      expects: { type: 'string', enum: ['review', 'answer', 'none'], description: 'default: done → review, progress → none, others → answer' },
      for: { type: 'string', enum: ['orchestrator', 'human', 'cal'], description: 'question only: who must decide (cal is an old alias of human)' },
    },
    required: ['kind', 'summary'],
  },
} as const

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
  const args = drove.spawnArgs({ name, kind, effort, model, ...(cairnText ? { cairn: cairnText } : {}) })
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

const rosterTool = async ($: EngineInterface): Promise<ToolAnswer> => {
  const orchestrator = await read($, orchestratorAtom)
  return orchestrator ? answerOf(await plannerRun($, drove.rosterArgs(orchestrator.run))) : { deny: OFF }
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
    await update($, orchestratorAtom, current => (current ? { ...current, budget: line.run.budget, goal: current.goal ?? line.run.goal } : current))
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
  const text = blocks.length > 0 ? wakeHeadlines(blocks) : wake
  if (text !== wake) hiddenWakes.set(text, [...(hiddenWakes.get(text) ?? []), wake])
  soon($, 0, async () => {
    const submitted = await $.prompt.submit({ text })
    if (submitted.drop !== undefined) takeHiddenWake(text)
  })
}

// A wake is submitted as its headlines, which is all the person sees. A plugin's own prompt skips its prompt.submit hooks, so the turn it starts
// gets the full reports instead: turn.start appends them as a user row the person does not see (isMeta), keyed by the headlines.
const hiddenWakes = new Map<string, string[]>()

const takeHiddenWake = (text: string): string | undefined => {
  const key = hiddenWakes.has(text) ? text : [...hiddenWakes.keys()].find(headlines => text.includes(headlines))
  if (key === undefined) return undefined
  const [wake, ...rest] = hiddenWakes.get(key) ?? []
  if (rest.length > 0) hiddenWakes.set(key, rest)
  else hiddenWakes.delete(key)
  return wake
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
  await $.tool.register(REPORT_TOOL as never)
  await refreshSelf($)
}

const sendReport = async ($: EngineInterface, input: Record<string, unknown>): Promise<ToolAnswer> => {
  if (!(await read($, workerAtom))) return { deny: 'This session is not a Drove worker.' }
  const forWho = input.for === 'cal' || input.for === 'human' ? { for: 'human' } : {}
  const args = { kind: input.kind, summary: input.summary, ...(input.details !== undefined ? { details: input.details } : {}), ...(input.expects !== undefined ? { expects: input.expects } : {}), ...forWho }
  const result = drove.jsonResultOf(await runDrove($, ['mod', 'report'], { stdin: JSON.stringify(args) }))
  return result.ok ? { result: result.text } : { deny: `Not recorded: ${result.text}. Use mcp__drove__report, or tell ${await humanNameOf($)} in your answer.` }
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

const attachRun = async ($: EngineInterface, input: { goal?: string; run?: string; budget?: number }): Promise<Attached> => {
  const [sessionId, paneId, cwd, home] = await Promise.all([$.session.id(), herdrPane($), $.session.cwd(), droveHome($)])
  const ran = await runDrove(
    $,
    drove.attachArgs({ sessionId, paneId, goal: input.goal, model: config.orchestratorModel, effort: config.orchestratorEffort, budget: input.budget, run: input.run }),
    { cwd, env: home ? { DROVE_HOME: home } : {} },
  )
  const result = drove.jsonResultOf<{ run: RunMeta }>(ran)
  const run = drove.runOf(result)
  return run ? { ok: true, run } : { ok: false, text: result.ok ? 'Drove returned no run' : `${result.text} [${result.code}]` }
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
    const saved = (await $.store.get(`${STORE_PREFIX}${sessionId}`)) as { run?: string; goal?: string; startedAt?: number } | undefined
    if (!saved?.run) return
    const attached = await attachRun($, { run: saved.run })
    if (!attached.ok) {
      await $.store.delete(`${STORE_PREFIX}${sessionId}`)
      await update($, orchestratorAtom, () => null)
      $.ui.toast(`Orchestrator: run ${saved.run} could not be re-attached (${attached.text}); orchestrator mode is off.`, { timeoutMs: 15_000 })
      return
    }
    const now = await $.clock.now()
    await update($, orchestratorAtom, current => ({
      run: attached.run.id,
      repo: attached.run.repo,
      goal: current?.goal ?? saved.goal ?? attached.run.goal,
      startedAt: current?.startedAt ?? saved.startedAt ?? now,
      budget: attached.run.budget,
    }))
    lastRun = attached.run
    await registerOrchestratorTools($)
    await openBoard($)
    startBridge($, attached.run.id)
  } catch {
    // nothing saved
  }
}

const statusText = async ($: EngineInterface): Promise<string> => {
  const [orchestrator, bridge] = await Promise.all([read($, orchestratorAtom), read($, bridgeAtom)])
  if (!orchestrator) return 'Orchestrator mode is off. `/orchestrate <goal>` turns it on.'
  const roster = await plannerRun($, drove.rosterArgs(orchestrator.run))
  return [
    `Orchestrator mode is on · Drove run ${orchestrator.run}${orchestrator.goal ? ` · goal: ${orchestrator.goal}` : ''} · bridge ${bridge?.state ?? 'not started'}${bridge?.detail ? ` (${bridge.detail})` : ''}.`,
    roster.exitCode === 0 ? roster.stdout.trim() : `roster unavailable: ${drove.failureOf(roster).text}`,
  ].join('\n')
}

const turnOn = async ($: EngineInterface, goal: string) => {
  const current = await read($, orchestratorAtom)
  if (current) {
    if (goal) {
      await update($, orchestratorAtom, state => (state ? { ...state, goal } : state))
      await persist($)
      soon($, 0, () => $.prompt.submit({ text: goal, asUser: true }))
    }
    return { text: `Orchestrator mode is already on (Drove run ${current.run}).` }
  }
  if (!(await herdrPane($))) return { text: 'This session is not in a herdr pane (HERDR_PANE_ID is unset), so it cannot orchestrate workers. Start Claude in a herdr pane first.' }
  const attached = await attachRun($, { goal: goal || undefined, budget: config.maxWorkers })
  if (!attached.ok) return { text: `Orchestrator mode could not start: Drove said ${attached.text}` }
  const now = await $.clock.now()
  await update($, orchestratorAtom, () => ({ run: attached.run.id, repo: attached.run.repo, goal: goal || attached.run.goal, startedAt: now, budget: attached.run.budget }) satisfies OrchOrchestrator)
  lastRun = attached.run
  await registerOrchestratorTools($)
  await persist($)
  await setLead($, goal ? 'planning' : 'waiting for a goal')
  await openBoard($)
  startBridge($, attached.run.id)
  if (goal) soon($, 0, () => $.prompt.submit({ text: goal, asUser: true }))
  return {
    text: [
      `Orchestrator mode is on: Drove run ${attached.run.id}, ${shortModel(config.orchestratorModel)} at ${config.orchestratorEffort} effort or more, no code edits, up to ${attached.run.budget} worker panes before a dialog.`,
      goal ? '' : 'Give it a goal in your next prompt.',
    ]
      .filter(Boolean)
      .join('\n'),
    context: [`${await humanNameOf($)} switched this session into orchestrator mode${goal ? ` for: ${goal}` : ''}. Follow the "Orchestrator mode" section of your instructions from now on.`],
  }
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
      argumentHint: '[goal] | status | board | board bg | off',
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
  on('tool.call', { tool: 'mcp__orchestrator__roster' as never }, async ($): Promise<ToolAnswer> => rosterTool($)).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__report' as never }, async ($, e): Promise<ToolAnswer> => sendReport($, e as Record<string, unknown>)).catch(($, e, next) => ({
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
    if (orchestrator) return { sections: [...composed.sections, { id: 'orchestrator:role', text: orchestratorSection(orchestrator, { ...config, humanName: await humanNameOf($) }), scope: 'session' as const }] }
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
    if (orchestrator && !orchestrator.goal && isPerson && !e.text.trimStart().startsWith('/') && e.text.trim()) {
      await update($, orchestratorAtom, current => (current ? { ...current, goal: oneLine(e.text, 100) } : current))
      await persist($)
      await setLead($, 'planning')
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('turn.start', async ($, e, next) => {
    const wake = takeHiddenWake(e.text)
    if (wake) {
      try {
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: wakeContext(wake) }] } })
      } catch (error) {
        $.ui.log(`orchestrator: the full reports did not reach the planner: ${messageOf(error)}`, { to: 'debug' })
      }
    }
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
