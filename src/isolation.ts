import { constants } from 'node:fs'
import { copyFile, lstat, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Exec } from './types.ts'

export type WorkerPorts = { base: number; stride: number }

export const PORT_MAX = 65535

// The lowest slot index no open seat holds, so a closed seat's slot is reused.
export const freeSlot = (used: Iterable<number | undefined>): number => {
  const taken = new Set([...used].filter((slot): slot is number => typeof slot === 'number'))
  let slot = 0
  while (taken.has(slot)) slot += 1
  return slot
}

export const portOf = (ports: WorkerPorts, slot: number): number => ports.base + slot * ports.stride

export const isPortInRange = (ports: WorkerPorts, slot: number): boolean => portOf(ports, slot) + ports.stride - 1 <= PORT_MAX

// What a seat's launch env gets from workerPorts: PORT is the seat's first port, DROVE_PORT_COUNT how many it owns.
export const portEnv = (ports: WorkerPorts | undefined, slot: number | undefined): Record<string, string> => {
  if (!ports || slot === undefined || !isPortInRange(ports, slot)) return {}
  const port = String(portOf(ports, slot))
  return { PORT: port, DROVE_PORT_BASE: port, DROVE_PORT_COUNT: String(ports.stride) }
}

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

// {seat}, {run}, {slot} and, with workerPorts, {port}; any other {name} is left as written and reported.
export const expandEnv = (env: Record<string, string>, vars: Record<string, string | undefined>): { env: Record<string, string>; unknown: string[] } => {
  const unknown = new Set<string>()
  const expanded = Object.fromEntries(
    Object.entries(env).map(([name, text]) => [
      name,
      text.replace(PLACEHOLDER_RE, (whole, key: string) => {
        const value = vars[key]
        if (value === undefined) {
          unknown.add(whole)
          return whole
        }
        return value
      }),
    ]),
  )
  return { env: expanded, unknown: [...unknown] }
}

// The env a seat launches with: workerEnv expanded, over the port variables, so an explicit PORT in workerEnv wins.
export const seatEnv = (
  workerEnv: Record<string, string>,
  ports: WorkerPorts | undefined,
  who: { run: string; seat: string; slot?: number },
): { env: Record<string, string>; unknown: string[] } => {
  const portVars = portEnv(ports, who.slot)
  const { env, unknown } = expandEnv(workerEnv, { seat: who.seat, run: who.run, slot: who.slot === undefined ? undefined : String(who.slot), port: portVars.PORT })
  return { env: { ...portVars, ...env }, unknown }
}

export type CopyPlan = { files: string[]; refused: string[] }

const isSafeGlob = (glob: string): boolean => glob.length > 0 && !glob.startsWith('/') && !glob.startsWith('~') && !glob.split('/').includes('..')

const listed = async (exec: Exec, repo: string, glob: string, onlyIgnored: boolean): Promise<string[]> => {
  const argv = ['git', '-C', repo, 'ls-files', '-o', '-z', ...(onlyIgnored ? ['-i', '--exclude-standard'] : []), '--', `:(glob)${glob}`]
  const ran = await exec(argv, { timeoutMs: 30_000 })
  return ran.code === 0 ? ran.stdout.split('\0').filter(Boolean) : []
}

// Which files of the main checkout workerCopy would copy: untracked files that match a glob and that git ignores. A match
// that is untracked but not ignored would show up in the worktree's `git status`, so it is refused, not copied.
export const planCopy = async (exec: Exec, repo: string, globs: readonly string[]): Promise<CopyPlan> => {
  const files = new Set<string>()
  const refused = new Set<string>()
  for (const glob of globs.map(entry => entry.trim().replace(/^(\.\/)+/, ''))) {
    if (!isSafeGlob(glob)) {
      refused.add(glob)
      continue
    }
    const [untracked, ignored] = await Promise.all([listed(exec, repo, glob, false), listed(exec, repo, glob, true)])
    const ignoredSet = new Set(ignored)
    ignored.forEach(file => files.add(file))
    untracked.filter(file => !ignoredSet.has(file)).forEach(file => refused.add(file))
  }
  return { files: [...files].sort(), refused: [...refused].sort() }
}

export type CopyResult = { copied: string[]; kept: string[]; failed: string[] }

// Never overwrites: a file the worktree already has is kept, whatever it holds.
export const applyCopy = async (repo: string, worktree: string, files: readonly string[]): Promise<CopyResult> => {
  const result: CopyResult = { copied: [], kept: [], failed: [] }
  for (const file of files) {
    const from = join(repo, file)
    const to = join(worktree, file)
    try {
      if (!(await lstat(from)).isFile()) {
        result.failed.push(file)
        continue
      }
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to, constants.COPYFILE_EXCL)
      result.copied.push(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') result.kept.push(file)
      else result.failed.push(file)
    }
  }
  return result
}

export const copyNotes = (plan: CopyPlan, result?: CopyResult): string[] => [
  ...(plan.refused.length > 0 ? [`workerCopy left out ${plan.refused.join(', ')}: ${plan.refused.length > 1 ? 'they are' : 'it is'} not ignored by git (or not a safe glob), so a copy would show up as an untracked change; add ${plan.refused.length > 1 ? 'them' : 'it'} to .gitignore to copy.`] : []),
  ...(result && result.copied.length > 0 ? [`Copied ${result.copied.join(', ')} from the main checkout into the worktree.`] : []),
  ...(result && result.kept.length > 0 ? [`Kept the worktree's own ${result.kept.join(', ')}.`] : []),
  ...(result && result.failed.length > 0 ? [`Could not copy ${result.failed.join(', ')}.`] : []),
]
