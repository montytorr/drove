import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runDir } from './paths.ts'
import { ensureHome, readJson, withLock, writeJsonAtomic } from './store.ts'
import type { Attention, Roster, RunMeta, Seat, SeatState } from './types.ts'

export const CLOSED_STATES: ReadonlySet<SeatState> = new Set(['closed', 'gone', 'down'])

const runFile = (home: string, run: string): string => join(runDir(home, run), 'run.json')
const rosterFile = (home: string, run: string): string => join(runDir(home, run), 'roster.json')
const rosterLock = (home: string, run: string): string => join(runDir(home, run), 'roster.lock')

export const shortModel = (model: string): string => {
  const match = /claude-([a-z]+)-(\d+)-(\d+)/.exec(model)
  if (!match) return model
  const family = match[1] ?? ''
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2]}.${match[3]}`
}

export const loadRun = async (home: string, run: string): Promise<RunMeta | undefined> => readJson<RunMeta>(runFile(home, run))

export const saveRun = async (home: string, meta: RunMeta): Promise<void> => {
  await ensureHome(home)
  await withLock(rosterLock(home, meta.id), () => writeJsonAtomic(runFile(home, meta.id), meta))
}

export const latestRunFor = async (home: string, repo: string, status?: RunMeta['status']): Promise<RunMeta | undefined> => {
  const names = await readdir(join(home, 'runs')).catch(() => [] as string[])
  const runs = await Promise.all(names.map(name => loadRun(home, name).catch(() => undefined)))
  return runs
    .filter((meta): meta is RunMeta => meta !== undefined && meta.repo === repo && (status === undefined || meta.status === status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}

const emptyRoster = (run: string): Roster => ({ v: 1, run, seats: [], updatedAt: new Date().toISOString() })

export const loadRoster = async (home: string, run: string): Promise<Roster> => (await readJson<Roster>(rosterFile(home, run))) ?? emptyRoster(run)

export const updateRoster = async (home: string, run: string, change: (roster: Roster) => Roster): Promise<Roster> => {
  await ensureHome(home)
  return withLock(rosterLock(home, run), async () => {
    const next = { ...change(await loadRoster(home, run)), updatedAt: new Date().toISOString() }
    await writeJsonAtomic(rosterFile(home, run), next)
    return next
  })
}

export const openSeats = (roster: Roster): Seat[] => roster.seats.filter(seat => !CLOSED_STATES.has(seat.state))

export const findSeat = (roster: Roster, name: string): Seat | undefined => roster.seats.find(seat => seat.name === name)

export const upsertSeat = (roster: Roster, seat: Seat): Roster => {
  const exists = roster.seats.some(entry => entry.name === seat.name)
  return { ...roster, seats: exists ? roster.seats.map(entry => (entry.name === seat.name ? seat : entry)) : [...roster.seats, seat] }
}

// Workers fill the tab as a grid: the 2nd beside the 1st, then each one under the worker two places before it.
export const gridSlot = (open: readonly Seat[]): { anchor: string; direction: 'right' | 'down' } | undefined => {
  const placed = open.filter(seat => seat.paneId).sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt))
  if (placed.length === 0) return undefined
  if (placed.length === 1) return { anchor: placed[0]?.paneId ?? '', direction: 'right' }
  const above = placed[placed.length - 2] ?? placed[placed.length - 1]
  return { anchor: above?.paneId ?? '', direction: 'down' }
}

export const isOverBudget = (roster: Roster, budget: number): boolean => openSeats(roster).length >= budget

const minutesSince = (iso: string, now: Date): number => Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000))

export const rosterLines = (roster: Roster, now: Date): string[] => {
  const listed = roster.seats.filter(seat => seat.state !== 'closed')
  if (listed.length === 0) return ['No seats are open.']
  return listed.map(seat => {
    const report = seat.lastReport
      ? ` · last report ${seat.lastReport.kind} ${minutesSince(seat.lastReport.at, now)}m ago: ${seat.lastReport.summary.slice(0, 120)}`
      : ''
    const owes = seat.owes === 'none' ? '' : ` · waiting for your ${seat.owes}`
    const attention = seat.attention.length > 0 ? ` · attention: ${seat.attention.map(item => item.reason).join(', ')}` : ''
    const cairn = seat.cairn ? ` · ${seat.cairn}` : ''
    const role = seat.role && seat.role !== 'implementer' ? ` · ${seat.role} of ${seat.target ?? '?'}` : ''
    return `- ${seat.name} [${seat.state}] ${seat.kind} ${shortModel(seat.model)} ${seat.effort}${cairn}${role} · pane ${seat.paneId ?? '?'} · up ${minutesSince(seat.spawnedAt, now)}m${report}${owes}${attention}`
  })
}

export const attentionOf = (roster: Roster): Attention[] => roster.seats.filter(seat => seat.state !== 'closed').flatMap(seat => seat.attention)
