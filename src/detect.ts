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
export const EXIT_WAIT_MS = 20_000
export const RESTART_BOUND_MS = 2 * EXIT_WAIT_MS + DEFAULT_START_TIMEOUT_MS
export const NUDGE_GRACE_MS = 20_000

const DERIVED_REASONS: ReadonlySet<Attention['reason']> = new Set(['dialog', 'permission', 'trust', 'hook-trust', 'channel-confirm', 'codex-version-mismatch', 'usage-limit', 'idle-without-report', 'gone'])
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

const hookWorkingAfter = (hooks: readonly HookRecord[], since: number, now: number, freshMs: number): boolean => {
  const work = latest(hooks, ['user-prompt-submit', 'pre-tool-use'])
  const at = ms(work?.at)
  return work !== undefined && at > since && now - at <= freshMs
}

const idleWithoutReport = (seat: Seat, state: SeatState, reported: LastReport | undefined, now: Date): boolean =>
  SETTLED.has(state) && isSilentSinceWork(seat, reported) && now.getTime() - ms(seat.stateAt) >= NUDGE_GRACE_MS

export const deriveState = (seat: Seat, signals: SeatSignals, now: Date): Derived => {
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

  const dialog = signals.screen ? matchDialog(seat.name, signals.screen, now) : undefined
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
      ? hookWorkingAfter(hooks, Number.isNaN(reportedAt) ? 0 : reportedAt, nowMs, HOOK_FRESH_MS)
      : hookWorkingAfter(hooks, ms(stopped?.at) || 0, nowMs, HOOK_FRESH_MS) || (herdr?.status === 'working' && !isStoppedFresh)
    if (isWorking) state = 'working'
    else if (!herdr) state = 'starting'
    else if (herdr.status === 'done') state = 'done'
    else if (herdr.status === 'unknown' && !owed) state = 'unknown'
    else state = 'idle'
    if (idleWithoutReport(seat, state, reported, now)) add('idle-without-report', 'The seat stopped without sending a report (done, question or blocked).')
  }
  return { state, attention }
}

export const needsNudge = (seat: Seat, now: Date): boolean => {
  if (!SETTLED.has(seat.state) || seat.hasNudged || seat.owes !== 'none') return false
  if (seat.attention.some(item => item.reason === 'usage-limit')) return false
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
