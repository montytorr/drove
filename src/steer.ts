import { join } from 'node:path'
import { checksOf } from './checks.ts'
import type { deliverControl } from './deliver.ts'
import { EDIT_TOOLS, SHELL_TOOLS } from './guard.ts'
import { advanceLedger, type Ledger, type LedgerEntry } from './ledger.ts'
import type { runDir } from './paths.ts'
import { claudeTranscriptPath } from './report.ts'
import { findSeat, type loadRoster } from './roster.ts'
import { readJsonlTail, type appendJsonl, type readJson, type readJsonlFrom } from './store.ts'
import type { Control, Deps, DroveConfig, DroveEvent, Report, RunMeta, Seat } from './types.ts'
import type { findRollout } from './usage.ts'

// DROVE-127: steering after Strands' steering handlers. The seat's tool ledger (src/ledger.ts) is checked by deterministic
// rules, just in time, instead of every rule living in the worker's prompt:
//   R1  the same shell command failed `repeatFailures` times in a row: the worker is sent one message.
//   R2  a done report arrives and no check has passed since the worker's last edit: the planner's rendering of the report
//       gets a line, and the worker is told nothing. The line is evidence for that report's review, so it always shows.
// Each nudge is a `steer.nudged` event; R1 nudges a seat at most once in `cooldownMinutes`.

export type SteerRule = 'R1' | 'R2'

export const STEER_EVERY_MS = 15_000
export const DEFAULTS = { enabled: true, repeatFailures: 3, cooldownMinutes: 10 } as const
export type SteerConfig = { enabled: boolean; repeatFailures: number; cooldownMinutes: number; checkCommands: string[] }

const isWhole = (value: unknown, least: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= least

// `steering` from config.json: on unless it says `enabled: false`; a part that is not a whole number in range keeps its default.
export const steerConfig = (value: unknown): SteerConfig => {
  const given = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof SteerConfig, unknown>>
  return {
    enabled: given.enabled !== false,
    repeatFailures: isWhole(given.repeatFailures, 2) ? given.repeatFailures : DEFAULTS.repeatFailures,
    cooldownMinutes: isWhole(given.cooldownMinutes, 1) ? given.cooldownMinutes : DEFAULTS.cooldownMinutes,
    checkCommands: Array.isArray(given.checkCommands) ? given.checkCommands.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(normalise) : [],
  }
}

// ---------- commands ----------

// `env -u NAME`, `env NAME=value` and a bare `NAME=value` in front of a command change nothing about what it is.
const ENV_PREFIX = /^(?:env\s+(?:(?:-u\s+\S+|--unset=\S+|-i|--ignore-environment|-0|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*))\s+)*|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)/

export const normalise = (command: string): string => {
  let text = command.trim().replace(/\s+/g, ' ')
  for (;;) {
    const match = ENV_PREFIX.exec(text)
    const rest = match ? text.slice(match[0].length) : ''
    if (!match || match[0] === '' || rest === '' || /^[|&;<>]/.test(rest)) return text
    text = rest
  }
}

// What a worker runs to check its work, besides the repo's own plan: the usual test, typecheck and lint commands.
const USUAL_CHECKS: readonly RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)(?: run)? (?:test|typecheck|type-check|lint|check)(?::\S+)?(?: |$)/,
  /^(?:npx |pnpm (?:exec |dlx )?|yarn |bunx )?(?:tsc|eslint|vitest|jest|mocha|biome|oxlint|ruff|mypy|pytest|flake8)(?: |$)/,
  /^node (?:\S+ )*--test(?: |$)/,
  /^(?:python3? -m )?(?:pytest|unittest|mypy|ruff|tox|nox)(?: |$)/,
  /^cargo (?:test|check|clippy|nextest)(?: |$)/,
  /^go (?:test|vet)(?: |$)/,
  /^(?:make|just) (?:test|tests|check|lint|typecheck|verify)(?: |$)/,
  /^claude plugin test(?: |$)/,
  /^(?:bundle exec )?(?:rspec|rake test)(?: |$)/,
  /^(?:mvn|gradle|\.\/gradlew|dotnet) test(?: |$)/,
]

// A shell line is a check when one of its parts (split at `&&`, `||`, `;`, `|` and newlines) is one of the repo's check
// commands or a usual one, with arguments after it allowed.
export const isCheckCommand = (command: string, plan: readonly string[]): boolean =>
  command
    .split(/&&|\|\||;|\||\n/)
    .map(normalise)
    .some(part => part !== '' && (plan.some(known => known !== '' && (part === known || part.startsWith(`${known} `))) || USUAL_CHECKS.some(pattern => pattern.test(part))))

// ---------- rules ----------

// An edit that changes the seat's work: one that succeeded, to a file that is not scratch space or memory.
const SCRATCH = /^\/tmp\/|\/\.claude\/projects\/|\/\.drove\/|\/\.codex\//

const isEdit = (entry: LedgerEntry): boolean => entry.ok && EDIT_TOOLS.has(entry.tool) && (entry.paths ?? []).some(path => !SCRATCH.test(path))

// The trailing run of one shell command failing, newest call last: `number` is the ledger number of its last failure.
// Reads and other tools between two failures do not end it; another shell command, a success or an edit does (an edit
// changes what the next run is a result of).
export type Streak = { command: string; count: number; lastAt: string; lastNumber: number }

export const failureStreak = (ledger: Ledger): Streak | undefined => {
  const entries = ledger.entries
  let command: string | undefined
  let count = 0
  let lastAt = ''
  let lastNumber = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as LedgerEntry
    if (isEdit(entry)) break
    if (!SHELL_TOOLS.has(entry.tool) || entry.command === undefined) continue
    const normal = normalise(entry.command)
    if (entry.ok || (command !== undefined && normal !== command)) break
    if (command === undefined) {
      command = normal
      lastAt = entry.at
      lastNumber = ledger.count - (entries.length - 1 - index)
    }
    count += 1
  }
  return command === undefined ? undefined : { command, count, lastAt, lastNumber }
}

export type Unchecked = { lastEdit: LedgerEntry; lastCheck?: LedgerEntry }

const passedCheck = (entry: LedgerEntry, plan: readonly string[]): boolean => entry.ok && entry.command !== undefined && SHELL_TOOLS.has(entry.tool) && isCheckCommand(entry.command, plan)

// Set when the seat has edited and no check has passed since. An edit the ledger's window forgot is older than all of it.
export const unchecked = (ledger: Ledger, plan: readonly string[]): Unchecked | undefined => {
  const seen = ledger.entries.findLast(isEdit)
  const edit = seen ?? (ledger.lastEdit && isEdit(ledger.lastEdit) ? ledger.lastEdit : undefined)
  if (!edit) return undefined
  const after = seen ? ledger.entries.slice(ledger.entries.lastIndexOf(seen) + 1) : ledger.entries
  if (after.some(entry => passedCheck(entry, plan))) return undefined
  const lastCheck = ledger.entries.findLast(entry => passedCheck(entry, plan))
  return { lastEdit: edit, ...(lastCheck ? { lastCheck } : {}) }
}

const clock = (at: string): string => (at ? at.replace(/\.\d+Z$/, 'Z') : 'unknown time')

export const repeatText = (command: string, count: number): string =>
  `Drove: \`${command.length > 160 ? `${command.slice(0, 159)}…` : command}\` has failed ${count} times with the same result. Change approach, or send a blocked or question report.`

export const uncheckedText = (state: Unchecked): string =>
  `Drove: no check ran after the last edit (last edit ${clock(state.lastEdit.at)}, last check ${state.lastCheck ? clock(state.lastCheck.at) : 'never'})`

// ---------- the watcher's side ----------

// What the rules need of the world: the watcher passes its own ports, and a test passes counting ones.
export type SteerPorts = {
  runDir: typeof runDir
  readJson: typeof readJson
  appendJsonl: typeof appendJsonl
  readJsonlFrom: typeof readJsonlFrom
  loadRoster: typeof loadRoster
  deliverControl: typeof deliverControl
  findRollout: typeof findRollout
  // One stat of a transcript: `<size>:<mtime>`, undefined when there is none. A transcript that has the same stamp as at
  // the last tick is not read.
  transcriptStamp: (path: string) => Promise<string | undefined>
  // The repo's check commands (src/checks.ts: .drove.json, else package.json scripts or Makefile targets).
  checkPlan: (repo: string) => Promise<string[]>
}

export const defaultCheckPlan = async (repo: string): Promise<string[]> => (await checksOf(repo)).commands

type SeatSteer = {
  path?: string
  // `${size}:${mtime}` of the transcript at its last read.
  stamp?: string
  ledger?: Ledger
  lastRunAt?: number
  // The last R1 message: when it went and the ledger number of the failure it was about.
  nudged?: { at: number; number: number }
}

export type TickOptions = {
  // The transcript path the seat's hooks reported, by seat name.
  transcriptOf?: (seat: string) => string | undefined
  claudeDir: string
}

export type Steering = {
  // Evaluates R1 for the seats that are due. Throws the first error after it has tried every seat.
  tick: (run: RunMeta, seats: readonly Seat[], raw: unknown, options: TickOptions) => Promise<void>
  // R2: the report as the planner should see it, with a `steering` line when no check ran after the seat's last edit.
  annotate: (run: RunMeta, report: Report, options: TickOptions) => Promise<Report>
}

export const createSteering = (deps: Deps, ports: SteerPorts): Steering => {
  const seats = new Map<string, SeatSteer>()
  const plans = new Map<string, string[]>()
  const clockMs = () => deps.clock.now().getTime()

  const stateOf = (run: string, seat: string): SeatSteer => {
    const key = `${run}:${seat}`
    const found = seats.get(key)
    if (found) return found
    const made: SeatSteer = {}
    seats.set(key, made)
    return made
  }

  const planOf = async (repo: string, extra: readonly string[]): Promise<string[]> => {
    let plan = plans.get(repo)
    if (!plan) {
      plan = (await ports.checkPlan(repo).catch(() => [])).map(normalise)
      plans.set(repo, plan)
    }
    return [...plan, ...extra]
  }

  const transcriptFor = async (seat: Seat, options: TickOptions, state: SeatSteer): Promise<string | undefined> => {
    const hinted = options.transcriptOf?.(seat.name)
    if (hinted) return hinted
    if (state.path) return state.path
    if (!seat.sessionId) return undefined
    if (seat.kind === 'claude') return claudeTranscriptPath(options.claudeDir, seat.worktree, seat.sessionId)
    return seat.codexHome ? ports.findRollout(seat.codexHome, seat.sessionId) : undefined
  }

  // Brings the seat's ledger up to date with its transcript: one stat, and a read only when the stamp moved.
  const refresh = async (seat: Seat, options: TickOptions, state: SeatSteer): Promise<Ledger | undefined> => {
    const path = await transcriptFor(seat, options, state)
    if (!path) return undefined
    // A new session's transcript (a resume, a promote) is a new ledger.
    if (state.path !== path) state.stamp = undefined
    state.path = path
    const stamp = await ports.transcriptStamp(path)
    if (stamp === undefined) return state.ledger
    if (stamp === state.stamp && state.ledger) return state.ledger
    const size = Number(stamp.split(':')[0])
    state.ledger = await advanceLedger(seat.kind, path, Number.isFinite(size) ? size : 0, state.ledger, ports.readJsonlFrom)
    state.stamp = stamp
    return state.ledger
  }

  const record = async (run: RunMeta, seat: string, rule: SteerRule, detail: string, id?: string): Promise<void> => {
    const event: DroveEvent = { at: deps.clock.now().toISOString(), type: 'steer.nudged', seat, ...(id ? { id } : {}), data: { seat, rule, detail } }
    await ports.appendJsonl(join(ports.runDir(deps.home, run.id), 'events.jsonl'), event)
  }

  const repeated = async (run: RunMeta, seat: Seat, ledger: Ledger, state: SeatSteer, config: SteerConfig): Promise<void> => {
    // A seat that is not at work, or has reported since its last failure, has no use for the message.
    if (seat.state !== 'working') return
    const streak = failureStreak(ledger)
    if (!streak || streak.count < config.repeatFailures) return
    if (seat.lastReport && streak.lastAt !== '' && Date.parse(seat.lastReport.at) >= Date.parse(streak.lastAt)) return
    const before = state.nudged
    if (before && streak.lastNumber <= before.number) return
    if (before && clockMs() - before.at < config.cooldownMinutes * 60_000) return
    const body = repeatText(streak.command, streak.count)
    state.nudged = { at: clockMs(), number: streak.lastNumber }
    const at = deps.clock.now().toISOString()
    const control: Control = { v: 1, id: `c-steer-r1-${seat.name}-${clockMs()}`, run: run.id, from: 'planner', to: seat.name, kind: 'message', expects: 'none', body, at }
    await ports.deliverControl(deps, run, control)
    await record(run, seat.name, 'R1', body)
  }

  const tick: Steering['tick'] = async (run, open, raw, options) => {
    const config = steerConfig(raw)
    if (!config.enabled) return
    const errors: unknown[] = []
    for (const seat of open) {
      const state = stateOf(run.id, seat.name)
      const now = clockMs()
      if (state.lastRunAt !== undefined && now - state.lastRunAt < STEER_EVERY_MS) continue
      state.lastRunAt = now
      try {
        const ledger = await refresh(seat, options, state)
        if (ledger) await repeated(run, seat, ledger, state, config)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw errors[0]
  }

  const annotate: Steering['annotate'] = async (run, report, options) => {
    // A confirmation after an approval (expects none) has nothing to check.
    if (report.kind !== 'done' || report.expects === 'none') return report
    const config = steerConfig((await ports.readJson<Partial<DroveConfig>>(join(deps.home, 'config.json')).catch(() => undefined))?.steering)
    if (!config.enabled) return report
    const seat = findSeat(await ports.loadRoster(deps.home, run.id), report.seat)
    if (!seat) return report
    const state = stateOf(run.id, seat.name)
    const ledger = await refresh(seat, options, state)
    if (!ledger) return report
    const found = unchecked(ledger, await planOf(run.repo, config.checkCommands))
    if (!found) return report
    const line = uncheckedText(found)
    await record(run, seat.name, 'R2', line, report.id)
    return { ...report, steering: line }
  }

  return { tick, annotate }
}

// The R2 lines the run's event log holds, by report id: `drove reports` reads reports from the outbox, which has none.
export const steeringNotes = async (runEventsPath: string): Promise<Map<string, string>> => {
  const events = await readJsonlTail<DroveEvent>(runEventsPath, 256 * 1024).catch(() => [] as DroveEvent[])
  const notes = new Map<string, string>()
  for (const event of events) if (event.type === 'steer.nudged' && event.id && event.data?.rule === 'R2' && typeof event.data.detail === 'string') notes.set(event.id, event.data.detail)
  return notes
}
