import type { Identity } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: paths.${name}`)
}

export const ENV = {
  home: 'DROVE_HOME',
  run: 'DROVE_RUN',
  role: 'DROVE_ROLE',
  seat: 'DROVE_SEAT',
  token: 'DROVE_TOKEN',
} as const

export const SEAT_RE = /^[a-z][a-z0-9_-]{0,31}$/
export const PLANNER_SEAT = 'planner'

export const defaultHome = (env: NodeJS.ProcessEnv = process.env): string => todo('defaultHome')
export const newRunId = (repo: string, now: Date): string => todo('newRunId')
export const runDir = (home: string, run: string): string => todo('runDir')
export const seatDir = (home: string, run: string, seat: string): string => todo('seatDir')
export const plannerDir = (home: string, run: string): string => todo('plannerDir')
export const worktreePath = (repo: string, seat: string): string => todo('worktreePath')
export const branchName = (seat: string): string => todo('branchName')
export const identityFromEnv = (env: NodeJS.ProcessEnv = process.env): Identity | undefined => todo('identityFromEnv')
export const identityEnv = (identity: Identity): Record<string, string> => todo('identityEnv')
