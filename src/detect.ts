import type { Attention, Derived, HookRecord, LastReport, Seat, SeatSignals, SeatState } from './types.ts'

export const DIALOGS: readonly { pattern: RegExp; reason: Attention['reason']; detail: string }[] = [
  {
    pattern: /Background server has incompatible feature settings/,
    reason: 'codex-version-mismatch',
    detail: 'Codex CLI and app-server daemon versions differ; align them (codex --version vs the daemon). Drove will not answer the dialog.',
  },
  { pattern: /trust (this|the files in this) folder/i, reason: 'trust', detail: 'A folder-trust prompt is waiting in the pane.' },
  { pattern: /hook.*trust/i, reason: 'hook-trust', detail: 'A hook-trust prompt is waiting in the pane.' },
  { pattern: /development channels?/i, reason: 'channel-confirm', detail: 'A development-channel confirmation is waiting in the pane.' },
]

export const HOOK_FRESH_MS = 10_000
export const NUDGE_GRACE_MS = 20_000

const DERIVED_REASONS: ReadonlySet<Attention['reason']> = new Set(['dialog', 'permission', 'trust', 'hook-trust', 'channel-confirm', 'codex-version-mismatch', 'idle-without-report', 'gone'])
const SETTLED: ReadonlySet<SeatState> = new Set(['idle', 'done'])
const PERMISSION_NOTICE = /permission|approv|elicitation|dialog|trust/i

const ms = (at: string | undefined): number => (at ? Date.parse(at) : Number.NaN)

export const matchDialog = (seat: string, screen: string, at: Date): Attention | undefined => {
  const hit = DIALOGS.find(({ pattern }) => pattern.test(screen))
  return hit ? { seat, reason: hit.reason, detail: hit.detail, at: at.toISOString() } : undefined
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

const idleWithoutReport = (seat: Seat, state: SeatState, reported: LastReport | undefined, now: Date): boolean => {
  if (!SETTLED.has(state) || !seat.lastWorkingAt) return false
  const reportedAt = ms((reported ?? seat.lastReport)?.at)
  if (reportedAt >= ms(seat.lastWorkingAt)) return false
  return now.getTime() - ms(seat.stateAt) >= NUDGE_GRACE_MS
}

export const deriveState = (seat: Seat, signals: SeatSignals, now: Date): Derived => {
  if (seat.state === 'closed' || seat.state === 'down') return { state: seat.state, attention: [] }
  const at = now.toISOString()
  const nowMs = now.getTime()
  const attention: Attention[] = []
  const add = (reason: Attention['reason'], detail: string) => attention.push({ seat: seat.name, reason, detail, at })
  const { herdr, hooks } = signals
  const reported = signals.lastReport

  if (!herdr && seat.state !== 'starting') {
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
  return idleWithoutReport(seat, seat.state, undefined, now)
}

export const mergeAttention = (existing: readonly Attention[], derived: readonly Attention[]): Attention[] => [
  ...existing.filter(item => !DERIVED_REASONS.has(item.reason)),
  ...derived,
]

export const applyDerived = (seat: Seat, derived: Derived, now: Date): Seat => {
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
