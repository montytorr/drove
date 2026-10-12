import { realpath } from 'node:fs/promises'
import type { Exec, ExecResult } from './types.ts'

export const PROTECTED_BRANCH = 'production'

const git = (exec: Exec, repo: string, args: readonly string[]): Promise<ExecResult> => exec(['git', '-C', repo, ...args], { timeoutMs: 30_000 })
// One call to the remote (a push, a remote branch delete, a fetch). Past this it is cut, and the remote counts as away.
export const REMOTE_TIMEOUT_MS = 90_000

const must = async (exec: Exec, repo: string, args: readonly string[]): Promise<string> => {
  const result = await git(exec, repo, args)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`)
  return result.stdout.trim()
}

export const refExists = async (exec: Exec, repo: string, ref: string): Promise<boolean> => (await git(exec, repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0

export const hasRemote = async (exec: Exec, repo: string): Promise<boolean> => {
  const result = await git(exec, repo, ['remote'])
  return result.code === 0 && result.stdout.trim().length > 0
}

export const baseRef = async (exec: Exec, repo: string, base?: string): Promise<string> => {
  if (base) return base
  const candidates = (await hasRemote(exec, repo)) ? ['origin/main', 'origin/master', 'main', 'master'] : ['main', 'master']
  for (const candidate of candidates) if (await refExists(exec, repo, candidate)) return candidate
  throw new Error(`no base branch found in ${repo} (tried ${candidates.join(', ')})`)
}

export const addWorktree = async (exec: Exec, repo: string, path: string, branch: string, from: string): Promise<void> => {
  const isExisting = await refExists(exec, repo, `refs/heads/${branch}`)
  await must(exec, repo, isExisting ? ['worktree', 'add', path, branch] : ['worktree', 'add', '--no-track', '-b', branch, path, from])
}

// The commit a local branch points at, or undefined when it does not exist.
export const branchTip = async (exec: Exec, repo: string, branch: string): Promise<string | undefined> => {
  const result = await git(exec, repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  return result.code === 0 ? result.stdout.trim() || undefined : undefined
}

export const branchExists = (exec: Exec, repo: string, branch: string): Promise<boolean> => refExists(exec, repo, `refs/heads/${branch}`)

// A worktree holding changes that are not committed: the work of a seat that has not been approved yet.
export const hasUncommitted = async (exec: Exec, worktree: string): Promise<boolean> => {
  const status = await git(exec, worktree, ['status', '--porcelain'])
  return status.code === 0 && status.stdout.trim().length > 0
}

export const deleteBranch = async (exec: Exec, repo: string, branch: string): Promise<boolean> => (await git(exec, repo, ['branch', '-d', branch])).code === 0

export const toplevel = async (exec: Exec, dir: string): Promise<string | undefined> => {
  const result = await git(exec, dir, ['rev-parse', '--show-toplevel'])
  return result.code === 0 ? result.stdout.trim() || undefined : undefined
}

export const removeWorktree = async (exec: Exec, repo: string, path: string, force = false): Promise<void> => {
  if (force) {
    await must(exec, repo, ['worktree', 'remove', '--force', '--force', path])
    return
  }
  const removed = await git(exec, repo, ['worktree', 'remove', path])
  if (removed.code === 0) return
  if (!/locked/i.test(removed.stderr)) throw new Error(`git worktree remove ${path} failed: ${(removed.stderr || removed.stdout).trim().slice(0, 300)}`)
  await must(exec, repo, ['worktree', 'unlock', path])
  await must(exec, repo, ['worktree', 'remove', path])
}

const CLAUDE_LOCK_REASON = /^claude (?:agent|session) .{1,255} \(pid (\d{1,10})(?: start .{1,255})?\)$/

export type WorktreeLock = { reason: string; claudePid?: number }

const realOrSame = (path: string): Promise<string> => realpath(path).catch(() => path)

export const worktreeLock = async (exec: Exec, repo: string, path: string): Promise<WorktreeLock | undefined> => {
  const listed = await git(exec, repo, ['worktree', 'list', '--porcelain'])
  if (listed.code !== 0) return undefined
  const target = await realOrSame(path)
  for (const block of listed.stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n')
    const entry = lines.find(line => line.startsWith('worktree '))
    if (!entry || (await realOrSame(entry.slice('worktree '.length).trim())) !== target) continue
    const locked = lines.find(line => line === 'locked' || line.startsWith('locked '))
    if (locked === undefined) return undefined
    const reason = locked.slice('locked'.length).trim()
    const pid = CLAUDE_LOCK_REASON.exec(reason)?.[1]
    return { reason, ...(pid ? { claudePid: Number(pid) } : {}) }
  }
  return undefined
}

export const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export const unlockWorktree = async (exec: Exec, repo: string, path: string): Promise<void> => {
  await must(exec, repo, ['worktree', 'unlock', path])
}

export const claudeBranchName =(seat: string): string => `worktree-${seat}`

export const headBranch = async (exec: Exec, repo: string): Promise<string | undefined> => {
  const result = await git(exec, repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return result.code === 0 ? result.stdout.trim() || undefined : undefined
}

export const isHeadAt = async (exec: Exec, repo: string, ref: string): Promise<boolean> => {
  const [head, target] = await Promise.all([git(exec, repo, ['rev-parse', 'HEAD']), git(exec, repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])])
  return head.code === 0 && target.code === 0 && head.stdout.trim() === target.stdout.trim()
}

export const isMerged = async (exec: Exec, repo: string, branch: string, into: string): Promise<boolean> =>
  (await git(exec, repo, ['merge-base', '--is-ancestor', branch, into])).code === 0

export const commonGitDir = async (exec: Exec, repo: string): Promise<string> => must(exec, repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])

export type FreshestBase = { ref: string; ahead?: boolean; note?: string }

// A remote-tracking base such as origin/main goes stale as soon as the local branch is committed to and not pushed.
// Use the local counterpart when it contains the remote one; fall back to the remote, with a note, when they diverged.
export const freshestBase = async (exec: Exec, repo: string, base: string): Promise<FreshestBase> => {
  const slash = base.indexOf('/')
  if (slash <= 0 || !(await refExists(exec, repo, `refs/remotes/${base}`))) return { ref: base }
  const localName = base.slice(slash + 1)
  const local = `refs/heads/${localName}`
  if (!(await refExists(exec, repo, local))) return { ref: base }
  if ((await git(exec, repo, ['merge-base', '--is-ancestor', base, local])).code === 0) {
    const [localTip, baseTip] = await Promise.all([git(exec, repo, ['rev-parse', local]), git(exec, repo, ['rev-parse', `refs/remotes/${base}`])])
    return { ref: localName, ahead: localTip.stdout.trim() !== baseTip.stdout.trim() }
  }
  if ((await git(exec, repo, ['merge-base', '--is-ancestor', local, base])).code === 0) return { ref: base }
  return { ref: base, note: `local ${localName} and ${base} have diverged, so ${base} was used as the base; commits on local ${localName} are not in the worker's worktree.` }
}

export type FastForward =
  | { outcome: 'at-base'; head: string }
  | { outcome: 'fast-forwarded'; from: string; to: string }
  | { outcome: 'diverged'; head: string }
  | { outcome: 'failed'; head: string; error: string }

// A worktree whose HEAD is behind `base` is moved up to it; one already at `base`, or not an ancestor of it, is left.
export const fastForwardToBase = async (exec: Exec, worktree: string, base: string): Promise<FastForward> => {
  const short = async (ref: string): Promise<string> => (await git(exec, worktree, ['rev-parse', '--short', ref])).stdout.trim() || ref
  const head = await short('HEAD')
  if (await isHeadAt(exec, worktree, base)) return { outcome: 'at-base', head }
  if (!(await isMerged(exec, worktree, 'HEAD', base))) return { outcome: 'diverged', head }
  const merged = await git(exec, worktree, ['merge', '--ff-only', base])
  if (merged.code !== 0) return { outcome: 'failed', head, error: (merged.stderr || merged.stdout).trim().slice(0, 300) }
  return { outcome: 'fast-forwarded', from: head, to: await short('HEAD') }
}

// Uncommitted work in a checkout, as `git status --porcelain` lines. Untracked files under .claude/ (worktrees, session
// files) are not the project's, so they do not count.
export const dirtyLines = async (exec: Exec, dir: string): Promise<string[]> => {
  const result = await git(exec, dir, ['status', '--porcelain'])
  if (result.code !== 0) throw new Error(`git status failed in ${dir}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`)
  return result.stdout.split('\n').filter(line => line.trim() !== '' && !/^\?\? \.claude(\/|$)/.test(line))
}

export const commitSubject = async (exec: Exec, repo: string, ref: string): Promise<string> => must(exec, repo, ['log', '-1', '--format=%s', ref])

// The subjects of the commits on `branch` that `base` does not have, oldest first.
export const commitSubjects = async (exec: Exec, repo: string, base: string, branch: string): Promise<string[]> =>
  (await must(exec, repo, ['log', '--reverse', '--format=%s', `${base}..${branch}`])).split('\n').filter(Boolean)

export const shortSha = async (exec: Exec, repo: string, ref: string): Promise<string> => must(exec, repo, ['rev-parse', '--short', ref])

export type MergeOutcome = { ok: true; sha: string } | { ok: false; output: string }

// A merge commit, always: the branch's commits stay visible in history. A conflicted merge is aborted so the checkout is left as found.
export const mergeNoFf = async (exec: Exec, repo: string, branch: string, message: string): Promise<MergeOutcome> => {
  const merged = await git(exec, repo, ['merge', '--no-ff', '-m', message, branch])
  if (merged.code === 0) return { ok: true, sha: await shortSha(exec, repo, 'HEAD') }
  await git(exec, repo, ['merge', '--abort'])
  return { ok: false, output: (merged.stdout + merged.stderr).trim() }
}

// Pushes `branch` to the same name on `remote`: explicit refspec, no upstream set, never forced. With `sha`, that exact
// commit is what the remote branch becomes, whatever the local branch has moved to since.
export const pushBranch = async (exec: Exec, repo: string, remote: string, branch: string, sha?: string): Promise<ExecResult> => {
  if (branch === PROTECTED_BRANCH) return { code: 1, stdout: '', stderr: `refusing to push the ${PROTECTED_BRANCH} branch` }
  return exec(['git', '-C', repo, 'push', remote, `${sha ?? `refs/heads/${branch}`}:refs/heads/${branch}`], { timeoutMs: REMOTE_TIMEOUT_MS })
}

export const deleteRemoteBranch = async (exec: Exec, repo: string, remote: string, branch: string): Promise<ExecResult> => {
  if (branch === PROTECTED_BRANCH) return { code: 1, stdout: '', stderr: `refusing to delete the ${PROTECTED_BRANCH} branch` }
  return exec(['git', '-C', repo, 'push', remote, '--delete', branch], { timeoutMs: REMOTE_TIMEOUT_MS })
}

// Brings the local base up to date with the remote's after a PR merged on GitHub: fetch, then fast-forward only.
export const fastForwardFromRemote = async (exec: Exec, repo: string, remote: string, base: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }> => {
  const fetched = await exec(['git', '-C', repo, 'fetch', remote, base], { timeoutMs: REMOTE_TIMEOUT_MS })
  if (fetched.code !== 0) return { ok: false, error: (fetched.stderr || fetched.stdout).trim().slice(0, 300) }
  const merged = await git(exec, repo, ['merge', '--ff-only', `${remote}/${base}`])
  if (merged.code !== 0) return { ok: false, error: (merged.stderr || merged.stdout).trim().slice(0, 300) }
  return { ok: true, sha: await shortSha(exec, repo, 'HEAD') }
}
