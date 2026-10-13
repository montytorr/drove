import { join } from 'node:path'
import { isAsking, isForHuman } from '../mod/hooks/roster.ts'
import type { OrchModStatus } from '../mod/types/index.d.ts'
import { runDir } from './paths.ts'
import { CLOSED_STATES, openSeats } from './roster.ts'
import { readJson, withLock, writeJsonAtomic } from './store.ts'
import type { Attention, AttentionAnswer, AttentionItem, AttentionKind, DroveEvent, PlannerState, Report, Roster, RunMeta, Seat } from './types.ts'

// DROVE-96: the things in a run that wait on a person, as one list. The board shows them as a red seat and the planner's
// wake carries them as "Needs the human" lines (watch.ts); this is the same set as data, for a poller outside the run.

export const PANE_BUDGET_REASON = 'pane-budget'
const TEXT_MAX = 1000
const PLANNER_GRACE_MS = 30_000

export type AttentionInput = {
  run: RunMeta
  roster: Roster
  // Each seat's latest report that is not a progress report.
  reports: readonly Report[]
  status: Readonly<Record<string, OrchModStatus>>
  events: readonly DroveEvent[]
  // What herdr says about the planner's own pane; left out when the run is down or herdr could not be asked.
  planner?: { state: PlannerState; detail?: string; reason?: Attention['reason'] }
  at: string
}

export type AttentionCandidate = { key: string; seat: string; kind: AttentionKind; text: string; since: string; answer: AttentionAnswer }

const clipText = (text: string, max = TEXT_MAX): string => {
  const flat = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const PANE_ANSWERS: ReadonlySet<Attention['reason']> = new Set(['dialog', 'permission', 'trust', 'hook-trust', 'channel-confirm', 'codex-version-mismatch'])

const seatAnswer = (run: string, seat: Seat, reason: Attention['reason']): AttentionAnswer => {
  if (reason === 'review-loop') return { type: 'pane', ...(seat.paneId ? { pane: seat.paneId } : {}), inspect: `drove capture ${seat.name} --run ${run}`, note: 'Re-scope the seat, promote it, or take it over with the planner.' }
  if (reason === 'gone') return { type: 'command', command: `drove up --run ${run} --seat ${seat.name}`, note: 'Relaunches the seat with resume.' }
  if (PANE_ANSWERS.has(reason)) {
    return { type: 'pane', ...(seat.paneId ? { pane: seat.paneId } : {}), inspect: `drove capture ${seat.name} --run ${run}`, note: 'Answer it in the pane. Drove never answers a dialog or an approval.' }
  }
  if (reason === 'usage-limit') {
    return { type: 'pane', ...(seat.paneId ? { pane: seat.paneId } : {}), inspect: `drove capture ${seat.name} --run ${run}`, note: 'The agent reached its plan limit and resumes when the limit resets, or the planner moves the seat to the other agent (drove migrate).' }
  }
  return { type: 'planner', note: 'The planner handles this; it reaches a person only when the planner asks.' }
}

const startOf = (seat: Seat, item: Attention, at: string): string => {
  const isEpisode = seat.state === 'blocked' || seat.state === 'needs-input' || seat.state === 'gone'
  const since = isEpisode ? seat.stateAt : item.at
  return Number.isNaN(Date.parse(since)) || since > at ? at : since
}

const forHumanCandidates = (input: AttentionInput): AttentionCandidate[] => {
  const { run, roster } = input
  return input.reports.flatMap(report => {
    const seat = roster.seats.find(entry => entry.name === report.seat)
    if (!seat || CLOSED_STATES.has(seat.state) || seat.state === 'closing' || report.for !== 'human' || seat.owes === 'none') return []
    // A done report is the planner's to review; a human is asked a question, a block or a promotion.
    const { kind } = report
    if (kind !== 'question' && kind !== 'blocked' && kind !== 'promote') return []
    const planner = run.planner.paneId
    return [{
      key: `${seat.name}:${kind}:${report.id}`,
      seat: seat.name,
      kind,
      text: clipText([report.summary, report.details ?? ''].filter(Boolean).join('\n')),
      since: report.at,
      answer: {
        type: 'command' as const,
        command: `drove send ${seat.name} --run ${run.id} --kind answer <answer>`,
        note: `Sends the answer to the worker; pass - to read it from stdin.${planner ? ` To route it through the planner instead: herdr agent prompt ${planner} <answer>.` : ''}`,
      },
    }]
  })
}

const askingCandidates = (input: AttentionInput): AttentionCandidate[] =>
  openSeats(input.roster).flatMap(seat => {
    const mine = input.status[seat.name]
    if (!mine?.asking || !isAsking(seat, mine)) return []
    const since = mine.at && !Number.isNaN(Date.parse(mine.at)) ? mine.at : seat.stateAt
    return [{
      key: `${seat.name}:asking`,
      seat: seat.name,
      kind: 'asking' as const,
      text: clipText(mine.asking),
      since,
      answer: { type: 'pane' as const, ...(seat.paneId ? { pane: seat.paneId } : {}), inspect: `drove capture ${seat.name} --run ${input.run.id}`, note: 'The worker is asking in its pane; answer it there.' },
    }]
  })

const seatCandidates = (input: AttentionInput, asking: ReadonlySet<string>): AttentionCandidate[] =>
  input.roster.seats
    .filter(seat => seat.state !== 'closed' && seat.state !== 'closing')
    .flatMap(seat =>
      seat.attention
        .filter(isForHuman)
        // The question the worker asks in its pane says more than the generic approval line, so it replaces it.
        .filter(item => !(item.reason === 'permission' && asking.has(seat.name)))
        .map(item => ({
          key: `${seat.name}:${item.reason}`,
          seat: seat.name,
          kind: item.reason,
          text: clipText(item.detail),
          since: startOf(seat, item, input.at),
          answer: seatAnswer(input.run.id, seat, item.reason),
        })),
    )

// A spawn the pane budget refused (commands.ts records the event). It stays a request until the budget is raised, a
// slot frees up or the seat starts anyway.
const budgetCandidates = (input: AttentionInput): AttentionCandidate[] => {
  const { run, roster } = input
  if (run.status !== 'up') return []
  const event = input.events.findLast(entry => entry.type === 'attention' && entry.data?.reason === PANE_BUDGET_REASON)
  if (!event) return []
  const wanted = Number(event.data?.wanted)
  const seat = event.seat ?? ''
  if (!Number.isInteger(wanted) || run.budget >= wanted || openSeats(roster).length < run.budget) return []
  if (openSeats(roster).some(entry => entry.name === seat)) return []
  return [{
    key: `${PANE_BUDGET_REASON}:${seat}`,
    seat: seat || 'planner',
    kind: 'pane-budget',
    text: clipText(typeof event.data?.detail === 'string' ? event.data.detail : `${seat} needs pane ${wanted}, over the budget of ${run.budget}`),
    since: event.at,
    answer: { type: 'command', command: `drove budget ${wanted} --run ${run.id}`, note: 'Raises the pane budget by one; only a person may run it.' },
  }]
}

const plannerCandidates = (input: AttentionInput): AttentionCandidate[] => {
  const { run, planner } = input
  if (!planner || run.status !== 'up') return []
  const pane = run.planner.paneId
  if (planner.state === 'blocked') {
    return [{
      key: 'planner:dialog',
      seat: 'planner',
      kind: planner.reason ?? 'dialog',
      text: clipText(planner.detail ?? 'The planner pane is waiting at a dialog or approval prompt; Drove will not answer it.'),
      since: input.at,
      answer: { type: 'pane', ...(pane ? { pane } : {}), ...(pane ? { inspect: `herdr pane read ${pane} --source visible --lines 40` } : {}), note: 'Answer it in the planner pane. Drove never answers a dialog or an approval.' },
    }]
  }
  if (planner.state === 'gone') {
    // The planner agent is recognised a moment after its process starts; a run that has only just come up is not gone.
    const upAt = Date.parse(input.events.findLast(event => event.type === 'run.up')?.at ?? '')
    if (!Number.isNaN(upAt) && Date.parse(input.at) - upAt < PLANNER_GRACE_MS) return []
    return [{
      key: 'planner:gone',
      seat: 'planner',
      kind: 'gone',
      text: `The planner pane${pane ? ` ${pane}` : ''} is gone while run ${run.id} is up.`,
      since: input.at,
      answer: { type: 'command', command: `drove up --run ${run.id} --detached`, note: 'Resumes the run in a workspace of its own: the planner session and the seats come back with resume.' },
    }]
  }
  return []
}

export const attentionCandidates = (input: AttentionInput): AttentionCandidate[] => {
  const asking = askingCandidates(input)
  const runBudget = input.events.find(event => event.type === 'attention' && event.data?.reason === 'run-budget')
  const runCandidates: AttentionCandidate[] = runBudget ? [{
    key: 'run-budget', seat: 'planner', kind: 'run-budget', text: clipText(String(runBudget.data?.detail ?? 'Run cost budget exceeded')), since: runBudget.at,
    answer: { type: 'pane', ...(input.run.planner.paneId ? { pane: input.run.planner.paneId } : {}), note: 'Re-scope the run or take it over with the planner.' },
  }] : []
  return [...runCandidates, ...plannerCandidates(input), ...asking, ...seatCandidates(input, new Set(asking.map(item => item.seat))), ...forHumanCandidates(input), ...budgetCandidates(input)]
}

// ---------- ids ----------

type LedgerEntry = { n: number; since: string; open: boolean }
type Ledger = { v: 1; entries: Record<string, LedgerEntry> }

export const ledgerPath = (home: string, run: string): string => join(runDir(home, run), 'attention.json')

// An item's id has to survive two things the run's own files do not: the derived attention lines are rewritten on every
// poll, and a poller runs as a new process each time. So the first sighting of an item is written down here, with the
// time it began; the id is the item's key and its episode number, and a key that went away and came back is a new episode.
export const settleItems = async (home: string, run: string, candidates: readonly AttentionCandidate[]): Promise<AttentionItem[]> => {
  const file = ledgerPath(home, run)
  return withLock(`${file}.lock`, async () => {
    const entries: Record<string, LedgerEntry> = { ...((await readJson<Ledger>(file))?.entries ?? {}) }
    let isChanged = false
    const present = new Set(candidates.map(candidate => candidate.key))
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.open && !present.has(key)) {
        entries[key] = { ...entry, open: false }
        isChanged = true
      }
    }
    const items = candidates.map((candidate): AttentionItem => {
      const known = entries[candidate.key]
      let entry = known
      if (!entry?.open) {
        entry = { n: (known?.n ?? 0) + 1, since: candidate.since, open: true }
        entries[candidate.key] = entry
        isChanged = true
      }
      return { id: `${run}:${candidate.key}:${entry.n}`, run, seat: candidate.seat, kind: candidate.kind, text: candidate.text, since: entry.since, answer: candidate.answer }
    })
    if (isChanged) await writeJsonAtomic(file, { v: 1, entries } satisfies Ledger)
    return items.sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id))
  })
}

// An item Drove knows is over (a seat respawned under the same name is no longer gone, DROVE-147) closes now, not at
// the next poll, so the ledger never holds it open past the change.
export const closeItems = async (home: string, run: string, keys: readonly string[]): Promise<void> => {
  const file = ledgerPath(home, run)
  if (!(await readJson<Ledger>(file))) return
  await withLock(`${file}.lock`, async () => {
    const entries: Record<string, LedgerEntry> = { ...((await readJson<Ledger>(file))?.entries ?? {}) }
    const open = keys.filter(key => entries[key]?.open)
    for (const key of open) entries[key] = { ...(entries[key] as LedgerEntry), open: false }
    if (open.length > 0) await writeJsonAtomic(file, { v: 1, entries } satisfies Ledger)
  })
}

// ---------- reading ----------

export const attentionLine = (item: AttentionItem): string => {
  const how = item.answer.type === 'command' ? item.answer.command : item.answer.type === 'pane' ? `answer in the pane${item.answer.pane ? ` ${item.answer.pane}` : ''}` : 'the planner handles it'
  return `${item.kind} · ${item.run} · ${item.seat} · since ${item.since}\n  ${item.text.split('\n')[0] ?? ''}\n  → ${how}`
}

// What a follower prints: an item that appeared, or one that is no longer open.
export type AttentionDelta = { v: 1; event: 'new' | 'resolved'; at: string; item: AttentionItem }

export const diffItems = (previous: ReadonlyMap<string, AttentionItem>, current: readonly AttentionItem[], at: string): AttentionDelta[] => {
  const now = new Set(current.map(item => item.id))
  return [
    ...[...previous.values()].filter(item => !now.has(item.id)).map((item): AttentionDelta => ({ v: 1, event: 'resolved', at, item })),
    ...current.filter(item => !previous.has(item.id)).map((item): AttentionDelta => ({ v: 1, event: 'new', at, item })),
  ]
}
