import { join } from 'node:path'
import * as commands from './commands.ts'
import * as paths from './paths.ts'
import * as protocol from './protocol.ts'
import * as roster from './roster.ts'
import * as store from './store.ts'
import type { AgentKind, CommandResult, Deps, Effort, Identity, McpTool, ReportInput, SendRequest } from './types.ts'

export const PLANNER_TOOL_NAMES = ['spawn', 'send', 'verdict', 'prompt', 'promote', 'close', 'roster', 'capture', 'down'] as const
export const WORKER_TOOL_NAMES = ['report'] as const

export type ToolPorts = {
  commands: Pick<typeof commands, 'spawn' | 'send' | 'prompt' | 'promote' | 'roster' | 'capture' | 'close' | 'down' | 'raiseBudget'>
  seatDir: typeof paths.seatDir
  appendJsonl: typeof store.appendJsonl
  loadRun: typeof roster.loadRun
  loadRoster: typeof roster.loadRoster
  openSeats: typeof roster.openSeats
  validateReport: typeof protocol.validateReport
  stampReport: typeof protocol.stampReport
  elicit?: (message: string) => Promise<boolean | undefined>
}

export const defaultToolPorts: ToolPorts = {
  commands,
  seatDir: paths.seatDir,
  appendJsonl: store.appendJsonl,
  loadRun: roster.loadRun,
  loadRoster: roster.loadRoster,
  openSeats: roster.openSeats,
  validateReport: protocol.validateReport,
  stampReport: protocol.stampReport,
}

const KINDS: readonly AgentKind[] = ['claude', 'codex']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const SEND_KINDS: readonly SendRequest['kind'][] = ['message', 'answer', 'nudge']
const EXPECTS = ['review', 'answer', 'none'] as const
const VERDICTS = ['approve', 'changes'] as const

class ArgError extends Error {}

type Args = Record<string, unknown>

const text = (args: Args, key: string, required = true): string | undefined => {
  const value = args[key]
  if (value === undefined || value === null || value === '') {
    if (required) throw new ArgError(`${key} is required`)
    return undefined
  }
  if (typeof value !== 'string') throw new ArgError(`${key} must be a string`)
  return value
}

const seatName = (args: Args, key = 'seat'): string => {
  const value = text(args, key) as string
  if (!paths.SEAT_RE.test(value)) throw new ArgError(`${key} must match ${paths.SEAT_RE} (lowercase letters, digits, - and _, starting with a letter)`)
  return value
}

const oneOf = <T extends string>(args: Args, key: string, allowed: readonly T[], required = true): T | undefined => {
  const value = text(args, key, required)
  if (value === undefined) return undefined
  if (!allowed.includes(value as T)) throw new ArgError(`${key} must be one of ${allowed.join(' | ')}`)
  return value as T
}

const names = (args: Args, key: string): string[] | undefined => {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string')) throw new ArgError(`${key} must be an array of strings`)
  return (value as string[]).map(name => name.trim()).filter(Boolean)
}

const flag = (args: Args, key: string): boolean => {
  const value = args[key]
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new ArgError(`${key} must be a boolean`)
  return value
}

const count = (args: Args, key: string, fallback: number): number => {
  const value = args[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ArgError(`${key} must be a positive integer`)
  return value
}

const asResult = (result: CommandResult) => (result.ok ? { text: result.text } : { text: `${result.text} [${result.code}]`, isError: true })

const defineTool = (name: string, description: string, properties: Record<string, unknown>, required: string[], run: (args: Args) => Promise<{ text: string; isError?: boolean }>): McpTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required },
  call: async (args) => {
    try {
      return await run(args)
    } catch (error) {
      return { text: error instanceof ArgError ? error.message : `${name} failed: ${(error as Error).message}`, isError: true }
    }
  },
})

const seatProp = { type: 'string', description: 'Seat name, e.g. w-api. Run roster to see the seats of this run.' }
const expectsProp = { type: 'string', enum: EXPECTS, description: 'What you expect back from the worker: review (a done report with the diff ready), answer (a reply) or none.' }

export const plannerTools = (deps: Deps, identity: Identity, ports: ToolPorts = defaultToolPorts): McpTool[] => {
  const cmd = ports.commands
  const ref = async () => {
    const run = await ports.loadRun(deps.home, identity.run)
    if (!run) throw new ArgError(`run ${identity.run} not found under ${deps.home}`)
    return { run: run.id, repo: run.repo }
  }

  const askForBudget = async (seat: string): Promise<string | undefined> => {
    if (!ports.elicit) return undefined
    const run = await ports.loadRun(deps.home, identity.run)
    if (!run) return undefined
    const open = ports.openSeats(await ports.loadRoster(deps.home, identity.run)).length
    if (open < run.budget) return undefined
    const approved = await ports.elicit(`Spawning ${seat} needs pane ${open + 1}, over the budget of ${run.budget}. Allow it?`)
    if (approved === undefined) return undefined
    if (!approved) return `The human declined pane ${open + 1}. ${seat} was not spawned. Do not retry; finish or close a seat first.`
    const raised = await cmd.raiseBudget(deps, { run: run.id, repo: run.repo }, open + 1)
    return raised.ok ? undefined : `Could not raise the budget: ${raised.text}`
  }

  return [
    defineTool(
      'spawn',
      'Start a worker: a Claude worker gets Claude\'s own worktree (branch worktree-SEAT) and a Codex worker a Drove worktree (branch drove/SEAT); opens a pane in the run tab and launches the agent with your brief. Give each worker one Cairn ref and a self-contained brief (files it owns, acceptance, what to verify). Returns at once with the seat running. Do NOT wait, poll or sleep afterwards: the worker\'s report is delivered to you as a message (or at the end of your next tool result). Spawn the next independent worker, or end your turn.',
      {
        seat: { type: 'string', description: 'New seat name: lowercase letters, digits, - and _, starting with a letter, up to 32 characters (e.g. w-api).' },
        kind: { type: 'string', enum: KINDS, description: 'Which agent runs the seat: claude or codex.' },
        cairn: { type: 'string', description: 'The Cairn task ref the worker claims (one ref per worker).' },
        brief: { type: 'string', description: 'The full brief. The worker sees nothing else.' },
        model: { type: 'string', description: 'Optional model override.' },
        effort: { type: 'string', enum: EFFORTS, description: 'Optional reasoning effort override.' },
        base: { type: 'string', description: 'Optional base branch for a Codex worktree (default: origin/main, or main without a remote). Ignored for Claude, which branches from the main checkout\'s current HEAD.' },
        mcp: { type: 'array', items: { type: 'string' }, description: 'Optional: the user MCP servers this worker needs, by name (e.g. ["mongodb"]). Given, the worker loads Drove\'s server, these and the configured workerMcp only; [] for Drove\'s alone. Left out, it loads what workerMcp allows, or everything when that is unset.' },
        owns: { type: 'array', items: { type: 'string' }, description: 'Optional: globs, relative to the worker\'s worktree, of the files it may change (e.g. ["src/guard.ts", "test/**"]). Given, Drove\'s guard refuses the worker\'s edits to any other file and tells it to ask you. Left out, the worker may edit anywhere.' },
        maxTurns: { type: 'integer', minimum: 1, description: 'Optional: how many turns (stops) the worker may take. At the limit you get a budget attention and the worker is told once to report progress or promote and stop; it is not killed. Left out, the configured maxTurns applies, or none.' },
        maxTokens: { type: 'integer', minimum: 1, description: 'Optional: how many tokens (input, cached input and output, read from the agent\'s own transcript) the worker may use. Same effect at the limit as maxTurns.' },
      },
      ['seat', 'kind', 'brief'],
      async (args) => {
        const seat = seatName(args)
        const blocked = await askForBudget(seat)
        if (blocked) return { text: blocked, isError: true }
        return asResult(
          await cmd.spawn(deps, identity, {
            seat,
            kind: oneOf(args, 'kind', KINDS) as AgentKind,
            brief: text(args, 'brief') as string,
            cairn: text(args, 'cairn', false),
            model: text(args, 'model', false),
            effort: oneOf(args, 'effort', EFFORTS, false),
            base: text(args, 'base', false),
            ...(args.mcp != null ? { mcp: names(args, 'mcp') } : {}),
            ...(args.owns != null ? { owns: names(args, 'owns') } : {}),
            ...(args.maxTurns != null ? { maxTurns: count(args, 'maxTurns', 1) } : {}),
            ...(args.maxTokens != null ? { maxTokens: count(args, 'maxTokens', 1) } : {}),
          }),
        )
      },
    ),
    defineTool(
      'send',
      'Send a message to a worker (kind message), answer one of its question or blocked reports (kind answer), or nudge it. Use answer whenever a worker asked a question: say the decision plainly, with the reason if it matters. Use verdict, not this tool, to approve or reject finished work. After sending, do not wait: the worker\'s next report arrives on its own. Delivery is guarded: if the worker\'s pane is waiting on a dialog the message is queued and retried, and the result says so.',
      {
        seat: seatProp,
        kind: { type: 'string', enum: SEND_KINDS, description: 'answer for a reply to a question, message for anything else, nudge to prod an idle worker.' },
        body: { type: 'string', description: 'The text the worker receives.' },
        expects: expectsProp,
      },
      ['seat', 'kind', 'body'],
      async (args) =>
        asResult(
          await cmd.send(deps, identity, {
            seat: seatName(args),
            kind: oneOf(args, 'kind', SEND_KINDS) as SendRequest['kind'],
            body: text(args, 'body') as string,
            expects: oneOf(args, 'expects', EXPECTS, false),
          }),
        ),
    ),
    defineTool(
      'verdict',
      'Give a verdict on a worker\'s done report, after you reviewed its diff yourself (git diff main... in its worktree) and checked its test output. approve tells the worker to commit only its own paths and confirm with a done report whose expects is none; then merge its branch and close the seat. changes sends the worker back to fix the notes you give and report done again, so notes are required for changes. Never approve unseen work.',
      {
        seat: seatProp,
        verdict: { type: 'string', enum: VERDICTS, description: 'approve | changes' },
        notes: { type: 'string', description: 'Review notes. Required for changes; optional extra instructions for approve.' },
      },
      ['seat', 'verdict'],
      async (args) => {
        const verdict = oneOf(args, 'verdict', VERDICTS) as 'approve' | 'changes'
        const notes = text(args, 'notes', verdict === 'changes')
        return asResult(await cmd.send(deps, identity, { seat: seatName(args), kind: 'verdict', verdict, body: notes ?? '', expects: verdict === 'approve' ? 'none' : 'review' }))
      },
    ),
    defineTool(
      'prompt',
      'Type raw text into a worker\'s pane with no envelope. Only for recovery: re-briefing a restarted worker, or when send cannot reach it. Prefer send or verdict. It refuses a pane that is blocked on a dialog; in that case tell the human which seat needs them.',
      { seat: seatProp, text: { type: 'string', description: 'Exact text to type into the pane.' } },
      ['seat', 'text'],
      async (args) => asResult(await cmd.prompt(deps, identity, seatName(args), text(args, 'text') as string)),
    ),
    defineTool(
      'promote',
      'Change a worker\'s model or effort (promote after a promote report or when the task is harder than expected, demote to save cost). The change may restart the agent, so it is queued until the worker is idle and owes no report; the result says whether it ran or is queued. Do not wait for it.',
      {
        seat: seatProp,
        model: { type: 'string', description: 'Target model.' },
        effort: { type: 'string', enum: EFFORTS, description: 'Target effort.' },
        reason: { type: 'string', description: 'Why, shown to the worker.' },
      },
      ['seat', 'model', 'effort'],
      async (args) =>
        asResult(await cmd.promote(deps, identity, { seat: seatName(args), model: text(args, 'model') as string, effort: oneOf(args, 'effort', EFFORTS) as Effort, reason: text(args, 'reason', false) })),
    ),
    defineTool(
      'close',
      'Close a seat once its branch is merged (or abandoned): quits the agent, closes the pane and marks the seat closed. Set removeWorktree only after merging, it refuses while the branch is unmerged. Then close its Cairn task yourself.',
      { seat: seatProp, removeWorktree: { type: 'boolean', description: 'Also remove the worktree (only allowed when the branch is merged).' } },
      ['seat'],
      async (args) => asResult(await cmd.close(deps, identity, seatName(args), flag(args, 'removeWorktree'))),
    ),
    defineTool(
      'roster',
      'List every seat of this run: state, kind, model, effort, Cairn ref, age, last report and what you still owe it (review, answer or none), plus items that need the human. Call it after waking, and before deciding who to wait on. A seat that owes you nothing and shows working needs no action.',
      { json: { type: 'boolean', description: 'Return JSON instead of lines.' } },
      [],
      async (args) => asResult(await cmd.roster(deps, await ref(), flag(args, 'json'))),
    ),
    defineTool(
      'capture',
      'Read a worker\'s recent terminal output (read only). Use it to see why a seat is stuck or blocked before telling the human. It does not replace the worker\'s own report.',
      { seat: seatProp, lines: { type: 'number', description: 'How many recent lines (default 60).' } },
      ['seat'],
      async (args) => asResult(await cmd.capture(deps, await ref(), seatName(args), count(args, 'lines', 60))),
    ),
    defineTool(
      'down',
      'Shut the run down: saves every session id, quits the agents, closes the panes and marks the run down. Only when the human asked to stop for now; the human resumes with drove up. Finish or close merged seats first.',
      {},
      [],
      async () => asResult(await cmd.down(deps, await ref())),
    ),
  ]
}

const REPORT_GUIDE = `Report to the planner. This is the only way the planner hears from you; plain text you write in this session is not delivered.
Kinds:
- done: you finished and verified (include branch, changed files, test output, anything you are unsure of in details). Default expects review. After the planner approves, commit, then send done again with expects none and the commit sha.
- question: you need a decision before you can continue. Default expects answer. Set for to human when only the human can decide (scope, money, production).
- blocked: something outside your control stops you; say what you tried. Default expects answer.
- promote: the task needs a stronger model or more effort; say why. Default expects answer.
- progress: a short status update for the roster. Never wakes the planner and expects nothing back; use it sparingly on long tasks.
After you send done, question, blocked or promote: stop and wait. The planner's reply arrives in this session as a message headed by a drove envelope. Do not poll, do not repeat the report, and do not continue past the question.`

const afterReport = (kind: string, expects: string): string => {
  if (kind === 'progress') return 'Progress recorded. It does not wake the planner and no reply will come. Keep working.'
  if (kind === 'done' && expects === 'none') return 'Confirmation recorded. You are finished: stop now and do not take further actions.'
  if (kind === 'done') return 'Done report recorded. Stop and wait for the planner\'s verdict, it will arrive here as a message. Do not commit, merge or push until it approves.'
  return 'Report recorded. Stop and wait for the planner\'s answer, it will arrive here as a message. Do not guess and do not carry on with the blocked part.'
}

export const workerTools = (deps: Deps, identity: Identity, ports: ToolPorts = defaultToolPorts): McpTool[] => [
  defineTool(
    'report',
    REPORT_GUIDE,
    {
      kind: { type: 'string', enum: protocol.REPORT_KINDS, description: 'done | question | blocked | promote | progress' },
      summary: { type: 'string', description: 'One line: what happened or what you need.' },
      details: { type: 'string', description: 'Branch, changed files, test output, options and your recommendation. Keep it factual.' },
      expects: { type: 'string', enum: EXPECTS, description: 'What you expect back. Omit for the default of the kind.' },
      for: { type: 'string', enum: ['human'], description: 'Set to human when only the human can decide.' },
    },
    ['kind', 'summary'],
    async (args) => {
      if (!identity.token) return { text: 'DROVE_TOKEN is not set in this session, so a report cannot be stamped. Tell the human.', isError: true }
      const checked = ports.validateReport(args)
      if (!checked.ok) return { text: checked.error, isError: true }
      const at = deps.clock.now()
      const report = ports.stampReport(checked.value as ReportInput, { id: protocol.newReportId(identity.seat, at.getTime()), run: identity.run, seat: identity.seat, token: identity.token, at: at.toISOString() })
      await ports.appendJsonl(join(ports.seatDir(identity.home, identity.run, identity.seat), 'outbox.jsonl'), report)
      return { text: `report ${report.id} recorded (${report.kind}, expects ${report.expects}). ${afterReport(report.kind, report.expects)}` }
    },
  ),
]
