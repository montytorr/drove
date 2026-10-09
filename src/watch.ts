import type { Deps, Report, RunMeta } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: watch.${name}`)
}

export const TICK_MS = 3_000
export const HERDR_POLL_MS = 5_000
export const BATCH_MS = 2_000

export type Watcher = {
  tick: () => Promise<void>
  takePending: () => Promise<Report[]>
  stop: () => void
}

export const readNewReports = async (deps: Deps, run: RunMeta): Promise<Report[]> => todo('readNewReports')
export const shouldWake = (report: Report): boolean => todo('shouldWake')
export const piggyback = async (deps: Deps, run: RunMeta, text: string): Promise<string> => todo('piggyback')
export const createWatcher = (deps: Deps, run: RunMeta): Watcher => todo('createWatcher')
