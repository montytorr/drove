import { DEFAULT_START_TIMEOUT_MS } from './herdr.ts'
import type { Attention, Derived, HerdrAgent, HookRecord, LastReport, Seat, SeatSignals, SeatState } from './types.ts'

type Dialog = { pattern: RegExp; reason: Attention['reason']; detail: string; hint: string; detailOf?: (screen: string) => string }

const CODEX_LIMIT = /^[^\w\n]*You['’]ve hit your usage limit/m
const CLAUDE_LIMIT = /^[^\w\n]*(?:You['’]ve (?:hit|reached) your (?!fast limit)|You['’]re out of (?:extra )?usage|Your org is out of usage)/m
const CODEX_RESET = /try again at ([^.]{1,40})\./i
const CLAUDE_RESET = /resets (?:at )?([^·\n]+?)\s*(?:·|$)/m

const resetAfter = (screen: string, start: RegExp, reset: RegExp, wraps: boolean): string | undefined => {
  const at = screen.search(start)
  if (at < 0) return undefined
  const tail = screen.slice(at, at + 400)
  return reset.exec(wraps ? tail.replace(/\s+/g, ' ') : tail)?.[1]?.trim()
}

const limitDetail = (reset: string | undefined): string => `hit its usage limit${reset ? ` (resets ${reset})` : ''}`

export const DIALOGS: readonly Dialog[] = [
  {
    pattern: CODEX_LIMIT,
    reason: 'usage-limit',
    detail: limitDetail(undefined),
    detailOf: screen => limitDetail(resetAfter(screen, CODEX_LIMIT, CODEX_RESET, true)),
    hint: 'Codex hit its usage limit; wait for the reset, close and respawn, or migrate the worker',
  },
  {
    pattern: CLAUDE_LIMIT,
    reason: 'usage-limit',
    detail: limitDetail(undefined),
    detailOf: screen => limitDetail(resetAfter(screen, CLAUDE_LIMIT, CLAUDE_RESET, false)),
    hint: 'Claude hit its usage limit; wait for the reset, close and respawn, or migrate the worker',
  },
  {
    pattern: /Background server has incompatible feature settings/,
    reason: 'codex-version-mismatch',
    detail: 'Codex CLI and app-server daemon versions differ; align them (codex --version vs the daemon). Drove will not answer the dialog.',
    hint: 'Codex CLI and its app-server daemon versions differ',
  },
  {
    pattern: /trust (this|the files in this) folder|trust the contents of this directory|project you created or one you trust/i,
    reason: 'trust',
    detail: 'A folder-trust prompt is waiting in the pane.',
    hint: 'Claude is asking to trust the folder',
  },
  {
    pattern: /hooks? needs? review|hooks? (is|are) new or changed/i,
    reason: 'hook-trust',
    detail: "Codex is asking to review the Drove hooks before they can run; approve them once in the pane and Codex remembers them. Drove will not answer it.",
    hint: "approve Drove's hooks once in the pane; Codex remembers them",
  },
  { pattern: /hook.*trust/i, reason: 'hook-trust', detail: 'A hook-trust prompt is waiting in the pane.', hint: 'the agent is asking to trust the Drove hooks' },
  {
    pattern: /Update available|Update now \(runs/,
    reason: 'dialog',
    detail: 'Codex is offering an update at startup; choose Skip in the pane. Drove will not answer it.',
    hint: 'Codex is offering an update; choose Skip in the pane',
  },
  {
    pattern: /Codex just got an upgrade|Try new model/,
    reason: 'dialog',
    detail: 'Codex is offering a model migration at startup; pick an option in the pane. Drove will not answer it.',
    hint: 'Codex is offering a new model; pick an option in the pane',
  },
  { pattern: /development channels?/i, reason: 'channel-confirm', detail: 'A development-channel confirmation is waiting in the pane.', hint: 'Claude is asking to confirm the development channel' },
]

export const HOOK_FRESH_MS = 10_000
// An open turn (a prompt submitted, no Stop since) outranks herdr's idle for this long after the seat last showed life.
// Claude does not fire Stop when the turn is interrupted, so a turn that has gone quiet this long is not trusted.
export const OPEN_TURN_QUIET_MS = 5 * 60_000
export const EXIT_WAIT_MS = 20_000
export const RESTART_BOUND_MS = 2 * EXIT_WAIT_MS + DEFAULT_START_TIMEOUT_MS
export const NUDGE_GRACE_MS = 20_000

const DERIVED_REASONS: ReadonlySet<Attention['reason']> = new Set(['dialog', 'permission', 'trust', 'hook-trust', 'channel-confirm', 'codex-version-mismatch', 'usage-limit', 'idle-without-report', 'gone', 'budget'])
// What the transcript's last write says about a seat whose turn the hooks call open; the watcher stats it (mtime, ms).
export type TurnSignals = SeatSignals & { transcriptAt?: number }

const SETTLED: ReadonlySet<SeatState> = new Set(['idle', 'done'])
const PERMISSION_NOTICE = /permission|approv|elicitation|dialog|trust/i

const ms = (at: string | undefined): number => (at ? Date.parse(at) : Number.NaN)

export const isRestarting = (seat: Seat, now: Date): boolean => {
  const since = ms(seat.restartingSince)
  return !Number.isNaN(since) && now.getTime() - since < RESTART_BOUND_MS
}

export const findDialog = (screen: string): Dialog | undefined => DIALOGS.find(({ pattern }) => pattern.test(screen))

// A seat that stopped after working, with nothing reported since, may be sitting at a usage-limit screen.
const isSilentSinceWork = (seat: Seat, reported: LastReport | undefined): boolean => {
  if (!seat.lastWorkingAt) return false
  const last = reported ?? seat.lastReport
  const reportedAt = ms(last?.at)
  if (reportedAt >= ms(seat.lastWorkingAt)) return false
  return !(last && last.kind !== 'progress' && !(ms(seat.lastSentAt) > reportedAt))
}

export const shouldReadScreen = (agent: HerdrAgent | undefined, hooks: readonly HookRecord[], seat?: Seat): boolean => {
  if (!agent) return false
  if (agent.status === 'blocked') return true
  if (agent.status === 'working') return false
  return (seat !== undefined && isSilentSinceWork(seat, undefined)) || !hooks.some(hook => hook.event === 'session-start' || hook.event === 'user-prompt-submit')
}

export const matchDialog = (seat: string, screen: string, at: Date): Attention | undefined => {
  const hit = findDialog(screen)
  return hit ? { seat, reason: hit.reason, detail: hit.detailOf?.(screen) ?? hit.detail, at: at.toISOString() } : undefined
}

const latest = (hooks: readonly HookRecord[], events: readonly HookRecord['event'][]): HookRecord | undefined =>
  hooks.reduce<HookRecord | undefined>((best, hook) => (events.includes(hook.event) && !(ms(hook.at) < ms(best?.at)) ? hook : best), undefined)

const LIMIT_ERRORS = /^(?:rate_limit|billing_error)\b/

// Claude's StopFailure hook (DROVE-69) is a durable usage-limit signal: it holds after the limit text has scrolled
// off the screen, until the seat starts or takes a prompt again.
const hookLimit = (seat: string, hooks: readonly HookRecord[], at: string): Attention | undefined => {
  const failure = latest(hooks, ['stop-failure'])
  const detail = failure?.detail ?? ''
  if (!failure || !LIMIT_ERRORS.test(detail)) return undefined
  const after = latest(hooks, ['session-start', 'user-prompt-submit', 'pre-tool-use', 'stop'])
  if (after && ms(after.at) > ms(failure.at)) return undefined
  const reset = CLAUDE_RESET.exec(detail)?.[1]?.trim()
  return { seat, reason: 'usage-limit', detail: reset ? limitDetail(reset) : `hit its usage limit (${detail.split(':')[0]})`, at }
}

const isPermissionAsk = (hook: HookRecord): boolean => hook.event === 'permission-request' || (hook.event === 'notification' && PERMISSION_NOTICE.test(hook.detail ?? ''))

const pendingAsk = (hooks: readonly HookRecord[]): HookRecord | undefined => {
  const ask = hooks.reduce<HookRecord | undefined>((best, hook) => (isPermissionAsk(hook) && !(ms(hook.at) < ms(best?.at)) ? hook : best), undefined)
  if (!ask) return undefined
  const cleared = latest(hooks, ['stop', 'user-prompt-submit', 'session-start'])
  return cleared && ms(cleared.at) >= ms(ask.at) ? undefined : ask
}

const isOwed = (seat: Seat, reported: LastReport | undefined): boolean => {
  if (reported && reported.id !== seat.lastReport?.id) return reported.expects !== 'none' && reported.kind !== 'progress'
  return seat.owes !== 'none'
}

// The prompt (or tool call) that started a turn nothing has ended: no Stop, StopFailure or new session since (DROVE-108).
// herdr flips a busy seat to idle after a prompt is typed into it, so the hooks are the truth while a turn is open.
const openTurn = (hooks: readonly HookRecord[]): HookRecord | undefined => {
  const opened = latest(hooks, ['user-prompt-submit', 'pre-tool-use'])
  const closed = latest(hooks, ['stop', 'stop-failure', 'session-start'])
  return opened !== undefined && !(closed !== undefined && ms(closed.at) >= ms(opened.at)) ? opened : undefined
}

// `since` is the report the turn must come after when the seat owes one: the turn that filed it is about to stop.
const isTurnLive = (hooks: readonly HookRecord[], since: number, signals: TurnSignals, now: number): boolean => {
  const turn = openTurn(hooks)
  const opened = ms(turn?.at)
  if (turn === undefined || Number.isNaN(opened) || opened <= since) return false
  return now - Math.max(opened, signals.transcriptAt ?? Number.NEGATIVE_INFINITY) <= OPEN_TURN_QUIET_MS
}

const idleWithoutReport = (seat: Seat, state: SeatState, reported: LastReport | undefined, now: Date): boolean =>
  SETTLED.has(state) && isSilentSinceWork(seat, reported) && now.getTime() - ms(seat.stateAt) >= NUDGE_GRACE_MS

export const deriveState = (seat: Seat, signals: TurnSignals, now: Date): Derived => {
  if (seat.state === 'closed' || seat.state === 'down' || seat.state === 'closing') return { state: seat.state, attention: [] }
  if (isRestarting(seat, now)) return { state: seat.state, attention: [] }
  const at = now.toISOString()
  const nowMs = now.getTime()
  const attention: Attention[] = []
  const add = (reason: Attention['reason'], detail: string) => attention.push({ seat: seat.name, reason, detail, at })
  const { herdr, hooks } = signals
  const reported = signals.lastReport

  if (!herdr && (seat.state !== 'starting' || seat.restartingSince !== undefined)) {
    add('gone', `pane ${seat.paneId ?? '?'} is gone; run \`drove up --seat ${seat.name}\` to relaunch it`)
    return { state: 'gone', attention }
  }

  const dialog = (signals.screen ? matchDialog(seat.name, signals.screen, now) : undefined) ?? hookLimit(seat.name, hooks, at)
  const ask = pendingAsk(hooks)
  const isAskLive = ask !== undefined && (herdr?.status !== 'working' || nowMs - ms(ask.at) <= HOOK_FRESH_MS)

  let state: SeatState
  if (isAskLive) {
    state = 'needs-input'
    add('permission', ask.detail ? `waiting for approval: ${ask.detail}` : 'waiting for an approval in the pane')
    if (dialog) attention.push(dialog)
  } else if (herdr?.status === 'blocked' || dialog) {
    state = 'blocked'
    attention.push(dialog ?? { seat: seat.name, reason: 'dialog', detail: 'The pane is waiting at a dialog or approval prompt; Drove will not answer it.', at })
  } else {
    const owed = isOwed(seat, reported)
    const stopped = latest(hooks, ['stop'])
    const worked = latest(hooks, ['user-prompt-submit', 'pre-tool-use'])
    const isStoppedFresh = stopped !== undefined && ms(stopped.at) >= ms(worked?.at) && nowMs - ms(stopped.at) <= HOOK_FRESH_MS
    const reportedAt = ms((reported ?? seat.lastReport)?.at)
    const isWorking = owed
      ? isTurnLive(hooks, Number.isNaN(reportedAt) ? 0 : reportedAt, signals, nowMs)
      : isTurnLive(hooks, 0, signals, nowMs) || (herdr?.status === 'working' && !isStoppedFresh)
    if (isWorking) state = 'working'
    else if (!herdr) state = 'starting'
    else if (herdr.status === 'done') state = 'done'
    else if (herdr.status === 'unknown' && !owed) state = 'unknown'
    else state = 'idle'
    if (idleWithoutReport(seat, state, reported, now)) add('idle-without-report', 'The seat stopped without sending a report (done, question or blocked).')
  }
  return { state, attention }
}

export type SeatUsage = { turns: number; tokens?: number }

const COUNT = new Intl.NumberFormat('en-US')

// A seat reaches its budget at maxTurns Stop records or maxTokens tokens, whichever comes first (DROVE-71).
export const budgetDetail = (seat: Pick<Seat, 'maxTurns' | 'maxTokens'>, usage: SeatUsage): string | undefined => {
  if (seat.maxTurns !== undefined && usage.turns >= seat.maxTurns) return `used ${usage.turns} of its ${seat.maxTurns} turns`
  if (seat.maxTokens !== undefined && usage.tokens !== undefined && usage.tokens >= seat.maxTokens) return `used ${COUNT.format(usage.tokens)} of its ${COUNT.format(seat.maxTokens)} tokens`
  return undefined
}

export const budgetNoticeText = (detail: string): string =>
  `Budget reached: you have ${detail}. Do not start new work. Send a progress report with the drove report tool (what is done, what is left), or a promote report if you need more room, and stop.`

// The worker is told once, and not while it is waiting on the planner after a done, question or blocked report.
export const needsBudgetNotice = (seat: Seat): boolean =>
  !seat.budgetNoticed && seat.owes === 'none' && seat.attention.some(item => item.reason === 'budget')

export const needsNudge = (seat: Seat, now: Date): boolean => {
  if (!SETTLED.has(seat.state) || seat.hasNudged || seat.owes !== 'none') return false
  if (seat.attention.some(item => item.reason === 'usage-limit' || item.reason === 'budget')) return false
  return idleWithoutReport(seat, seat.state, undefined, now)
}

export const mergeAttention = (existing: readonly Attention[], derived: readonly Attention[]): Attention[] => [
  ...existing.filter(item => !DERIVED_REASONS.has(item.reason)),
  ...derived,
]

export const applyDerived = (seat: Seat, derived: Derived, now: Date): Seat => {
  if (isRestarting(seat, now)) return seat
  const at = now.toISOString()
  const isChange = derived.state !== seat.state
  const isWorking = derived.state === 'working'
  return {
    ...seat,
    state: derived.state,
    stateAt: isChange ? at : seat.stateAt,
    ...(isWorking ? { lastWorkingAt: at, hasNudged: false } : {}),
    attention: mergeAttention(seat.attention, derived.attention),
  }
}
