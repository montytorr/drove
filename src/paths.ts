import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { Identity, Role, SeatRole } from './types.ts'

export const ENV = {
  home: 'DROVE_HOME',
  run: 'DROVE_RUN',
  role: 'DROVE_ROLE',
  seat: 'DROVE_SEAT',
  token: 'DROVE_TOKEN',
  owns: 'DROVE_OWNS',
  seatRole: 'DROVE_SEAT_ROLE',
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
// One Drove-owned CODEX_HOME per run (DROVE-34): its sessions stay with the run, and runs never rewrite each other's.
export const codexHomeDir = (home: string, run: string): string => join(runDir(home, run), 'codex-home')

// The user's own Codex home, read and linked from but never written. A CODEX_HOME that points into Drove's state is
// a Drove home inherited from a worker pane, not the user's.
export const userCodexHome = (home: string, env: NodeJS.ProcessEnv = process.env): string => {
  const set = env.CODEX_HOME
  return set && !resolve(set).startsWith(`${resolve(home)}/`) ? set : join(homedir(), '.codex')
}

export const worktreePath =(repo: string, seat: string): string => join(repo, '.claude', 'worktrees', seat)
export const branchName = (seat: string): string => `drove/${seat}`

// DROVE_OWNS is a JSON array of globs: a glob may hold commas, so no separator is safe. Unreadable means unset.
const ownsFromEnv = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') && parsed.length > 0 ? (parsed as string[]) : undefined
  } catch {
    return undefined
  }
}

// Only a reviewer or a tester is carried: a seat with no DROVE_SEAT_ROLE is an implementer, as before.
const seatRoleFromEnv = (value: string | undefined): SeatRole | undefined => (value === 'reviewer' || value === 'tester' ? value : undefined)

export const identityFromEnv = (env: NodeJS.ProcessEnv = process.env): Identity | undefined => {
  const run = env[ENV.run]
  const role = env[ENV.role]
  const seat = env[ENV.seat]
  if (!run || (role !== 'planner' && role !== 'worker') || !seat || !SEAT_RE.test(seat)) return undefined
  const token = env[ENV.token]
  const owns = ownsFromEnv(env[ENV.owns])
  const seatRole = seatRoleFromEnv(env[ENV.seatRole])
  return { home: defaultHome(env), run, role: role as Role, seat, ...(token ? { token } : {}), ...(owns ? { owns } : {}), ...(seatRole ? { seatRole } : {}) }
}

export const identityEnv = (identity: Identity): Record<string, string> => ({
  [ENV.home]: identity.home,
  [ENV.run]: identity.run,
  [ENV.role]: identity.role,
  [ENV.seat]: identity.seat,
  ...(identity.token ? { [ENV.token]: identity.token } : {}),
  ...(identity.owns && identity.owns.length > 0 ? { [ENV.owns]: JSON.stringify(identity.owns) } : {}),
  ...(identity.seatRole && identity.seatRole !== 'implementer' ? { [ENV.seatRole]: identity.seatRole } : {}),
})
