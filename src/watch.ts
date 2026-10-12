import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isForHuman } from '../mod/hooks/roster.ts'
import * as autocheck from './autocheck.ts'
import * as commands from './commands.ts'
import * as deliver from './deliver.ts'
import * as detect from './detect.ts'
import * as herdr from './herdr.ts'
import * as light from './light.ts'
import * as pendingLedger from './pending.ts'
import * as paths from './paths.ts'
import * as prompts from './prompts.ts'
import * as protocol from './protocol.ts'
import * as roster from './roster.ts'
import * as steer from './steer.ts'
import * as store from './store.ts'
import * as usage from './usage.ts'
import { buildReport, claudeTranscriptPath, seatCost } from './report.ts'
import { userClaudeDir } from './launch.ts'
import type { Attention, Control, Delivery, Deps, DroveConfig, DroveEvent, DroveEventType, HerdrAgent, HookRecord, Report, RunMeta, Seat } from './types.ts'

export const TICK_MS = 3_000
export const HERDR_POLL_MS = 5_000
export const BATCH_MS = 2_000
export const IDLE_WAKE_MS = 5_000
export const WAKE_RETRY_MS = 15_000
export const LOOP_MS = 1_000
export const COST_CHECK_MS = 60_000
const HOOK_WINDOW = 50
const WAIT = 'wait: '
// What a poll leaves alone: raised by someone other than the poll (a failed delivery, the guard hook) and cleared by its own event.
const KEPT_ATTENTION: readonly Attention['reason'][] = ['pending-delivery', 'guard-thrash']

export type WatchPorts = {
  runDir: typeof paths.runDir
  seatDir: typeof paths.seatDir
  plannerDir: typeof paths.plannerDir
  readJson: typeof store.readJson
  writeJsonAtomic: typeof store.writeJsonAtomic
  appendJsonl: typeof store.appendJsonl
  readJsonlFrom: typeof store.readJsonlFrom
  readToken: typeof store.readToken
  loadRun: typeof roster.loadRun
  loadRoster: typeof roster.loadRoster
  updateRoster: typeof roster.updateRoster
  openSeats: typeof roster.openSeats
  renderReports: typeof protocol.renderReports
  deriveState: typeof detect.deriveState
  needsNudge: typeof detect.needsNudge
  listAgents: typeof herdr.listAgents
  agentPromptArgv: typeof herdr.agentPromptArgv
  agentReadArgv: typeof herdr.agentReadArgv
  codexQueueArgv: typeof deliver.codexQueueArgv
  deliverControl: typeof deliver.deliverControl
  flushPending: typeof deliver.flushPending
  applyPendingPromotes: typeof commands.applyPendingPromotes
  nudgeText: typeof prompts.nudgeText
  advanceTokens: typeof usage.advanceTokens
  findRollout: typeof usage.findRollout
  seatCost: typeof seatCost
  buildReport: typeof buildReport
  userClaudeDir: typeof userClaudeDir
  transcriptStamp: (path: string) => Promise<string | undefined>
  modifiedAt: (path: string) => Promise<number | undefined>
  paneTty: typeof light.paneTty
  writeTty: typeof light.writeTty
  checkPlan: (repo: string) => Promise<string[]>
}

export const defaultWatchPorts: WatchPorts = {
  runDir: paths.runDir,
  seatDir: paths.seatDir,
  plannerDir: paths.plannerDir,
  readJson: store.readJson,
  writeJsonAtomic: store.writeJsonAtomic,
  appendJsonl: store.appendJsonl,
  readJsonlFrom: store.readJsonlFrom,
  readToken: store.readToken,
  loadRun: roster.loadRun,
  loadRoster: roster.loadRoster,
  updateRoster: roster.updateRoster,
  openSeats: roster.openSeats,
  renderReports: protocol.renderReports,
  deriveState: detect.deriveState,
  needsNudge: detect.needsNudge,
  listAgents: herdr.listAgents,
  agentPromptArgv: herdr.agentPromptArgv,
  agentReadArgv: herdr.agentReadArgv,
  codexQueueArgv: deliver.codexQueueArgv,
  deliverControl: deliver.deliverControl,
  flushPending: deliver.flushPending,
  applyPendingPromotes: commands.applyPendingPromotes,
  nudgeText: prompts.nudgeText,
  advanceTokens: usage.advanceTokens,
  findRollout: usage.findRollout,
  seatCost,
  buildReport,
  userClaudeDir,
  transcriptStamp: async path => {
    const file = await stat(path).catch(() => undefined)
    return file ? `${file.size}:${file.mtimeMs}` : undefined
  },
  modifiedAt: async path => (await stat(path).catch(() => undefined))?.mtimeMs,
  paneTty: light.paneTty,
  writeTty: light.writeTty,
  checkPlan: steer.defaultCheckPlan,
}

export type WatchOptions = {
  ports?: WatchPorts
  channel?: (content: string, meta: Record<string, string>) => void
  modWake?: (text: string) => Promise<boolean>
  onError?: (error: unknown, step: string) => void
  loop?: boolean
}

export type Watcher = {
  tick: () => Promise<void>
  takePending: () => Promise<Report[]>
  piggyback: (text: string) => Promise<string>
  start: () => void
  stop: () => void
}

type Cursors = Record<string, store.Cursor>
type Ledger = pendingLedger.LedgerLine

const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

const readFrom = async <T>(ports: WatchPorts, path: string, cursor: store.Cursor): Promise<{ items: T[]; cursor: store.Cursor }> => {
  try {
    return await ports.readJsonlFrom<T>(path, cursor)
  } catch (error) {
    if (isEnoent(error)) return { items: [], cursor }
    throw error
  }
}

const cursorsPath = (ports: WatchPorts, deps: Deps, run: RunMeta) => join(ports.plannerDir(deps.home, run.id), 'cursors.json')
const ledgerPath = (ports: WatchPorts, deps: Deps, run: RunMeta) => join(ports.plannerDir(deps.home, run.id), 'pending.jsonl')

const isReportShape = (value: unknown): value is Report => {
  const item = value as Partial<Report> | null
  return typeof item === 'object' && item !== null && item.v === 1 && typeof item.id === 'string' && typeof item.seat === 'string' && typeof item.token === 'string' && typeof item.summary === 'string' && protocol.REPORT_KINDS.includes(item.kind as Report['kind'])
}

type Scan = { reports: Report[]; rejected: { seat: string; id?: string; why: string }[]; commit: () => Promise<void> }

const scanOutboxes = async (deps: Deps, run: RunMeta, ports: WatchPorts): Promise<Scan> => {
  const known = await ports.loadRoster(deps.home, run.id)
  const cursors = (await ports.readJson<Cursors>(cursorsPath(ports, deps, run))) ?? {}
  const next: Cursors = { ...cursors }
  const reports: Report[] = []
  const rejected: Scan['rejected'] = []
  for (const seat of known.seats) {
    const dir = ports.seatDir(deps.home, run.id, seat.name)
    const read = await readFrom<unknown>(ports, join(dir, 'outbox.jsonl'), cursors[seat.name] ?? { offset: 0 })
    next[seat.name] = read.cursor
    if (read.items.length === 0) continue
    const token = await ports.readToken(join(dir, 'token'))
    for (const item of read.items) {
      const id = (item as Partial<Report> | null)?.id
      if (!isReportShape(item)) rejected.push({ seat: seat.name, id, why: 'malformed report' })
      else if (item.run !== run.id || item.seat !== seat.name) rejected.push({ seat: seat.name, id, why: 'run or seat does not match the outbox' })
      else if (!token || item.token !== token) rejected.push({ seat: seat.name, id, why: 'token mismatch' })
      // `autocheck` is Drove's own line on a report: a worker's outbox does not get to write it.
      else reports.push((({ autocheck: _, ...own }) => own)(item))
    }
  }
  const commit = async () => {
    await ports.writeJsonAtomic(cursorsPath(ports, deps, run), next)
  }
  return { reports, rejected, commit }
}

export const readNewReports = async (deps: Deps, run: RunMeta, ports: WatchPorts = defaultWatchPorts): Promise<Report[]> => {
  const scan = await scanOutboxes(deps, run, ports)
  await scan.commit()
  return scan.reports
}

export const shouldWake = (report: Report): boolean => report.kind !== 'progress'

const readLedger = async (deps: Deps, run: RunMeta, ports: WatchPorts): Promise<pendingLedger.Folded> =>
  pendingLedger.fold((await readFrom<Ledger>(ports, ledgerPath(ports, deps, run), { offset: 0 })).items)

const unackedReports = async (deps: Deps, run: RunMeta, ports: WatchPorts): Promise<Report[]> => (await readLedger(deps, run, ports)).open

const ackReports = async (deps: Deps, run: RunMeta, ports: WatchPorts, reports: readonly Report[]): Promise<void> => {
  if (reports.length === 0) return
  await ports.appendJsonl(ledgerPath(ports, deps, run), { t: 'ack', ids: reports.map((report) => report.id) } satisfies Ledger)
}

// Only a close the planner started makes a report stale. A seat that vanished ('gone') or went 'down' may
// have filed its last done or blocked report just before, and the planner still needs it.
const PLANNER_CLOSED: readonly Seat['state'][] = ['closing', 'closed']

const splitClosed = async (deps: Deps, run: RunMeta, ports: WatchPorts, reports: readonly Report[]): Promise<{ kept: Report[]; dropped: Report[] }> => {
  const current = await ports.loadRoster(deps.home, run.id)
  const gone = new Set(current.seats.filter((seat) => PLANNER_CLOSED.includes(seat.state)).map((seat) => seat.name))
  return { kept: reports.filter((report) => !gone.has(report.seat)), dropped: reports.filter((report) => gone.has(report.seat)) }
}

const withReports = (text: string, rendered: string, count: number): string =>
  `${text}\n\n— Drove: ${count} worker report${count === 1 ? '' : 's'} arrived while you were busy. Act on ${count === 1 ? 'it' : 'them'} now —\n${rendered}`

export const piggyback = async (deps: Deps, run: RunMeta, text: string, ports: WatchPorts = defaultWatchPorts): Promise<string> => {
  const { kept: reports, dropped } = await splitClosed(deps, run, ports, await unackedReports(deps, run, ports))
  await ackReports(deps, run, ports, dropped)
  if (reports.length === 0) return text
  await ackReports(deps, run, ports, reports)
  const config = await ports.readJson<Partial<DroveConfig>>(join(deps.home, 'config.json'))
  return withReports(text, ports.renderReports(reports, config?.humanName ?? 'the human'), reports.length)
}

const reportedThisEpisode = (seat: Seat): boolean => {
  const report = seat.lastReport
  if (!report || report.kind === 'progress') return false
  const episodeStart = seat.state === 'working' ? seat.stateAt : seat.state === 'starting' ? seat.spawnedAt : undefined
  return episodeStart !== undefined && Date.parse(report.at) >= Date.parse(episodeStart)
}

const attentionLine = (item: Attention) => (item.reason === 'usage-limit' ? `⚠ ${item.seat} ${item.detail}` : `⚠ ${item.seat}: ${item.reason}: ${item.detail}`)

const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text)

export const createWatcher = (deps: Deps, initial: RunMeta, options: WatchOptions = {}): Watcher => {
  const ports = options.ports ?? defaultWatchPorts
  const onError = options.onError ?? (() => {})
  const clockMs = () => deps.clock.now().getTime()
  let chain: Promise<unknown> = Promise.resolve()
  let timer: NodeJS.Timeout | undefined
  let batchStartedAt: number | undefined
  let lastWakeFailAt: number | undefined
  let lastWakeReason = ''
  let lastFlushAt: number | undefined
  let lastPollAt: number | undefined
  let plannerStatus: { status: HerdrAgent['status']; since: number } | undefined
  const notedPending = new Set<string>()
  let knownAttention = new Set<string>()
  // Thrash items come from the guard hook, which already wrote their event; the wake still carries each one once, and
  // not again after a restart: an item older than this watcher was announced by the one before it.
  const knownThrash = new Set<string>()
  const startedAt = deps.clock.now().toISOString()
  let freshAttention: Attention[] = []
  const hookWindows = new Map<string, { cursor: store.Cursor; records: HookRecord[]; turns: number; transcript?: string }>()
  const tokenCounters = new Map<string, usage.TokenCounter>()
  const transcriptPaths = new Map<string, Set<string>>()
  const transcriptSessions = new Map<string, Map<string, HookRecord['agent']>>()
  const costChecks = new Map<string, { at: number; signature: string; cost?: number }>()
  const steering = steer.createSteering(deps, ports)
  const steerOptions = (): steer.TickOptions => ({ claudeDir: deps.claudeUserDir ?? ports.userClaudeDir(), transcriptOf: name => hookWindows.get(name)?.transcript })
  let runBudgetRaised: boolean | undefined
  let humanName: string | undefined
  const plannerHooks: { cursor: store.Cursor; sessionId?: string } = { cursor: { offset: 0 } }
  let plannerAgentSession: string | undefined
  let lightHold: light.LightHold | undefined
  let lightTty: { paneId: string; path: string } | undefined
  let isStopped = false

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = chain.then(work, work)
    chain = result.catch(() => {})
    return result
  }

  const guarded = async (step: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      onError(error, step)
    }
  }

  const emit = async (type: DroveEventType, seat?: string, id?: string, data?: Record<string, unknown>) => {
    const event: DroveEvent = { at: deps.clock.now().toISOString(), type, ...(seat ? { seat } : {}), ...(id ? { id } : {}), ...(data ? { data } : {}) }
    await ports.appendJsonl(join(ports.runDir(deps.home, initial.id), 'events.jsonl'), event)
  }

  const currentRun = async (): Promise<RunMeta> => (await ports.loadRun(deps.home, initial.id)) ?? initial

  const render = async (reports: readonly Report[]): Promise<string> => {
    humanName ??= (await ports.readJson<Partial<DroveConfig>>(join(deps.home, 'config.json')))?.humanName ?? 'the human'
    return ports.renderReports(reports, humanName)
  }

  const attentionText = (): string => {
    const human = freshAttention.filter(isForHuman)
    const planner = freshAttention.filter(item => !isForHuman(item))
    return `${human.length === 0 ? '' : `\n\nNeeds the human:\n${human.map(attentionLine).join('\n')}`}${planner.length === 0 ? '' : `\n\nFor you to act on:\n${planner.map(attentionLine).join('\n')}`}`
  }

  // R2 (DROVE-127): a done report with no check after its worker's last edit carries a line for the planner. The line is
  // Drove's alone, so one a worker put in its own report is dropped, and steering never holds a report back.
  const steered = async (run: RunMeta, { steering: _forged, ...report }: Report): Promise<Report> => {
    try {
      // The hook window knows the seat's transcript; a report can arrive before any poll has read it.
      if (report.kind === 'done') await hooksFor(run, report.seat)
      return await steering.annotate(run, report, steerOptions())
    } catch (error) {
      onError(error, 'steer')
      return report
    }
  }

  const ingest = async (run: RunMeta) => {
    const scan = await scanOutboxes(deps, run, ports)
    if (scan.reports.length === 0 && scan.rejected.length === 0) return
    for (const item of scan.rejected) await emit('attention', item.seat, item.id, { reason: 'report-rejected', why: item.why })
    const { seen, held: heldNow } = await readLedger(deps, run, ports)
    await ports.updateRoster(deps.home, run.id, (current) => ({
      ...current,
      seats: current.seats.map((seat) => {
        const mine = scan.reports.filter((report) => report.seat === seat.name)
        const last = mine.at(-1)
        if (!last) return seat
        const owing = mine.filter((report) => report.kind !== 'progress').at(-1)
        return {
          ...seat,
          lastReport: { id: last.id, kind: last.kind, expects: last.expects, ...(last.for ? { for: last.for } : {}), summary: last.summary, at: last.at },
          owes: owing ? owing.expects : seat.owes,
          // Any report, a progress one too, ends the guard's thrash alarm: the seat is no longer silent about it.
          attention: seat.attention.filter((item) => item.reason !== 'guard-thrash'),
        }
      }),
      updatedAt: deps.clock.now().toISOString(),
    }))
    const seats = (await ports.loadRoster(deps.home, run.id)).seats
    const checked = scan.reports.some(report => report.kind === 'done') ? await autocheck.autoCheckSettings(deps.home, run.repo) : undefined
    // A seat with a held report holds its later ones too, so the planner never reads a report before the one it follows.
    const holding = new Set(heldNow.map(report => report.seat))
    for (const report of scan.reports) {
      await emit('report', report.seat, report.id, { kind: report.kind, expects: report.expects, summary: clip(report.summary) })
      if (!shouldWake(report) || seen.has(report.id)) continue
      // A done report of an implementer is held while Drove runs its checks; the planner is woken by the outcome (DROVE-126).
      // R2 still fires here, once, at ingest: the steered report is what the ledger holds and later releases.
      const held = holding.has(report.seat) || (checked !== undefined && autocheck.isCheckable(report, seats.find(seat => seat.name === report.seat)))
      if (held) holding.add(report.seat)
      await ports.appendJsonl(ledgerPath(ports, deps, run), { t: held ? 'hold' : 'add', report: await steered(run, report) } satisfies Ledger)
    }
    await scan.commit()
  }

  // ---------- Drove's own checks of a done report (DROVE-126) ----------

  // One check run per seat and at most MAX_RUNNING in the run, in the background: the tick never waits for one.
  const checking = new Map<string, Promise<void>>()

  type Noter = (report: Report) => string | undefined

  const release = async (run: RunMeta, reports: readonly Report[], noteOf: Noter = () => undefined) => {
    for (const report of reports) {
      const note = noteOf(report)
      await ports.appendJsonl(ledgerPath(ports, deps, run), { t: 'add', report: note ? { ...report, autocheck: note } : report } satisfies Ledger)
    }
  }

  const heldOf = async (run: RunMeta, seatName: string): Promise<Report[]> => (await readLedger(deps, run, ports)).held.filter(report => report.seat === seatName)

  const seatOf = async (run: RunMeta, seatName: string): Promise<Seat | undefined> => (await ports.loadRoster(deps.home, run.id)).seats.find(seat => seat.name === seatName)

  const withoutAttempts = (run: RunMeta, seatName: string) =>
    ports.updateRoster(deps.home, run.id, found => ({
      ...found,
      seats: found.seats.map(entry => {
        if (entry.name !== seatName) return entry
        const { autoCheckAttempts: _, ...rest } = entry
        return rest
      }),
    }))

  // The held reports of one seat, in the order they arrived. Under a lock per seat, because the MCP watcher and the mod's
  // bridge can both run for one run: the one that finds it taken leaves the seat to the other.
  const settle = async (run: RunMeta, seatName: string) => {
    const lock = join(ports.seatDir(deps.home, run.id, seatName), 'autocheck.lock')
    try {
      await store.withLock(lock, () => settleLocked(run, seatName), 10_000, 0)
    } catch (error) {
      if (!(error instanceof store.LockBusy)) throw error
    }
  }

  const settleLocked = async (run: RunMeta, seatName: string) => {
    const batch = await heldOf(run, seatName)
    if (batch.length === 0) return
    const seat = await seatOf(run, seatName)
    if (!seat || PLANNER_CLOSED.includes(seat.state)) return ackReports(deps, run, ports, batch)
    // What the checks vouch for are the done reports; the reports held behind them only wait their turn.
    const checkable = new Set(batch.filter(report => autocheck.isCheckable(report, seat)).map(report => report.id))
    const noteFor = (note: string): Noter => report => (checkable.has(report.id) ? note : undefined)
    if (checkable.size === 0) return release(run, batch)
    if (seat.state === 'gone' || seat.state === 'down') return release(run, batch, noteFor(autocheck.skippedLine(seat.name, seat.state)))
    const settings = await autocheck.autoCheckSettings(deps.home, run.repo)
    if (!settings) return release(run, batch)
    const result = await autocheck.runAutoCheck(deps, run, seat, settings.plan)
    const stillHeld = new Set((await heldOf(run, seatName)).map(report => report.id))
    const pending = batch.filter(report => stillHeld.has(report.id))
    const mine = pending.filter(report => checkable.has(report.id))
    const last = mine.at(-1)
    if (!last) return release(run, pending)
    const current = await seatOf(run, seatName)
    if (!current || PLANNER_CLOSED.includes(current.state)) return ackReports(deps, run, ports, pending)
    if (result.status === 'error') {
      await emit('autocheck.failed', seatName, last.id, { error: result.text })
      return release(run, pending, noteFor(autocheck.errorLine(result.text)))
    }
    const { outcome } = result
    const base = { sha: outcome.sha, clean: outcome.clean, commands: outcome.commands.map(entry => entry.command), reused: outcome.reused }
    if (result.status === 'passed') {
      await emit('autocheck.passed', seatName, last.id, base)
      if (current.autoCheckAttempts !== undefined) await withoutAttempts(run, seatName)
      return release(run, pending, noteFor(autocheck.passedLine(outcome)))
    }
    const { failed } = result
    const attempts = (current.autoCheckAttempts ?? 0) + 1
    const exhausted = attempts >= settings.attempts
    await emit('autocheck.failed', seatName, last.id, { ...base, attempt: attempts, max: settings.attempts, failed: failed.command, exit: failed.exit, sentBack: !exhausted })
    if (exhausted) {
      // The planner has it now: the next failure is the first of a new round, not another "failed 3 times".
      await withoutAttempts(run, seatName)
      return release(run, pending, noteFor(autocheck.exhaustedLine(outcome, failed, attempts)))
    }
    await ports.updateRoster(deps.home, run.id, found => ({ ...found, seats: found.seats.map(entry => (entry.name === seatName ? { ...entry, autoCheckAttempts: attempts } : entry)) }))
    const control = autocheck.verdictFor(run, seatName, last, autocheck.failureBody(outcome, failed, attempts, settings.attempts), deps.clock.now().toISOString())
    const delivery = await ports.deliverControl(deps, run, control)
    if (!delivery.ok && !delivery.queued) return release(run, pending, noteFor(autocheck.unsentLine(outcome, failed, delivery.reason)))
    // From here the worker has the verdict: nothing that fails next may hand the planner a report Drove already sent back.
    try {
      await ackReports(deps, run, ports, mine)
      await ports.updateRoster(deps.home, run.id, found => ({ ...found, seats: found.seats.map(entry => (entry.name === seatName && entry.lastReport?.id === last.id ? { ...entry, owes: 'none' as const } : entry)) }))
      await release(run, pending.filter(report => !checkable.has(report.id)))
    } catch (error) {
      onError(error, 'autocheck')
      await guarded('autocheck-event', () => emit('attention', seatName, last.id, { reason: 'autocheck-error', why: error instanceof Error ? error.message : String(error) }))
      await guarded('autocheck-ack', () => ackReports(deps, run, ports, mine))
    }
  }

  const pump = async (run: RunMeta) => {
    const seatNames = [...new Set((await readLedger(deps, run, ports)).held.map(report => report.seat))]
    for (const seatName of seatNames) {
      if (checking.size >= autocheck.MAX_RUNNING) break
      if (checking.has(seatName)) continue
      const job = settle(run, seatName)
        .catch(async error => {
          // A check that cannot run must not strand the report: the planner reads it, as it did before.
          onError(error, 'autocheck')
          await guarded('autocheck-release', async () => release(run, await heldOf(run, seatName), report => (report.kind === 'done' ? autocheck.errorLine(error instanceof Error ? error.message : String(error)) : undefined)))
        })
        .finally(() => checking.delete(seatName))
      checking.set(seatName, job)
    }
  }

  const plannerThread = async (run: RunMeta): Promise<string | undefined> => {
    if (run.planner.sessionId) return run.planner.sessionId
    const read = await readFrom<HookRecord>(ports, join(ports.plannerDir(deps.home, run.id), 'hooks.jsonl'), plannerHooks.cursor)
    plannerHooks.cursor = read.cursor
    plannerHooks.sessionId = read.items.filter((record) => record.event === 'session-start' && record.sessionId).at(-1)?.sessionId ?? plannerHooks.sessionId
    return plannerHooks.sessionId ?? plannerAgentSession
  }

  const wakeTransports = (run: RunMeta, text: string, reports: readonly Report[]): { name: string; attempt: () => Promise<(Delivery | deliver.UnconfirmedDelivery) | undefined> }[] => {
    const planner = run.planner
    return [
      {
        name: 'mod',
        attempt: async () => (planner.viaMod && options.modWake ? ((await options.modWake(text)) ? { ok: true, via: 'mod' } : { ok: false, queued: true, reason: 'mod refused the wake' }) : undefined),
      },
      {
        name: 'codex-queue',
        attempt: async () => {
          if (planner.kind !== 'codex') return undefined
          const thread = await plannerThread(run)
          if (!thread) return { ok: false, queued: true, reason: `${WAIT}the Codex planner thread is not known yet` }
          const result = await deps.exec(ports.codexQueueArgv(thread, text))
          return result.code === 0 ? { ok: true, via: 'codex-queue' } : { ok: false, queued: true, reason: `codex queue failed: ${clip(result.stderr.trim() || result.stdout.trim())}` }
        },
      },
      {
        name: 'channel',
        attempt: async () => {
          if (planner.kind !== 'claude' || !options.channel) return undefined
          options.channel(text, { kind: 'report', count: String(reports.length) })
          return { ok: true, via: 'channel' }
        },
      },
      {
        name: 'herdr-prompt',
        attempt: async () => {
          if (planner.kind !== 'claude' || !planner.paneId) return undefined
          const status = plannerStatus
          if (!status || (status.status !== 'idle' && status.status !== 'done')) return { ok: false, queued: true, reason: `${WAIT}planner pane is ${status?.status ?? 'not observed yet'}` }
          if (clockMs() - status.since < IDLE_WAKE_MS) return { ok: false, queued: true, reason: `${WAIT}planner pane has not been idle for 5 s yet` }
          const result = await deps.exec(ports.agentPromptArgv(planner.paneId, text))
          if (result.code === 0) return { ok: true, via: 'herdr-prompt' }
          const output = result.stderr.trim() || result.stdout.trim()
          if (herdr.isPromptUnconfirmed(output)) return { ok: true, via: 'herdr-prompt', unconfirmed: true }
          return { ok: false, queued: true, reason: `herdr agent prompt failed: ${clip(output)}` }
        },
      },
    ]
  }

  const dropClosed = async (run: RunMeta, unacked: readonly Report[]): Promise<Report[]> => {
    const { kept, dropped } = await splitClosed(deps, run, ports, unacked)
    await ackReports(deps, run, ports, dropped)
    for (const report of dropped) await emit('report.delivered', report.seat, report.id, { via: 'dropped-seat-closed' })
    return kept
  }

  const wake = async (run: RunMeta) => {
    const reports = await dropClosed(run, await unackedReports(deps, run, ports))
    if (reports.length === 0) {
      batchStartedAt = undefined
      lastWakeFailAt = undefined
      return
    }
    const now = clockMs()
    batchStartedAt ??= now
    if (now - batchStartedAt < BATCH_MS) return
    if (lastWakeFailAt !== undefined && now - lastWakeFailAt < WAKE_RETRY_MS && !lastWakeReason.includes(WAIT)) return
    const text = `${await render(reports)}${attentionText()}`
    const failures: string[] = []
    let delivered: Delivery | undefined
    for (const transport of wakeTransports(run, text, reports)) {
      const outcome = await transport.attempt()
      if (!outcome) continue
      if (outcome.ok) {
        delivered = outcome
        break
      }
      failures.push(`${transport.name}: ${outcome.reason}`)
    }
    if (delivered?.ok) {
      await ackReports(deps, run, ports, reports)
      // The mod only queues the text until the planner is idle, so a mod wake is a handoff, not a delivery.
      const via = 'unconfirmed' in delivered && delivered.unconfirmed ? `${delivered.via}-unconfirmed` : delivered.via === 'mod' ? 'mod-handoff' : delivered.via
      for (const report of reports) await emit('report.delivered', report.seat, report.id, { via })
      batchStartedAt = undefined
      lastWakeFailAt = undefined
      lastWakeReason = ''
      freshAttention = []
      return
    }
    lastWakeFailAt = now
    lastWakeReason = failures.at(-1) ?? 'no wake transport applies'
    for (const report of reports) {
      if (notedPending.has(report.id)) continue
      notedPending.add(report.id)
      await emit('report.pending', report.seat, report.id, { reason: failures.join('; ') || lastWakeReason })
    }
  }

  const hooksFor = async (run: RunMeta, seat: string): Promise<HookRecord[]> => {
    const window = hookWindows.get(seat) ?? { cursor: { offset: 0 }, records: [], turns: 0 }
    const read = await readFrom<HookRecord>(ports, join(ports.seatDir(deps.home, run.id, seat), 'hooks.jsonl'), window.cursor)
    window.cursor = read.cursor
    window.records = [...window.records, ...read.items].slice(-HOOK_WINDOW)
    // A turn ends at a Stop hook. The window forgets old records, so the count is kept apart (it rebuilds from the file's start).
    window.turns += read.items.filter((record) => record.event === 'stop').length
    window.transcript = read.items.findLast((record) => record.transcript)?.transcript ?? window.transcript
    const paths = transcriptPaths.get(seat) ?? new Set<string>()
    const sessions = transcriptSessions.get(seat) ?? new Map<string, HookRecord['agent']>()
    for (const record of read.items) {
      if (record.transcript) paths.add(record.transcript)
      if (record.sessionId) sessions.set(record.sessionId, record.agent)
    }
    transcriptPaths.set(seat, paths)
    transcriptSessions.set(seat, sessions)
    hookWindows.set(seat, window)
    return window.records
  }

  const tokensOf = async (seat: Seat): Promise<number | undefined> => {
    if (seat.maxTokens === undefined) return undefined
    const path = hookWindows.get(seat.name)?.transcript ?? (seat.kind === 'codex' && seat.codexHome && seat.sessionId ? await ports.findRollout(seat.codexHome, seat.sessionId) : undefined)
    if (!path) return undefined
    const counter = await ports.advanceTokens(seat.kind, path, tokenCounters.get(seat.name))
    tokenCounters.set(seat.name, counter)
    return counter.total
  }

  // Stat transcripts only on a cost-check interval; unchanged files keep their last price without a full read.
  const costSignature = async (run: RunMeta, seats: readonly Seat[], includePlanner: boolean): Promise<string> => {
    const claudeDir = deps.claudeUserDir ?? ports.userClaudeDir()
    const files = new Set<string>()
    for (const seat of seats) {
      for (const path of transcriptPaths.get(seat.name) ?? []) files.add(path)
      const sessions = new Map(transcriptSessions.get(seat.name))
      if (seat.sessionId) sessions.set(seat.sessionId, seat.kind)
      for (const [session, kind] of sessions) {
        if (kind === 'claude') files.add(claudeTranscriptPath(claudeDir, seat.worktree, session))
        else {
          const path = await ports.findRollout(seat.codexHome ?? paths.codexHomeDir(deps.home, run.id), session)
          if (path) files.add(path)
        }
      }
    }
    const plannerSession = run.planner.sessionId ?? plannerAgentSession ?? plannerHooks.sessionId
    if (includePlanner && plannerSession) {
      if (run.planner.kind === 'claude') files.add(claudeTranscriptPath(claudeDir, run.repo, plannerSession))
      else {
        const path = await ports.findRollout(paths.codexHomeDir(deps.home, run.id), plannerSession)
        if (path) files.add(path)
      }
    }
    const stamps = await Promise.all([...files].sort().map(async path => `${path}:${await ports.transcriptStamp(path) ?? 'missing'}`))
    return stamps.join('|')
  }

  const checkedCost = async (key: string, run: RunMeta, seats: readonly Seat[], includePlanner: boolean, read: () => Promise<number | undefined>): Promise<number | undefined> => {
    const now = deps.clock.now().getTime()
    const previous = costChecks.get(key)
    if (previous && now - previous.at < COST_CHECK_MS) return previous.cost
    const signature = await costSignature(run, seats, includePlanner)
    if (previous?.signature === signature) {
      costChecks.set(key, { ...previous, at: now })
      return previous.cost
    }
    const cost = await read().catch(() => undefined)
    costChecks.set(key, { at: now, signature, ...(cost !== undefined ? { cost } : {}) })
    return cost
  }

  // DROVE-141: the planner pane reads working in herdr while it waits on working workers (light.ts).
  const writeTitle = async (paneId: string, title: string): Promise<boolean> => {
    const path = lightTty?.paneId === paneId ? lightTty.path : await ports.paneTty(deps.exec, paneId)
    if (!path || isStopped) return false
    try {
      ports.writeTty(path, light.oscTitle(title))
    } catch (error) {
      lightTty = undefined
      throw error
    }
    lightTty = { paneId, path }
    return true
  }

  const stepLight = async (run: RunMeta, planner: HerdrAgent | undefined, seats: readonly Seat[]) => {
    const paneId = run.planner.paneId
    if (!paneId || isStopped) return
    // A run that goes down while Drove holds the title gets Claude's idle title back like any other end of the wait.
    const isLit = run.planner.kind === 'claude' && run.status === 'up' && light.wantsWorking(seats, runBudgetRaised === true)
    const step = light.stepLight(lightHold, planner, isLit, clockMs())
    lightHold = undefined
    if (step.write && !(await writeTitle(paneId, step.write))) return
    lightHold = step.hold
  }

  // A watcher that stops while it holds the title puts Claude's idle title back on its way out.
  const releaseLight = () => {
    if (!lightHold || !lightTty) return
    const { text } = lightHold
    lightHold = undefined
    try {
      ports.writeTty(lightTty.path, light.oscTitle(light.idleTitle(text)))
    } catch (error) {
      onError(error, 'light')
    }
  }

  const poll = async (run: RunMeta) => {
    const now = deps.clock.now()
    const listed = await ports.listAgents(deps.exec)
    if (!listed.ok) return
    const planner = run.planner.paneId ? listed.value.find((agent) => agent.paneId === run.planner.paneId) : undefined
    if (planner) plannerStatus = plannerStatus?.status === planner.status ? plannerStatus : { status: planner.status, since: now.getTime() }
    else plannerStatus = undefined
    plannerAgentSession = planner?.sessionId ?? plannerAgentSession
    const config = await ports.readJson<Partial<DroveConfig>>(join(deps.home, 'config.json'))
    const reviewLoopLimit = typeof config?.reviewLoopLimit === 'number' && Number.isInteger(config.reviewLoopLimit) && config.reviewLoopLimit > 0 ? config.reviewLoopLimit : 3
    const current = await ports.loadRoster(deps.home, run.id)
    const derived = new Map<string, { state: Seat['state']; attention: Attention[]; sessionId?: string }>()
    for (const seat of ports.openSeats(current).filter((open) => open.state !== 'closing')) {
      const target = herdr.agentTarget(run.id, seat)
      const agent = listed.value.find((candidate) => candidate.paneId === seat.paneId) ?? listed.value.find((candidate) => candidate.name === herdr.agentName(run.id, seat.name))
      const hooks = await hooksFor(run, seat.name)
      let screen: string | undefined
      if (detect.shouldReadScreen(agent, hooks, seat)) {
        const read = await deps.exec(ports.agentReadArgv(target, 40, 'visible'))
        screen = read.code === 0 ? read.stdout : undefined
      }
      // herdr's own 'working' needs no second opinion; otherwise the transcript's last write says whether an open turn is alive.
      const transcript = agent?.status === 'working' ? undefined : hookWindows.get(seat.name)?.transcript
      const transcriptAt = transcript ? await ports.modifiedAt(transcript) : undefined
      const result = ports.deriveState(seat, { herdr: agent, hooks, lastReport: seat.lastReport, screen, ...(transcriptAt !== undefined ? { transcriptAt } : {}) }, now)
      if (result.state !== 'gone' && (seat.maxTurns !== undefined || seat.maxTokens !== undefined || seat.maxMinutes !== undefined || seat.maxCost !== undefined)) {
        const tokens = await tokensOf(seat).catch(() => undefined)
        const cost = seat.maxCost !== undefined && !seat.budgetNoticed ? await checkedCost(`seat:${seat.name}`, run, [seat], false, () => ports.seatCost(deps, run, seat, deps.claudeUserDir ?? ports.userClaudeDir())) : undefined
        const detail = detect.budgetDetail(seat, { minutes: Math.max(0, now.getTime() - Date.parse(seat.spawnedAt)) / 60_000, ...(cost !== undefined ? { cost } : {}), turns: hookWindows.get(seat.name)?.turns ?? 0, ...(tokens !== undefined ? { tokens } : {}) })
        const noticed = seat.budgetNoticed ? seat.attention.find(item => item.reason === 'budget') ?? (seat.maxCost !== undefined ? { seat: seat.name, reason: 'budget' as const, detail: 'reached its budget (worker already notified)', at: seat.stateAt } : undefined) : undefined
        if (detail || noticed) result.attention = [...result.attention, detail ? { seat: seat.name, reason: 'budget', detail, at: now.toISOString() } : noticed as Attention]
      }
      const sessionId = seat.sessionId ? undefined : (hooks.findLast((record) => record.event === 'session-start' && record.sessionId) ?? hooks.findLast((record) => record.sessionId))?.sessionId
      derived.set(seat.name, { ...result, ...(sessionId ? { sessionId } : {}) })
    }
    if (runBudgetRaised === undefined) {
      const events = (await readFrom<DroveEvent>(ports, join(ports.runDir(deps.home, run.id), 'events.jsonl'), { offset: 0 })).items
      runBudgetRaised = events.some(event => event.type === 'attention' && event.data?.reason === 'run-budget')
    }
    if (!runBudgetRaised && typeof config?.runMaxCost === 'number' && Number.isFinite(config.runMaxCost) && config.runMaxCost > 0) {
      const cost = await checkedCost('run', run, current.seats, true, async () => (await ports.buildReport(deps, run.id, deps.claudeUserDir ?? ports.userClaudeDir()))?.totals.cost)
      if (cost !== undefined && cost > config.runMaxCost) {
        const item: Attention = { seat: 'planner', reason: 'run-budget', detail: `Run ${run.id} has used $${cost.toFixed(2)}, over its $${config.runMaxCost.toFixed(2)} budget: re-scope it or take it over`, at: now.toISOString() }
        await emit('attention', item.seat, undefined, { reason: item.reason, detail: item.detail })
        runBudgetRaised = true
        freshAttention.push(item)
      }
    }
    if (derived.size === 0) {
      await guarded('light', () => stepLight(run, planner, current.seats))
      return
    }
    // A seat's last check run goes stale once its worktree's HEAD has moved past the commit it ran at (DROVE-122).
    const heads = new Map<string, string>()
    for (const seat of ports.openSeats(current).filter((open) => open.checks !== undefined)) {
      const head = await deps.exec(['git', '-C', seat.worktree, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
      if (head.code === 0 && head.stdout.trim()) heads.set(seat.name, head.stdout.trim())
    }
    const at = now.toISOString()
    const transitions: { seat: string; from: Seat['state']; to: Seat['state'] }[] = []
    const restarting = new Set<string>()
    const updated = await ports.updateRoster(deps.home, run.id, (latest) => ({
      ...latest,
      seats: latest.seats.map((seat) => {
        const result = derived.get(seat.name)
        if (!result || seat.state === 'closing' || roster.CLOSED_STATES.has(seat.state)) return seat
        if (detect.isRestarting(seat, now)) {
          restarting.add(seat.name)
          return seat
        }
        const changed = result.state !== seat.state
        if (changed) transitions.push({ seat: seat.name, from: seat.state, to: result.state })
        const head = heads.get(seat.name)
        const isStale = seat.checks !== undefined && head !== undefined && head !== seat.checks.sha
        return {
          ...seat,
          ...(seat.checks && head !== undefined && isStale !== (seat.checks.stale === true) ? { checks: { ...seat.checks, stale: isStale } } : {}),
          state: result.state,
          stateAt: changed ? at : seat.stateAt,
          ...(result.sessionId && !seat.sessionId ? { sessionId: result.sessionId } : {}),
          attention: [...seat.attention.filter((item) => KEPT_ATTENTION.includes(item.reason)), ...result.attention,
            ...((seat.reviewChanges ?? 0) >= reviewLoopLimit ? [{ seat: seat.name, reason: 'review-loop' as const, detail: detect.reviewLoopText(seat.name, seat.reviewChanges ?? 0), at: seat.attention.find(item => item.reason === 'review-loop')?.at ?? at }] : [])],
          ...(result.state === 'working' && !reportedThisEpisode(seat) ? { lastWorkingAt: at } : {}),
          ...(result.state === 'working' && seat.state !== 'working' ? { hasNudged: false } : {}),
        }
      }),
      updatedAt: at,
    }))
    for (const move of transitions) await emit('seat.state', move.seat, undefined, { from: move.from, to: move.to })
    await guarded('light', () => stepLight(run, planner, updated.seats))
    const live = new Set<string>()
    for (const [name, result] of derived) {
      if (restarting.has(name)) continue
      for (const item of [...result.attention, ...(updated.seats.find(seat => seat.name === name)?.attention.filter(item => item.reason === 'review-loop') ?? [])]) {
        const key = `${item.seat}|${item.reason}`
        live.add(key)
        if (knownAttention.has(key)) continue
        freshAttention.push(item)
        await emit('attention', item.seat, undefined, { reason: item.reason, detail: item.detail })
      }
    }
    knownAttention = live
    for (const seat of updated.seats) {
      for (const item of seat.attention) {
        const key = `${item.seat}|${item.at}`
        if (item.reason !== 'guard-thrash' || knownThrash.has(key)) continue
        knownThrash.add(key)
        if (item.at >= startedAt) freshAttention.push(item)
      }
    }
    for (const seat of updated.seats) {
      const budget = seat.attention.find((item) => item.reason === 'budget')
      if (!derived.has(seat.name) || restarting.has(seat.name) || !budget || !detect.needsBudgetNotice(seat)) continue
      const control: Control = { v: 1, id: `c-budget-${seat.name}-${now.getTime()}`, run: run.id, from: 'planner', to: seat.name, kind: 'message', expects: 'none', body: detect.budgetNoticeText(budget.detail), at }
      await guarded('budget-notice', async () => {
        await ports.deliverControl(deps, run, control)
      })
      await ports.updateRoster(deps.home, run.id, (latest) => ({ ...latest, seats: latest.seats.map((item) => (item.name === seat.name ? { ...item, budgetNoticed: true } : item)) }))
    }
    const steerable = updated.seats.filter(seat => derived.has(seat.name) && !restarting.has(seat.name))
    await guarded('steer', () => steering.tick(run, steerable, config?.steering, steerOptions()))
    for (const seat of updated.seats) {
      if (!derived.has(seat.name) || !ports.needsNudge(seat, now)) continue
      const control: Control = { v: 1, id: `c-nudge-${seat.name}-${now.getTime()}`, run: run.id, from: 'planner', to: seat.name, kind: 'nudge', expects: 'answer', body: ports.nudgeText(), at }
      await guarded('nudge', async () => {
        await ports.deliverControl(deps, run, control)
      })
      await ports.updateRoster(deps.home, run.id, (latest) => ({ ...latest, seats: latest.seats.map((item) => (item.name === seat.name ? { ...item, hasNudged: true } : item)) }))
    }
  }

  const flush = async (run: RunMeta) => {
    for (const seat of ports.openSeats(await ports.loadRoster(deps.home, run.id))) {
      await guarded('flush-pending', async () => {
        await ports.flushPending(deps, run, seat.name)
      })
    }
    await guarded('promote-pending', async () => {
      await ports.applyPendingPromotes(deps, run)
    })
  }

  const due = (last: number | undefined, every: number) => last === undefined || clockMs() - last >= every

  const tick = () =>
    serial(async () => {
      const run = await currentRun()
      await guarded('ingest', () => ingest(run))
      await guarded('autocheck', () => pump(run))
      if (due(lastPollAt, HERDR_POLL_MS)) {
        lastPollAt = clockMs()
        await guarded('poll', () => poll(run))
      }
      await guarded('wake', () => wake(run))
      if (due(lastFlushAt, TICK_MS)) {
        lastFlushAt = clockMs()
        await guarded('flush', () => flush(run))
      }
    })

  const takePending = () =>
    serial(async () => {
      const run = await currentRun()
      await guarded('ingest', () => ingest(run))
      await guarded('autocheck', () => pump(run))
      const reports = await dropClosed(run, await unackedReports(deps, run, ports))
      await ackReports(deps, run, ports, reports)
      for (const report of reports) await emit('report.delivered', report.seat, report.id, { via: 'piggyback' })
      if (reports.length > 0) batchStartedAt = undefined
      return reports
    })

  const piggybackText = async (text: string) => {
    const reports = await takePending()
    const attention = attentionText()
    freshAttention = []
    if (reports.length === 0) return `${text}${attention}`
    return `${withReports(text, await render(reports), reports.length)}${attention}`
  }

  const start = () => {
    if (timer) return
    timer = setInterval(() => void tick().catch((error) => onError(error, 'tick')), LOOP_MS)
    timer.unref()
    void tick().catch((error) => onError(error, 'tick'))
  }

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = undefined
    isStopped = true
    releaseLight()
  }

  const watcher: Watcher = { tick, takePending, piggyback: piggybackText, start, stop }
  if (options.loop !== false) start()
  return watcher
}
