import type { Attention, Deps, DroveEvent, Roster, RunMeta } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: board.${name}`)
}

export const REFRESH_MS = 2_000

export type BoardFrame = { run: RunMeta; roster: Roster; events: readonly DroveEvent[]; attention: readonly Attention[]; now: Date; width: number }

export const renderBoard = (frame: BoardFrame): string => todo('renderBoard')
export const runBoard = async (deps: Deps, run: string, once: boolean): Promise<void> => todo('runBoard')
