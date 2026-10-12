import type { Effort, OrchFeedEntry, OrchModStatus, Seat, SeatState } from '../types/index.d.ts'
import { shortModel } from './protocol.ts'

export const CLOSED_STATES: ReadonlySet<SeatState> = new Set(['closed', 'gone', 'down'])

export const openSeats = (seats: readonly Seat[]): Seat[] => seats.filter(({ state }) => !CLOSED_STATES.has(state))

export const findSeat = (seats: readonly Seat[], name: string): Seat | undefined => seats.find(seat => seat.name === name && !CLOSED_STATES.has(seat.state))

const STATUS_GLYPH: Record<SeatState, string> = {
  starting: '…', working: '⚙', idle: '·', done: '✓', blocked: '⛔', 'needs-input': '?', unknown: '?', gone: '×', closing: '×', closed: '×', down: '⏸',
}

export const statusGlyph = (state: SeatState): string => STATUS_GLYPH[state]

export const effortLetter = (effort: Effort): string => (effort === 'xhigh' ? 'xh' : effort.charAt(0))

export const modelLetter = (seat: Pick<Seat, 'kind' | 'model'>): string => (seat.kind === 'codex' ? 'cx' : shortModel(seat.model).charAt(0))

// DROVE-122: a seat's last check run, as one word: stale once its worktree's HEAD has moved past the commit the run was at.
export type CheckState = 'passed' | 'failed' | 'stale'

export const checkState = (seat: Pick<Seat, 'checks'>): CheckState | undefined => (seat.checks === undefined ? undefined : seat.checks.stale ? 'stale' : seat.checks.result)

// The long form, for the web panel: `passed at 1a2b3c4`, `failed: npm test at 1a2b3c4`, `stale: passed at 1a2b3c4, HEAD has moved`.
export const checkText = (seat: Pick<Seat, 'checks'>): string => {
  const { checks } = seat
  if (checks === undefined) return ''
  const at = checks.sha.slice(0, 7)
  const ran = checks.result === 'passed' ? `passed at ${at}` : `failed${checks.failed ? `: ${checks.failed}` : ''} at ${at}`
  return `${checks.stale ? 'stale: ' : ''}${ran}${checks.stale ? ', HEAD has moved' : ''}${checks.clean ? '' : ' (tree not clean)'}`
}

export const isAsking =(seat: Seat, status: OrchModStatus | undefined): boolean => Boolean(status?.asking) || seat.state === 'needs-input'

// Attention the planner acts on by itself (a nudge to the seat, a retry, a wrap-up): a person is never asked about it, so
// it is not "needs you" on any board and not an item of `drove attention` (DROVE-108).
const PLANNER_ATTENTION: ReadonlySet<string> = new Set(['idle-without-report', 'stalled', 'budget', 'pending-delivery', 'guard-thrash'])

export const isForHuman = (item: { reason: string }): boolean => !PLANNER_ATTENTION.has(item.reason)

export const FEED_MAX = 50

export const pushFeed = (feed: readonly OrchFeedEntry[], entry: OrchFeedEntry): OrchFeedEntry[] => [...feed, entry].slice(-FEED_MAX)

export const spawnedMs = (seat: Seat): number => Date.parse(seat.spawnedAt) || 0
