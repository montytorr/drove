import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Exec } from './types.ts'

// DROVE-147, DROVE-156: Claude Code 2.1.296 shows its folder-trust prompt unless `projects[<dir>].hasTrustDialogAccepted`
// is true in ~/.claude.json for the canonical git root, or for a directory from the cwd up to the cwd's own git root; the
// walk stops at the git root, so a trusted folder above the repo does not count. Drove launches Claude at the canonical
// root, so only that exact entry counts. Drove writes that one key only on a human's explicit yes (DROVE-166): drove
// trust, or the question drove plan and drove up ask on a terminal.

export type RepoTrust = { state: 'trusted' | 'untrusted' | 'unknown'; root: string; file: string }
export type TrustWrite = RepoTrust & { changed: boolean }

type ClaudeConfig = { projects?: Record<string, { hasTrustDialogAccepted?: unknown } | undefined> }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// The main checkout of the repo, as Claude keys it: a linked worktree is trusted through its main repo.
export const canonicalRoot = async (exec: Exec, repo: string): Promise<string> => {
  const common = await exec(['git', '-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: 10_000 }).catch(() => undefined)
  const gitDir = common?.code === 0 ? common.stdout.trim() : ''
  const dir = gitDir ? dirname(gitDir) : resolve(repo)
  return realpath(dir).catch(() => dir)
}

// A file Drove cannot read, or one without a projects map, says nothing: the start-time prompt check still covers it.
export const readRepoTrust = async (file: string, root: string): Promise<RepoTrust> => {
  const text = await readFile(file, 'utf8').catch(() => undefined)
  let parsed: unknown
  try {
    parsed = text === undefined ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const projects = isRecord(parsed) ? (parsed as ClaudeConfig).projects : undefined
  if (!isRecord(projects)) return { state: 'unknown', root, file }
  return { state: projects[root]?.hasTrustDialogAccepted === true ? 'trusted' : 'untrusted', root, file }
}

// Claude Code 2.1.296 saves the file under proper-lockfile's lock: a directory `<file>.lock` made with mkdir, stale once its
// mtime is 10s old, retried on ELOCKED after 200, 400, 800, 1600, 3200 and 4000ms, each times 1 + random.
export type LockTiming = { retryMs: readonly number[]; staleMs: number }
export const CLAUDE_LOCK: LockTiming = { retryMs: [200, 400, 800, 1600, 3200, 4000], staleMs: 10_000 }

// The entry Claude writes when its prompt is accepted in a folder it has no entry for: its project defaults (2.1.296).
const PROJECT_DEFAULTS = {
  allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

const takeLock = async (lock: string, timing: LockTiming): Promise<void> => {
  for (let tries = 0; ; ) {
    try {
      await mkdir(lock)
      return
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
    }
    const held = await stat(lock).catch(() => undefined)
    if (!held) continue
    if (Date.now() - held.mtimeMs > timing.staleMs) {
      await rmdir(lock).catch(() => undefined)
      continue
    }
    const wait = timing.retryMs[tries]
    if (wait === undefined) throw new Error(`${lock} is held by another process (most likely Claude Code saving its config), so nothing was written; try again in a moment`)
    tries += 1
    await pause(wait * (1 + Math.random()))
  }
}

const indentOf = (text: string): string | number => /^\{\r?\n([ \t]+)"/.exec(text)?.[1] ?? (text.includes('\n') ? 2 : 0)

// The write Claude makes when its folder-trust prompt is accepted: under its lock, re-read the file, set only
// projects[root].hasTrustDialogAccepted, write a temp file beside it with the same mode, rename it over, then read it
// back. Every other key keeps its value and its place. No copy of the file is made: it holds account data.
export const trustRepo = async (file: string, root: string, timing: LockTiming = CLAUDE_LOCK): Promise<TrustWrite> => {
  const target = await realpath(file).catch((error: unknown) => {
    throw new Error(codeOf(error) === 'ENOENT' ? `Claude Code has no config at ${file} yet: start claude once and sign in, then run drove trust again` : `cannot read ${file}: ${(error as Error).message}`)
  })
  const lock = `${file}.lock`
  await takeLock(lock, timing)
  let changed = false
  try {
    const text = await readFile(target, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`${file} is not valid JSON (${(error as Error).message}), so Drove will not write it`)
    }
    if (!isRecord(parsed)) throw new Error(`${file} does not hold a JSON object, so Drove will not write it`)
    if (parsed.projects !== undefined && !isRecord(parsed.projects)) throw new Error(`projects in ${file} is not an object, so Drove will not write it`)
    const projects = (parsed.projects ?? {}) as Record<string, unknown>
    const entry = projects[root]
    if (!(isRecord(entry) && entry.hasTrustDialogAccepted === true)) {
      projects[root] = { ...(isRecord(entry) ? entry : PROJECT_DEFAULTS), hasTrustDialogAccepted: true }
      parsed.projects = projects
      const mode = (await stat(target)).mode & 0o7777
      const temp = `${target}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`
      const handle = await open(temp, 'wx', mode)
      try {
        await handle.writeFile(`${JSON.stringify(parsed, null, indentOf(text))}${text.endsWith('\n') ? '\n' : ''}`, 'utf8')
        await handle.chmod(mode)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, target).catch(async (error: unknown) => {
        await unlink(temp).catch(() => undefined)
        throw error
      })
      changed = true
    }
  } finally {
    await rmdir(lock).catch(() => undefined)
  }
  const after = await readRepoTrust(file, root)
  if (after.state !== 'trusted') throw new Error(`${file} was written but does not read back as trusting ${root}`)
  return { ...after, changed }
}

export const trustQuestion = (root: string): string =>
  `Trust ${root} for Claude Code? This is what accepting its folder-trust prompt does. [y/N] `

export const trustFix = (root: string): string =>
  `run \`drove trust ${root}\` (in a Claude Code session: \`! drove trust ${root} --yes\`), which does what accepting the prompt does`

// Who stops at the prompt: a Claude worker (spawn, relaunch, promote, migrate), or a run's planner and workers (plan, up).
export type TrustScope = 'worker' | 'run'

export const untrustedText = (trust: RepoTrust, scope: TrustScope = 'worker'): string => {
  const who = scope === 'worker' ? 'a Claude worker' : 'a Claude planner or worker'
  const other = scope === 'worker' ? 'or spawn this worker as Codex (kind codex)' : 'or use Codex workers (kind codex)'
  return `Claude Code has not trusted ${trust.root} (projects["${trust.root}"].hasTrustDialogAccepted is not true in ${trust.file}), so ${who} launched there stops at its folder-trust prompt. Fix: ${trustFix(trust.root)}, ${other}. Drove only writes that key when you run drove trust or say yes to its question.`
}

// `after` says what happens once the prompt is answered; without it, the spawn case, whose brief waits for the worktree.
export const trustAttentionText = (root: string, paneId: string | undefined, after?: string): string => {
  const where = paneId ? `pane ${paneId}` : 'the pane'
  return after === undefined
    ? `Claude Code has not trusted ${root}: its folder-trust prompt is waiting in ${where}. Accept it in the pane, or ${trustFix(root)}. Drove holds the brief and delivers it once the prompt clears and the worktree is there.`
    : `Claude Code has not trusted ${root}: its folder-trust prompt is waiting in ${where}. Accept it in the pane (Claude reads trust only at startup, so a prompt on screen stays until it is answered); ${after} To skip the prompt next time, ${trustFix(root)}.`
}
