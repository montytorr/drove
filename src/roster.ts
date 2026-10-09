import type { Attention, Roster, RunMeta, Seat, SeatState } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: roster.${name}`)
}

export const CLOSED_STATES: ReadonlySet<SeatState> = new Set(['closed', 'gone', 'down'])

export const loadRun = async (home: string, run: string): Promise<RunMeta | undefined> => todo('loadRun')
export const saveRun = async (home: string, meta: RunMeta): Promise<void> => todo('saveRun')
export const latestRunFor = async (home: string, repo: string, status?: RunMeta['status']): Promise<RunMeta | undefined> => todo('latestRunFor')
export const loadRoster = async (home: string, run: string): Promise<Roster> => todo('loadRoster')
export const updateRoster = async (home: string, run: string, change: (roster: Roster) => Roster): Promise<Roster> => todo('updateRoster')
export const openSeats = (roster: Roster): Seat[] => todo('openSeats')
export const findSeat = (roster: Roster, name: string): Seat | undefined => todo('findSeat')
export const upsertSeat = (roster: Roster, seat: Seat): Roster => todo('upsertSeat')
export const gridSlot = (open: readonly Seat[]): { anchor: string; direction: 'right' | 'down' } | undefined => todo('gridSlot')
export const isOverBudget = (roster: Roster, budget: number): boolean => todo('isOverBudget')
export const rosterLines = (roster: Roster, now: Date): string[] => todo('rosterLines')
export const attentionOf = (roster: Roster): Attention[] => todo('attentionOf')
