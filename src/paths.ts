import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Identity, Role } from './types.ts'

export const ENV = {
  home: 'DROVE_HOME',
  run: 'DROVE_RUN',
  role: 'DROVE_ROLE',
  seat: 'DROVE_SEAT',
  token: 'DROVE_TOKEN',
} as const

export const SEAT_RE = /^[a-z][a-z0-9_-]{0,31}$/
export const PLANNER_SEAT = 'planner'

const pad = (value: number): string => String(value).padStart(2, '0')

export const defaultHome = (env: NodeJS.ProcessEnv = process.env): string => env[ENV.home] || join(homedir(), '.drove')

export const newRunId = (repo: string, now: Date): string => {
  const name = basename(repo).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`
  return `${name}-${day}-${time}-${randomBytes(2).toString('hex')}`
}

export const runDir = (home: string, run: string): string => join(home, 'runs', run)
export const seatDir = (home: string, run: string, seat: string): string => join(runDir(home, run), 'seats', seat)
export const plannerDir = (home: string, run: string): string => join(runDir(home, run), 'planner')
export const worktreePath = (repo: string, seat: string): string => join(repo, '.claude', 'worktrees', seat)
export const branchName = (seat: string): string => `drove/${seat}`

export const identityFromEnv = (env: NodeJS.ProcessEnv = process.env): Identity | undefined => {
  const run = env[ENV.run]
  const role = env[ENV.role]
  const seat = env[ENV.seat]
  if (!run || (role !== 'planner' && role !== 'worker') || !seat || !SEAT_RE.test(seat)) return undefined
  const token = env[ENV.token]
  return { home: defaultHome(env), run, role: role as Role, seat, ...(token ? { token } : {}) }
}

export const identityEnv = (identity: Identity): Record<string, string> => ({
  [ENV.home]: identity.home,
  [ENV.run]: identity.run,
  [ENV.role]: identity.role,
  [ENV.seat]: identity.seat,
  ...(identity.token ? { [ENV.token]: identity.token } : {}),
})
