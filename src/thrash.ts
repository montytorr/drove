import type { Attention, DroveEvent, GuardRule } from './types.ts'

// DROVE-121: a seat that keeps hitting the same guard rule is stuck, and nobody sees it from the denials alone. One seat's
// denials of one rule, `count` of them within `minutes` and with no report in between, raise a `guard-thrash` attention item
// for the planner. The ledger is the run's own `guard.denied` events, so the hook process needs no state of its own.

export const GUARD_THRASH_REASON = 'guard-thrash'
export const DEFAULT_THRASH = { count: 3, minutes: 10 } as const
export type ThrashLimits = { count: number; minutes: number }

const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1

// `guardThrash` from config.json: a part that is not a whole number of at least 1 keeps its default.
export const thrashLimits = (value: unknown): ThrashLimits => {
  const { count, minutes } = (value && typeof value === 'object' ? value : {}) as { count?: unknown; minutes?: unknown }
  return { count: isWhole(count) ? count : DEFAULT_THRASH.count, minutes: isWhole(minutes) ? minutes : DEFAULT_THRASH.minutes }
}

export type Thrash = { seat: string; rule: GuardRule; count: number; minutes: number; last: string }

// What names a rule in an item's text: the item has no field for it, so the text carries it and this finds it again.
export const thrashMarker = (rule: GuardRule): string => `${rule} rule`

// What the roster says about the seat. It outlasts the ledger window: an item still held there is raised, and a report
// ingested but not yet in the ledger already ends the count.
export type SeatKnown = { attention?: readonly Attention[]; lastReportAt?: string }

const stampOf = (event: DroveEvent): number => Date.parse(event.at)

// Whether `seat` has just crossed the line for `rule`, given the run's recent events with its latest denial already among
// them. Only denials after the seat's last report count, and a rule is raised once per stretch between reports.
export const thrashOf = (events: readonly DroveEvent[], seat: string, rule: GuardRule, now: number, limits: ThrashLimits, known: SeatKnown = {}): Thrash | undefined => {
  const mine = events.filter(event => event.seat === seat)
  const reportedAt = known.lastReportAt === undefined ? 0 : Date.parse(known.lastReportAt) || 0
  const lastReport = mine.filter(event => event.type === 'report').reduce((latest, event) => Math.max(latest, stampOf(event) || 0), reportedAt)
  if ((known.attention ?? []).some(item => item.reason === GUARD_THRASH_REASON && item.detail.includes(thrashMarker(rule)))) return undefined
  const windowStart = now - limits.minutes * 60_000
  const denials = mine.filter(event => event.type === 'guard.denied' && event.data?.rule === rule && stampOf(event) >= windowStart && stampOf(event) > lastReport)
  if (denials.length < limits.count) return undefined
  const isRaised = mine.some(event => event.type === 'attention' && event.data?.reason === GUARD_THRASH_REASON && event.data?.rule === rule && stampOf(event) > lastReport)
  if (isRaised) return undefined
  return { seat, rule, count: denials.length, minutes: limits.minutes, last: String(denials.at(-1)?.data?.reason ?? '') }
}

export const thrashText = (thrash: Thrash): string =>
  `${thrash.seat} hit the guard's ${thrash.rule} rule ${thrash.count} times in ${thrash.minutes} minutes and has not reported since; last refusal: ${thrash.last}`
