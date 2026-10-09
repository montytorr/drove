import type { Exec, ExecResult } from './types.ts'

export const PROTECTED_BRANCH = 'production'

const git = (exec: Exec, repo: string, args: readonly string[]): Promise<ExecResult> => exec(['git', '-C', repo, ...args], { timeoutMs: 30_000 })

const must = async (exec: Exec, repo: string, args: readonly string[]): Promise<string> => {
  const result = await git(exec, repo, args)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`)
  return result.stdout.trim()
}

const refExists = async (exec: Exec, repo: string, ref: string): Promise<boolean> => (await git(exec, repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0

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

export const claudeBranchName = (seat: string): string => `worktree-${seat}`

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
