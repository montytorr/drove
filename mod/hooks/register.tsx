import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { OrchEffort, OrchFeedEntry, OrchOrchestrator, OrchWorker, OrchWorkerSelf, OrchWorkerStatus } from '../types'
import { BOARD_ID, EXPAND_INDENT, buildBoard, needsAnimation, timelineRoom } from './board'
import type { BoardRow, Cell, Tone } from './board'
import { EDIT_TOOLS, WORKER_FORBIDDEN, bashReason, editPathOf, isInside, orchestratorDeny } from './guard'
import { BRIEF_FOOTER, orchestratorSection, workerSection } from './prompts'
import {
  NAME_RE,
  UNVERIFIED,
  defaultExpects,
  formatEnvelope,
  isEffort,
  isExpects,
  isReportKind,
  locateEnvelope,
  replaceEnvelope,
  raiseEffort,
  renderControl,
  renderReport,
  shortModel,
  stripToken,
} from './protocol'
import type { Expects, Located } from './protocol'
import {
  LIST_ARGV,
  agentStatusOf,
  closeArgv,
  effortLetter,
  findWorker,
  gridSlot,
  herdrError,
  makeToken,
  observe,
  oneLine,
  openWorkers,
  parseAgents,
  parseSplit,
  parseTab,
  promptArgv,
  pushFeed,
  replaceWorker,
  retryWhileBusy,
  rosterLines,
  splitArgv,
  startArgv,
  statusGlyph,
  tabCloseArgv,
  tabCreateArgv,
  tabGetArgv,
  workerEnvPairs,
} from './roster'

const TICK_MS = 5_000
const SLOW_TICKS = 6
const STORE_PREFIX = 'session:'
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
const workersAtom = atom({ plugin: 'orchestrator', key: 'workers' } as const, [] as OrchWorker[])
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

type Config = {
  orchestratorModel: string
  orchestratorEffort: OrchEffort
  workerModel: string
  promotedModel: string
  workerEffort: OrchEffort
  maxWorkers: number
  effortRouting: boolean
}

const config: Config = {
  orchestratorModel: 'claude-opus-5-5',
  orchestratorEffort: 'high',
  workerModel: 'claude-sonnet-5-5',
  promotedModel: 'claude-opus-5-5',
  workerEffort: 'medium',
  maxWorkers: 5,
  effortRouting: false,
}

const configure = (options: PluginOptions) => {
  const text = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value.trim() : fallback)
  config.orchestratorModel = text(options.orchestratorModel, config.orchestratorModel)
  config.workerModel = text(options.workerModel, config.workerModel)
  config.promotedModel = text(options.promotedModel, config.promotedModel)
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

let ticker: { cancel: () => void } | undefined
let isTicking = false
let tickCount = 0
let animator: { cancel: () => void } | undefined
let pendingRouting = false
let routingTurnId: string | undefined

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

const readWorkerEnv = async ($: EngineInterface): Promise<OrchWorkerSelf | null> => {
  try {
    const [parentSessionId, parentName, name, token, model, effort] = await Promise.all([
      $.env.get('CLAUDE_ORCH_PARENT'),
      $.env.get('CLAUDE_ORCH_PARENT_NAME'),
      $.env.get('CLAUDE_ORCH_WORKER'),
      $.env.get('CLAUDE_ORCH_TOKEN'),
      $.env.get('CLAUDE_ORCH_MODEL'),
      $.env.get('CLAUDE_ORCH_EFFORT'),
    ])
    if (!parentSessionId || !name || !token) return null
    return {
      name,
      parentSessionId,
      parentName: parentName || undefined,
      token,
      model: model || undefined,
      effort: isEffort(effort) ? effort : undefined,
    }
  } catch {
    return null
  }
}

const herdrPane = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    return (await $.env.get('HERDR_PANE_ID')) || undefined
  } catch {
    return undefined
  }
}

const herdrWorkspace = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    return (await $.env.get('HERDR_WORKSPACE_ID')) || undefined
  } catch {
    return undefined
  }
}

const closeTabIfEmpty = async ($: EngineInterface) => {
  const [orchestrator, workers] = await Promise.all([read($, orchestratorAtom), read($, workersAtom)])
  if (!orchestrator?.tabId || openWorkers(workers).some(worker => worker.paneId)) return
  await herdr($, tabCloseArgv(orchestrator.tabId))
  await update($, orchestratorAtom, current => (current ? { ...current, tabId: undefined } : current))
  await persist($)
}

const writableRoots = async ($: EngineInterface): Promise<string[]> => {
  const home = await $.env.get('HOME')
  return ['/tmp', '/private/tmp', ...(home ? [`${home}/.claude/plans`] : [])]
}

type Ran = { isOk: boolean; output: string }

const herdr = async ($: EngineInterface, argv: readonly string[], timeoutMs = 30_000): Promise<Ran> => {
  try {
    const { exitCode, stdout, stderr } = await $.process.run([...argv], { timeoutMs })
    const output = `${stdout}\n${stderr}`.trim()
    return { isOk: exitCode === 0 && herdrError(stdout) === undefined, output }
  } catch (error) {
    return { isOk: false, output: error instanceof Error ? error.message : String(error) }
  }
}

const persist = async ($: EngineInterface) => {
  try {
    const [orchestrator, workers, sessionId, now] = await Promise.all([read($, orchestratorAtom), read($, workersAtom), $.session.id(), $.clock.now()])
    const key = `${STORE_PREFIX}${sessionId}`
    if (orchestrator) await $.store.set(key, { orchestrator, workers, savedAt: now })
    else await $.store.delete(key)
  } catch {
    // persistence is best effort: the session's own state still holds
  }
}

const pruneStore = async ($: EngineInterface) => {
  try {
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX)) continue
      const saved = (await $.store.get(key)) as { savedAt?: number } | undefined
      if (!saved || typeof saved.savedAt !== 'number' || now - saved.savedAt > STORE_MAX_AGE_MS) await $.store.delete(key)
    }
  } catch {
    // nothing to prune
  }
}

const patchWorker = async ($: EngineInterface, worker: OrchWorker) => {
  await update($, workersAtom, workers => replaceWorker(workers, worker))
  await persist($)
}

const ORCHESTRATOR_TOOLS = [
  {
    name: 'spawn_worker',
    description:
      'Orchestrator mode: start a worker Claude session in a new herdr pane and give it a brief. It runs on Sonnet unless you say otherwise, reports back to you through the orchestrator mod, and can ask to be promoted. Up to the pane budget (5 open) without asking; beyond it Cal is asked in a dialog. Returns once the brief is delivered.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'short unique name, [a-z][a-z0-9_-]{0,31}, e.g. w-auth' },
        brief: { type: 'string', description: 'the full, standalone task: goal, files it owns, what not to touch, acceptance criteria, how to verify, git rules' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'low: mechanical; medium: standard (default); high: tricky logic or debugging' },
        model: { type: 'string', description: 'sonnet (default) or opus, or a full model id' },
        worktree: { type: 'boolean', description: 'true to give the worker its own git worktree and branch (overlapping or risky work)' },
        cairn: { type: 'string', description: 'the Cairn task ref for this piece (e.g. CCS-12), filed first with cairn add --no-start; the worker claims it' },
        cwd: { type: 'string', description: 'directory to start in; default: this session cwd' },
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
    description: 'Orchestrator mode: move a worker up. Raise its effort on Sonnet first (model: sonnet, effort: high or xhigh); move it to Opus (model: opus) when the problem needs deeper reasoning. Takes effect from its next request; a model change re-sends its context once.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        model: { type: 'string', description: 'opus (default) or sonnet, or a full model id' },
        effort: { type: 'string', enum: ['medium', 'high', 'xhigh', 'max'], description: 'default high' },
        reason: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'demote_worker',
    description: 'Orchestrator mode: move a promoted worker back to Sonnet once the hard part is done.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, effort: { type: 'string', enum: ['low', 'medium', 'high'] } },
      required: ['name'],
    },
  },
  {
    name: 'close_worker',
    description: 'Orchestrator mode: close a worker pane you opened, once its work is approved and committed or no longer needed.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'roster',
    description: 'Orchestrator mode: list the workers, their status, model, effort and last report.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const REPORT_TOOL = {
  name: 'report',
  description:
    'Worker mode: report to your orchestrator. kind: done (finished and verified; expects review), question (you need a decision; for: cal when only Cal can decide), blocked, promote (you need a stronger model or more effort; say why), progress (optional, expects nothing). summary is one line; details carries the rest (branch, files, test output).',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['done', 'question', 'blocked', 'promote', 'progress'] },
      summary: { type: 'string', description: 'one line' },
      details: { type: 'string' },
      expects: { type: 'string', enum: ['review', 'answer', 'none'], description: 'default: done → review, progress → none, others → answer' },
      for: { type: 'string', enum: ['orchestrator', 'cal'], description: 'question only: who must decide' },
    },
    required: ['kind', 'summary'],
  },
} as const

const registerOrchestratorTools = async ($: EngineInterface) => {
  for (const tool of ORCHESTRATOR_TOOLS) await $.tool.register(tool as never)
}

const sessionName = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const [home, sessionId] = await Promise.all([$.env.get('HOME'), $.session.id()])
    if (!home) return undefined
    const dir = `${home}/.claude/sessions`
    for (const { name, kind } of await $.fs.list(dir)) {
      if (kind !== 'file' || !/^\d+\.json$/.test(name)) continue
      try {
        const entry = JSON.parse(await $.fs.read(`${dir}/${name}`)) as { sessionId?: string; name?: string }
        if (entry.sessionId === sessionId && typeof entry.name === 'string') return entry.name
      } catch {
        // a registry file being rewritten
      }
    }
  } catch {
    // no registry
  }
  return undefined
}

const record = async ($: EngineInterface, entry: Omit<OrchFeedEntry, 'at'>) => {
  const at = await $.clock.now()
  feedCount += 1
  const id = `${at.toString(36)}-${feedCount}`
  const full = entry.summary.trim().slice(0, FULL_MAX)
  await update($, feedAtom, feed => pushFeed(feed, { ...entry, id, full, summary: oneLine(entry.summary), at }))
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
  mcp__orchestrator__demote_worker: input => `moving ${String(input.name ?? '')} back to Sonnet`,
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

const sendControl = async (
  $: EngineInterface,
  worker: OrchWorker,
  kind: string,
  expects: Expects,
  body: string,
  extra: Record<string, string | undefined> = {},
): Promise<string | undefined> => {
  if (!worker.sessionId) return `${worker.name} has not checked in yet (no session id); try again in a few seconds`
  const text = formatEnvelope({ to: worker.name, kind, expects, ...extra, token: worker.token }, body)
  try {
    const sent = await $.session.send({ to: { sessionId: worker.sessionId }, text })
    if (sent.isDelivered) await record($, { from: '⌘', to: worker.name, kind, summary: extra.verdict ? `${extra.verdict}: ${body}` : body })
    return sent.isDelivered ? undefined : sent.reason
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const deliverBrief = async ($: EngineInterface, name: string, paneId: string, text: string): Promise<string | undefined> => {
  const ran = await herdr($, promptArgv(name, text), 20_000)
  const code = herdrError(ran.output)
  if (code === undefined || code === 'timeout') return undefined
  if (code !== 'agent_prompt_stalled') return `${code}: ${ran.output.slice(0, 300)}`
  const listed = await herdr($, LIST_ARGV, 10_000)
  const status = agentStatusOf(parseAgents(listed.output.split('\n')[0] ?? ''), paneId)
  return status === 'working' || status === 'blocked' ? undefined : 'herdr typed the brief but saw no activity within 5 s (agent_prompt_stalled); it may still have landed, so check the pane before sending it again'
}

const spawnWorker = async ($: EngineInterface, input: Record<string, unknown>) => {
  const name = String(input.name ?? '').trim()
  const brief = String(input.brief ?? '').trim()
  if (!NAME_RE.test(name)) return { deny: `Worker names must match [a-z][a-z0-9_-]{0,31}; got "${name}".` }
  if (!brief) return { deny: 'A worker needs a brief.' }
  const effort = isEffort(input.effort) ? input.effort : config.workerEffort
  const model = resolveModel(input.model, config.workerModel)
  const isWorktree = input.worktree === true
  const cairnRef = typeof input.cairn === 'string' && /^[A-Z][A-Z0-9]*-\d+$/.test(input.cairn.trim()) ? input.cairn.trim() : undefined
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : await $.session.cwd()

  const sourcePane = await herdrPane($)
  if (!sourcePane) return { deny: 'This session is not running in a herdr pane (HERDR_PANE_ID is unset), so it cannot open worker panes.' }
  const workers = await read($, workersAtom)
  if (findWorker(workers, name)) return { deny: `A worker named ${name} is already open. Pick another name or message it.` }
  const open = openWorkers(workers)
  if (open.length >= config.maxWorkers) {
    let answer = ''
    try {
      answer = await $.ui.ask(`Open worker pane ${open.length + 1} (${name}, ${shortModel(model)} ${effort})? ${open.length} are open; the budget is ${config.maxWorkers}.`, {
        header: 'Worker pane',
        options: ['Open it', 'Not now'],
      })
    } catch {
      answer = ''
    }
    if (answer !== 'Open it') return { deny: `Cal did not approve worker pane ${open.length + 1}. Reuse or close an open worker first.` }
  }

  const [parentSessionId, parentName, now] = await Promise.all([$.session.id(), sessionName($), $.clock.now()])
  const entry: OrchWorker = { name, token: makeToken(now), cwd, model, effort, isWorktree, status: 'starting', spawnedAt: now, cairnRef }
  await update($, workersAtom, list => [...list.filter(worker => worker.name !== name), entry])
  await persist($)

  const env = workerEnvPairs({ parentSessionId, parentName, name, token: entry.token, model, effort })
  const placed = open.filter(worker => worker.paneId)
  const orchestrator = await read($, orchestratorAtom)
  const knownTab = orchestrator?.tabId
  const isTabAlive = knownTab !== undefined && (await herdr($, tabGetArgv(knownTab), 10_000)).isOk
  let createdTab: string | undefined

  const drop = async (paneId?: string) => {
    if (createdTab) await herdr($, tabCloseArgv(createdTab))
    else if (paneId) await herdr($, closeArgv(paneId))
    await update($, workersAtom, list => list.filter(worker => worker.token !== entry.token))
    await persist($)
  }

  let paneId: string | undefined
  let failure = ''
  const slot = isTabAlive ? gridSlot(placed) : undefined
  if (slot) {
    const split = await herdr($, splitArgv(slot.anchor, slot.direction, cwd, env))
    paneId = split.isOk ? parseSplit(split.output.split('\n')[0] ?? '') : undefined
    failure = split.output
  } else {
    if (isTabAlive && knownTab) await herdr($, tabCloseArgv(knownTab))
    const workspace = (await herdrWorkspace($)) ?? sourcePane.split(':')[0] ?? ''
    const made = await herdr($, tabCreateArgv(workspace, cwd, `workers · ${parentName ?? 'orchestrator'}`, env))
    const tab = made.isOk ? parseTab(made.output.split('\n')[0] ?? '') : undefined
    failure = made.output
    if (tab) {
      createdTab = tab.tabId
      paneId = tab.paneId
      await update($, orchestratorAtom, current => (current ? { ...current, tabId: tab.tabId } : current))
    }
  }
  if (!paneId) {
    await drop()
    return { deny: `herdr could not open a worker pane: ${failure.slice(0, 300)}` }
  }

  const started = await herdr($, retryWhileBusy(startArgv(name, paneId, model, effort, isWorktree ? name : undefined)), 120_000)
  if (!started.isOk) {
    if (herdrError(started.output) === 'agent_not_ready') {
      await patchWorker($, { ...entry, paneId, status: 'blocked' })
      $.ui.toast(`Worker ${name} is waiting on a dialog in pane ${paneId}`, { timeoutMs: 10_000 })
      return { result: `Worker ${name} started in pane ${paneId} but stopped on a dialog at startup (folder trust or similar). Ask Cal to answer it in that pane, then send the brief with message_worker.` }
    }
    await drop(paneId)
    return { deny: `herdr could not start Claude in pane ${paneId}, so that pane was closed again and no worker exists: ${started.output.slice(0, 300)}` }
  }

  await patchWorker($, { ...entry, paneId, status: 'working', lastWorkingAt: now })
  const briefError = await deliverBrief($, name, paneId, `${brief}${BRIEF_FOOTER(name, cairnRef)}`)
  await record($, { from: '⌘', to: name, kind: 'brief', summary: `${shortModel(model)} ${effort}${isWorktree ? ' · worktree' : ''} · ${brief}` })
  $.ui.toast(`Worker ${name}: ${shortModel(model)} ${effort}${isWorktree ? ', own worktree' : ''}`)
  return {
    result: [
      `Worker ${name} is running in pane ${paneId} on ${shortModel(model)} at ${effort} effort${isWorktree ? ' in its own worktree' : ''}.`,
      briefError ? `The brief may not have arrived: ${briefError}.` : 'The brief was delivered. Its reports will arrive here as messages; do not poll.',
    ].join(' '),
  }
}

const workerOr = async ($: EngineInterface, input: Record<string, unknown>) => {
  const name = String(input.name ?? '').trim()
  const worker = findWorker(await read($, workersAtom), name)
  return { name, worker }
}

const messageWorker = async ($: EngineInterface, input: Record<string, unknown>) => {
  const { name, worker } = await workerOr($, input)
  if (!worker) return { deny: `No open worker is named ${name}.` }
  const text = String(input.text ?? '').trim()
  if (!text) return { deny: 'The message is empty.' }
  const expects = isExpects(input.expects) ? input.expects : 'none'
  const failed = await sendControl($, worker, 'message', expects, text)
  return failed ? { deny: `Not delivered to ${name}: ${failed}` } : { result: `Sent to ${name} (expects ${expects}).` }
}

const APPROVED =
  'Approved. Commit only your own paths now (git add <paths>; never -A or .), on your branch. Do not push. Then confirm with a done report carrying the branch and commit sha, expects none, and stop.'

const reviewVerdict = async ($: EngineInterface, input: Record<string, unknown>) => {
  const { name, worker } = await workerOr($, input)
  if (!worker) return { deny: `No open worker is named ${name}.` }
  const verdict = input.verdict === 'approve' ? 'approve' : input.verdict === 'changes' ? 'changes' : undefined
  if (!verdict) return { deny: 'verdict must be approve or changes.' }
  const notes = String(input.notes ?? '').trim()
  if (verdict === 'changes' && !notes) return { deny: 'Say which changes are needed in notes.' }
  const body = verdict === 'approve' ? [notes, APPROVED].filter(Boolean).join('\n\n') : `${notes}\n\nFix these, verify again, then send a done report.`
  const failed = await sendControl($, worker, 'verdict', verdict === 'approve' ? 'none' : 'review', body, { verdict })
  if (failed) return { deny: `Not delivered to ${name}: ${failed}` }
  await patchWorker($, { ...worker, status: 'working' })
  return { result: `Verdict ${verdict} sent to ${name}.` }
}

const moveWorker = async ($: EngineInterface, input: Record<string, unknown>, direction: 'promote' | 'demote') => {
  const { name, worker } = await workerOr($, input)
  if (!worker) return { deny: `No open worker is named ${name}.` }
  const model = direction === 'promote' ? resolveModel(input.model, config.promotedModel) : config.workerModel
  const effort = isEffort(input.effort) ? input.effort : direction === 'promote' ? 'high' : config.workerEffort
  const reason = String(input.reason ?? '').trim()
  const body = direction === 'promote'
    ? `Promoted to ${shortModel(model)} at ${effort} effort${reason ? `: ${reason}` : ''}. Carry on with the hard part.`
    : `Moved back to ${shortModel(model)} at ${effort} effort. Carry on.`
  const failed = await sendControl($, worker, direction, 'none', body, { model, effort })
  if (failed) return { deny: `Not delivered to ${name}: ${failed}` }
  await patchWorker($, { ...worker, model, effort })
  $.ui.toast(`${name} → ${shortModel(model)} ${effort}`)
  return { result: `${name} now runs on ${shortModel(model)} at ${effort} effort from its next request.` }
}

const closeWorker = async ($: EngineInterface, input: Record<string, unknown>) => {
  const { name, worker } = await workerOr($, input)
  if (!worker) return { deny: `No open worker is named ${name}.` }
  if (worker.paneId) {
    const closed = await herdr($, closeArgv(worker.paneId))
    if (!closed.isOk && !/not.?found|no such|unknown pane/i.test(closed.output)) return { deny: `herdr could not close pane ${worker.paneId}: ${closed.output.slice(0, 300)}` }
  }
  await patchWorker($, { ...worker, status: 'closed' })
  await record($, { from: '⌘', to: name, kind: 'close', summary: 'pane closed' })
  await closeTabIfEmpty($)
  const worktree = worker.isWorktree ? ` Its worktree (.claude/worktrees/${name}, branch worktree-${name}) is still on disk and locked: merge the branch, then remove it with git worktree remove --force .claude/worktrees/${name}.` : ''
  return { result: `Closed ${name}${worker.paneId ? ` (pane ${worker.paneId})` : ''}.${worktree}` }
}

const sendReport = async ($: EngineInterface, input: Record<string, unknown>) => {
  const self = await read($, workerAtom)
  if (!self) return { deny: 'This session is not an orchestrator worker.' }
  const kind = input.kind
  if (!isReportKind(kind) || kind === 'hello' || kind === 'status') return { deny: 'kind must be done, question, blocked, promote or progress.' }
  const summary = String(input.summary ?? '').split('\n')[0]?.trim() ?? ''
  if (!summary) return { deny: 'A report needs a one-line summary.' }
  const details = String(input.details ?? '').trim()
  const expects = isExpects(input.expects) ? input.expects : defaultExpects(kind)
  const forWho = kind === 'question' && input.for === 'cal' ? 'cal' : undefined
  const text = formatEnvelope({ worker: self.name, kind, expects, for: forWho, token: self.token }, [summary, details].filter(Boolean).join('\n\n'))
  try {
    const sent = await $.session.send({ to: { sessionId: self.parentSessionId }, text })
    if (!sent.isDelivered) return { deny: `Not delivered to the orchestrator: ${sent.reason}. Tell Cal in your answer instead.` }
  } catch (error) {
    return { deny: `Not delivered to the orchestrator: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { result: expects === 'none' ? 'Delivered. Nothing is expected back; carry on.' : `Delivered. The orchestrator owes you ${expects === 'review' ? 'a review' : 'an answer'}; wait for it (it arrives as a message) and end your turn now.` }
}

const sayHello = async ($: EngineInterface, self: OrchWorkerSelf) => {
  try {
    const sessionId = await $.session.id()
    const text = formatEnvelope({ worker: self.name, kind: 'hello', expects: 'none', session: sessionId, token: self.token }, `${self.name} is up.`)
    await $.session.send({ to: { sessionId: self.parentSessionId }, text })
  } catch {
    // the orchestrator also learns the session id from herdr
  }
}

let workerActivity = ''
let workerStatusAt = 0
let isWorkerAsking = false
let workerCtx: number | undefined
let workerCtxSent: number | undefined
const STATUS_EVERY_MS = 10_000

const sendStatus = async ($: EngineInterface, self: OrchWorkerSelf, state: 'working' | 'asking', text: string) => {
  try {
    const at = await $.clock.now()
    workerStatusAt = at
    workerActivity = text
    workerCtxSent = workerCtx
    const envelope = formatEnvelope({ worker: self.name, kind: 'status', expects: 'none', state, ctx: workerCtx === undefined ? undefined : String(workerCtx), token: self.token }, text)
    await $.session.send({ to: { sessionId: self.parentSessionId }, text: envelope })
  } catch {
    // the board just misses one update
  }
}

const noteActivity = async ($: EngineInterface, self: OrchWorkerSelf, text: string) => {
  if (isWorkerAsking || text === workerActivity) return
  const at = await $.clock.now()
  if (at - workerStatusAt < STATUS_EVERY_MS) return
  await sendStatus($, self, 'working', text)
}

const questionOf = (input: Record<string, unknown>): string => {
  const questions = input.questions
  const first = Array.isArray(questions) ? (questions[0] as { question?: unknown } | undefined) : undefined
  return typeof first?.question === 'string' ? first.question : 'a question'
}

const handleReport = async ($: EngineInterface, located: Located): Promise<{ consumed: string } | { text: string }> => {
  const { fields, body } = located.envelope
  const workers = await read($, workersAtom)
  const worker = workers.find(item => item.name === fields.worker && item.token === fields.token)
  const kind = fields.kind
  if (!worker || !isReportKind(kind)) return { text: replaceEnvelope(located, `${UNVERIFIED}\n${stripToken(formatEnvelope(fields, body))}`) }
  if (kind === 'status') {
    const isAsking = fields.state === 'asking'
    const at = await $.clock.now()
    const status: OrchWorkerStatus = isAsking ? 'blocked' : worker.status === 'done' && !body ? 'done' : 'working'
    const ctx = Number(fields.ctx)
    await patchWorker($, {
      ...worker,
      isAsking,
      status,
      activity: oneLine(body, 160) || worker.activity,
      ...(Number.isFinite(ctx) && fields.ctx !== undefined ? { ctx: Math.round(ctx) } : {}),
      ...(isAsking ? (worker.isAsking ? {} : { asksAt: at }) : { lastWorkingAt: at, asksAt: undefined }),
    })
    ensureAnimator($)
    if (isAsking && !worker.isAsking) {
      $.ui.toast(`${worker.name} is waiting for you in its pane: ${oneLine(body, 120)}`, { timeoutMs: 15_000 })
      await record($, { from: worker.name, to: 'Cal', kind: 'asking', summary: body })
    } else if (!isAsking && worker.isAsking) {
      await record($, { from: 'Cal', to: worker.name, kind: 'answered', summary: 'answered in its pane' })
    }
    return { consumed: `orchestrator: status from ${worker.name}` }
  }
  if (kind === 'hello') {
    await patchWorker($, { ...worker, sessionId: fields.session ?? worker.sessionId })
    await record($, { from: worker.name, to: '⌘', kind: 'hello', summary: 'checked in', isHidden: true })
    return { consumed: `orchestrator: ${worker.name} checked in` }
  }
  const expects = isExpects(fields.expects) ? fields.expects : defaultExpects(kind)
  const now = await $.clock.now()
  const status: OrchWorkerStatus = kind === 'done' ? 'done' : kind === 'blocked' ? 'blocked' : worker.status
  await patchWorker($, { ...worker, status, lastReport: { kind, summary: body.split('\n')[0] ?? '', at: now }, hasNudged: false })
  const isSwallowed = kind === 'progress' && expects === 'none'
  await record($, { from: worker.name, to: '⌘', kind, summary: `${expects !== 'none' ? `expects ${expects} · ` : ''}${body}`, isHidden: isSwallowed })
  if (isSwallowed) return { consumed: `orchestrator: progress from ${worker.name}` }
  if (config.effortRouting && kind !== 'done') pendingRouting = true
  $.ui.toast(`${worker.name}: ${kind}`)
  return { text: replaceEnvelope(located, renderReport(worker.name, kind, expects, body, fields.for === 'cal')) }
}

const handleControl = async ($: EngineInterface, located: Located): Promise<{ text: string }> => {
  const { fields, body } = located.envelope
  const self = await read($, workerAtom)
  if (!self || fields.token !== self.token || fields.to !== self.name) return { text: replaceEnvelope(located, `${UNVERIFIED}\n${stripToken(formatEnvelope(fields, body))}`) }
  const parent = self.parentName ?? 'parent'
  const kind = fields.kind ?? 'message'
  const expects = fields.expects ?? 'none'
  if (kind === 'promote' || kind === 'demote') {
    const model = fields.model ?? self.model
    const effort = isEffort(fields.effort) ? fields.effort : self.effort
    await update($, workerAtom, current => (current ? { ...current, model, effort } : current))
    $.ui.toast(`${kind === 'promote' ? 'Promoted' : 'Moved'} to ${model ? shortModel(model) : 'the same model'} at ${effort ?? 'the same'} effort`)
  }
  return { text: replaceEnvelope(located, renderControl(parent, kind, expects, body, kind === 'verdict' && fields.verdict ? `: ${fields.verdict}` : '')) }
}

const handleInbound = async ($: EngineInterface, text: string): Promise<{ consumed: string } | { text: string } | undefined> => {
  const located = locateEnvelope(text)
  if (!located) return undefined
  const [orchestrator, self] = await Promise.all([read($, orchestratorAtom), read($, workerAtom)])
  if (orchestrator && located.envelope.fields.worker !== undefined) return handleReport($, located)
  if (self && located.envelope.fields.to !== undefined) return handleControl($, located)
  return { text: stripToken(text) }
}

const tick = async ($: EngineInterface) => {
  if (isTicking) return
  isTicking = true
  try {
    tickCount += 1
    const [orchestrator, workers] = await Promise.all([read($, orchestratorAtom), read($, workersAtom)])
    if (!orchestrator || !openWorkers(workers).some(worker => worker.paneId)) return
    if (tickCount % SLOW_TICKS !== 0 && !(await isBoardOpen($))) return
    const listed = await herdr($, LIST_ARGV, 10_000)
    const agents = listed.isOk ? parseAgents(listed.output.split('\n')[0] ?? '') : undefined
    if (!agents) return
    const now = await $.clock.now()
    const observed = workers.map(worker => observe(worker, agents, now))
    if (observed.every(({ worker }, at) => worker === workers[at])) return
    await update($, workersAtom, () => observed.map(({ worker }) => worker))
    await persist($)
    for (const { worker, events } of observed) {
      if (events.includes('blocked')) $.ui.toast(`${worker.name} is blocked on a dialog in pane ${worker.paneId}`, { timeoutMs: 10_000 })
      if (events.includes('gone')) {
        $.ui.toast(`${worker.name}'s pane is gone`)
        await record($, { from: worker.name, to: '⌘', kind: 'gone', summary: 'its pane closed' })
      }
      if (events.includes('blocked')) await record($, { from: worker.name, to: '⌘', kind: 'blocked', summary: 'waiting on a dialog in its pane' })
      if (events.includes('idle-without-report')) {
        await sendControl($, worker, 'nudge', 'answer', 'You stopped without a report. If you finished, send a done report; if you are stuck or need a decision, say so with a report.')
      }
    }
  } finally {
    isTicking = false
  }
}

const ensureTicker = ($: EngineInterface) => {
  ticker ??= $.clock.every(TICK_MS, () => void tick($))
}

const animate = async ($: EngineInterface) => {
  try {
    const [orchestrator, workers, lead, now] = await Promise.all([read($, orchestratorAtom), read($, workersAtom), read($, leadAtom), $.clock.now()])
    if (!orchestrator || !needsAnimation(lead, workers, now) || !(await isBoardOpen($))) {
      animator?.cancel()
      animator = undefined
      return
    }
    await update($, frameAtom, frame => (frame + 1) % 1000)
  } catch {
    animator?.cancel()
    animator = undefined
  }
}

const ensureAnimator = ($: EngineInterface) => {
  animator ??= $.clock.every(FRAME_MS, () => void animate($))
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

const restore = async ($: EngineInterface) => {
  try {
    const saved = (await $.store.get(`${STORE_PREFIX}${await $.session.id()}`)) as { orchestrator?: OrchOrchestrator; workers?: OrchWorker[] } | undefined
    if (!saved?.orchestrator) return
    await update($, orchestratorAtom, () => saved.orchestrator ?? null)
    await update($, workersAtom, () => (Array.isArray(saved.workers) ? saved.workers : []))
    await registerOrchestratorTools($)
    await openBoard($)
  } catch {
    // nothing saved
  }
}

const statusText = async ($: EngineInterface): Promise<string> => {
  const [orchestrator, workers, now] = await Promise.all([read($, orchestratorAtom), read($, workersAtom), $.clock.now()])
  if (!orchestrator) return 'Orchestrator mode is off. `/orchestrate <goal>` turns it on.'
  return [`Orchestrator mode is on${orchestrator.goal ? ` · goal: ${orchestrator.goal}` : ''}.`, ...rosterLines(workers, now)].join('\n')
}

const turnOn = async ($: EngineInterface, goal: string) => {
  const [current, now, pane] = await Promise.all([read($, orchestratorAtom), $.clock.now(), herdrPane($)])
  await update($, orchestratorAtom, () => ({ goal: goal || current?.goal, startedAt: current?.startedAt ?? now }))
  await registerOrchestratorTools($)
  await persist($)
  await setLead($, goal ? 'planning' : 'waiting for a goal')
  await openBoard($)
  if (goal) $.clock.after(0, () => void $.prompt.submit({ text: goal, asUser: true }))
  const lines = [
    `Orchestrator mode is on: ${shortModel(config.orchestratorModel)} at ${config.orchestratorEffort} effort or more, no code edits, up to ${config.maxWorkers} worker panes before a dialog.`,
    pane ? '' : 'This session is not in a herdr pane, so it cannot open workers.',
    goal ? '' : 'Give it a goal in your next prompt.',
  ]
  return {
    text: lines.filter(Boolean).join('\n'),
    context: [`Cal switched this session into orchestrator mode${goal ? ` for: ${goal}` : ''}. Follow the "Orchestrator mode" section of your instructions from now on.`],
  }
}

const turnOff = async ($: EngineInterface) => {
  const [orchestrator, workers] = await Promise.all([read($, orchestratorAtom), read($, workersAtom)])
  if (!orchestrator) return { text: 'Orchestrator mode is already off.' }
  const open = openWorkers(workers).filter(worker => worker.paneId)
  let isClosing = false
  if (open.length > 0) {
    try {
      isClosing = (await $.ui.ask(`Close the ${open.length} open worker pane(s): ${open.map(({ name }) => name).join(', ')}?`, ['Close them', 'Leave them running'])) === 'Close them'
    } catch {
      isClosing = false
    }
  }
  if (isClosing) {
    for (const worker of open) if (worker.paneId) await herdr($, closeArgv(worker.paneId))
    if (orchestrator.tabId) await herdr($, tabCloseArgv(orchestrator.tabId))
  }
  await closeBoard($)
  await update($, orchestratorAtom, () => null)
  await update($, workersAtom, () => [])
  await update($, feedAtom, () => [])
  await update($, scrollAtom, () => 0)
  await update($, expandedAtom, () => null)
  await update($, leadAtom, () => null)
  await persist($)
  return {
    text: `Orchestrator mode is off.${open.length > 0 ? isClosing ? ` Closed ${open.length} worker pane(s).` : ` ${open.length} worker(s) left running; their reports now arrive as plain messages.` : ''}`,
    context: ['Cal turned orchestrator mode off: you may edit code again, and the orchestrator tools no longer work.'],
  }
}

type ToolAnswer = { deny: string } | { result: string }

const OFF = 'Orchestrator mode is off.'
const toolFailure = (error: unknown): string => `The orchestrator tool failed: ${error instanceof Error ? error.message : String(error)}`

type Pill = { key: string; text: string; bg: string }

const STATUS_COLOR: Record<OrchWorkerStatus, string> = {
  starting: COLOR.surface1,
  working: COLOR.blue,
  idle: COLOR.green,
  done: COLOR.green,
  blocked: COLOR.red,
  unknown: COLOR.surface1,
  closed: COLOR.surface1,
  gone: COLOR.surface1,
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

const modelLetter = (model: string): string => shortModel(model).charAt(0)

export const pillsFor = (orchestrator: OrchOrchestrator | null, workers: readonly OrchWorker[], self: OrchWorkerSelf | null): Pill[] => {
  if (orchestrator) {
    const open = openWorkers(workers)
    return [
      { key: 'role', text: `⌘ orchestrator · ${open.length}/${config.maxWorkers}`, bg: COLOR.mauve },
      ...open.map(worker => ({
        key: `w:${worker.name}`,
        text: `${statusGlyph(worker.status)} ${worker.name} ${modelLetter(worker.model)}·${effortLetter(worker.effort)}`,
        bg: STATUS_COLOR[worker.status],
      })),
    ]
  }
  if (self) {
    const model = self.model ?? config.workerModel
    return [
      { key: 'role', text: `⚒ ${self.name} → ${self.parentName ?? 'orchestrator'}`, bg: COLOR.peach },
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
    const self = await readWorkerEnv($)
    if (self) {
      await update($, workerAtom, () => self)
      await $.tool.register(REPORT_TOOL as never)
      $.clock.after(1500, () => void sayHello($, self))
      return started
    }
    await $.command.register({
      name: 'orchestrate',
      description: 'Turn this session into an orchestrator: Opus plans, delegates to Sonnet workers in herdr panes, and reviews; it never edits code',
      argumentHint: '[goal] | status | board | board bg | off',
    })
    await restore($)
    try {
      if ((await $.store.get('boardBg')) === false) await update($, boardBgAtom, () => false)
    } catch {
      // default: no background
    }
    void pruneStore($)
    ensureTicker($)
    return started
  })

  on('command.run', { command: 'orchestrate' }, async ($, e) => {
    if (await read($, workerAtom)) return { text: 'This session is an orchestrator worker; it cannot orchestrate.' }
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
  on('tool.call', { tool: 'mcp__orchestrator__close_worker' as never }, async ($, e): Promise<ToolAnswer> =>
    (await read($, orchestratorAtom)) ? closeWorker($, e as Record<string, unknown>) : { deny: OFF },
  ).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__roster' as never }, async ($, e): Promise<ToolAnswer> =>
    (await read($, orchestratorAtom)) ? statusText($).then(text => ({ result: text })) : { deny: OFF },
  ).catch(($, e, next) => ({ deny: toolFailure(next.error) }))
  on('tool.call', { tool: 'mcp__orchestrator__report' as never }, async ($, e): Promise<ToolAnswer> => sendReport($, e as Record<string, unknown>)).catch(($, e, next) => ({
    deny: toolFailure(next.error),
  }))

  on('tool.call', async ($, e, next) => {
    const [orchestrator, self] = await Promise.all([read($, orchestratorAtom), read($, workerAtom)])
    if (orchestrator) {
      if (e.tool === 'Bash' || EDIT_TOOLS.has(e.tool)) {
        const roots = await writableRoots($)
        if (e.tool === 'Bash') {
          const reason = bashReason(e.command, roots)
          if (reason) return { deny: orchestratorDeny(reason) }
        } else {
          const path = editPathOf(e as Record<string, unknown>)
          if (!path || !isInside(path, roots)) return { deny: orchestratorDeny(`${e.tool} on ${path ?? 'a file'} changes code`) }
        }
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
      if (e.tool === 'Bash') {
        const reason = WORKER_FORBIDDEN(e.command)
        if (reason) return { deny: `Worker mode: ${reason}.` }
      }
      if (e.agentId !== undefined) return next(e)
      if (e.tool === 'AskUserQuestion') {
        isWorkerAsking = true
        await sendStatus($, self, 'asking', `asking in its pane: ${questionOf(e as Record<string, unknown>)}`)
        try {
          return await next(e)
        } finally {
          isWorkerAsking = false
          await sendStatus($, self, 'working', 'got an answer')
        }
      }
      await noteActivity($, self, describeLeadTool(e.tool, e as Record<string, unknown>))
      try {
        return await next(e)
      } finally {
        if (isWorkerAsking) {
          isWorkerAsking = false
          await sendStatus($, self, 'working', 'permission answered')
        }
      }
    }
    return next(e)
  }).catch(async ($, e, next) => {
    if (next.called) return undefined
    const orchestrator = await read($, orchestratorAtom)
    return orchestrator ? { deny: orchestratorDeny('the guard could not check this call, so it is refused') } : next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const [orchestrator, self] = await Promise.all([read($, orchestratorAtom), read($, workerAtom)])
    if (orchestrator) {
      return { sections: [...composed.sections, { id: 'orchestrator:role', text: orchestratorSection(orchestrator, config), scope: 'session' as const }] }
    }
    if (self) return { sections: [...composed.sections, { id: 'orchestrator:worker', text: workerSection(self), scope: 'session' as const }] }
    return composed
  })

  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const handled = await handleInbound($, e.text)
    if (!handled) return next(e)
    return 'consumed' in handled ? handled : next({ ...e, text: handled.text })
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('prompt.submit', async ($, e, next) => {
    if (!e.text.includes('⟦orch v1')) {
      const orchestrator = await read($, orchestratorAtom)
      const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
      if (orchestrator && !orchestrator.goal && isPerson && !e.text.trimStart().startsWith('/') && e.text.trim()) {
        await update($, orchestratorAtom, current => (current ? { ...current, goal: oneLine(e.text, 100) } : current))
        await persist($)
        await setLead($, 'planning')
      }
      return next(e)
    }
    const handled = await handleInbound($, e.text)
    if (!handled) return next(e)
    return 'consumed' in handled ? { drop: handled.consumed } : next({ ...e, text: handled.text })
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('turn.start', async ($, e, next) => {
    if (await read($, orchestratorAtom)) await setLead($, 'thinking')
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
    const [orchestrator, workers, self] = await Promise.all([read($, orchestratorAtom), read($, workersAtom), read($, workerAtom)])
    const pills = pillsFor(orchestrator, workers, self)
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
    const self = await read($, workerAtom)
    if (self) {
      const { percent, tokens, window } = e.context
      const value = percent ?? (tokens !== undefined && window > 0 ? (tokens / window) * 100 : undefined)
      if (value !== undefined) {
        workerCtx = Math.round(value)
        if (workerCtxSent === undefined || Math.abs(workerCtx - workerCtxSent) >= 3) {
          const at = await $.clock.now()
          if (at - workerStatusAt >= STATUS_EVERY_MS && !isWorkerAsking) await sendStatus($, self, 'working', workerActivity)
        }
      }
    }
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    const self = await read($, workerAtom)
    if (self && /permission/i.test(`${e.notification_type} ${e.message}`) && !isWorkerAsking) {
      isWorkerAsking = true
      await sendStatus($, self, 'asking', `needs permission in its pane: ${oneLine(e.message, 140)}`)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && (await read($, orchestratorAtom))) {
      const hasWorkers = openWorkers(await read($, workersAtom)).length > 0
      await setLead($, hasWorkers ? 'waiting for workers' : 'idle')
    }
    return next(e)
  })

  on('ui.scroll', { component: 'Pane', requestId: BOARD_ID }, async ($, e) => {
    const [feed, workers] = await Promise.all([read($, feedAtom), read($, workersAtom)])
    const most = Math.max(0, feed.length - timelineRoom(e.bodyRows, openWorkers(workers).length))
    await update($, scrollAtom, back => Math.max(0, Math.min(most, Math.min(back, most) - e.by)))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: BOARD_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const [orchestrator, workers, feed, lead, frame, isPainted, scrollBack, expanded, now] = await Promise.all([
      read($, orchestratorAtom),
      read($, workersAtom),
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
      workers,
      feed,
      lead,
      leadModel: config.orchestratorModel,
      leadEffort: config.orchestratorEffort,
      maxWorkers: config.maxWorkers,
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
