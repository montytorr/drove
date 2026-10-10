import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { nodeExec } from '../src/commands.ts'
import * as drovegit from '../src/git.ts'
import { git, makeRepo, tmp } from './p3-helpers.ts'

const upstreamOf = (repo: string, branch: string): Promise<string> => git(repo, 'for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`)

const addRemote = async (repo: string): Promise<string> => {
  const bare = await tmp('origin')
  await git(bare, 'init', '-q', '--bare', '-b', 'main')
  await git(repo, 'remote', 'add', 'origin', bare)
  await git(repo, 'push', '-q', 'origin', 'main')
  await git(repo, 'fetch', '-q', 'origin')
  return bare
}

test('without a remote the base is main and the worktree branch is untracked', async () => {
  const repo = await makeRepo()
  assert.equal(await drovegit.hasRemote(nodeExec, repo), false)
  assert.equal(await drovegit.baseRef(nodeExec, repo), 'main')
  const path = join(repo, '.claude', 'worktrees', 'w-api')
  await drovegit.addWorktree(nodeExec, repo, path, 'drove/w-api', 'main')
  assert.ok(existsSync(join(path, 'README.md')))
  assert.equal(await git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'drove/w-api')
  assert.equal(await upstreamOf(repo, 'drove/w-api'), '')
})

test('with a remote the base is origin/main and the branch starts there with no upstream', async () => {
  const repo = await makeRepo()
  await addRemote(repo)
  assert.equal(await drovegit.hasRemote(nodeExec, repo), true)
  assert.equal(await drovegit.baseRef(nodeExec, repo), 'origin/main')
  await writeFile(join(repo, 'local.txt'), 'only local\n')
  await git(repo, 'add', 'local.txt')
  await git(repo, 'commit', '-q', '-m', 'local only')
  const path = join(repo, '.claude', 'worktrees', 'w-ui')
  await drovegit.addWorktree(nodeExec, repo, path, 'drove/w-ui', await drovegit.baseRef(nodeExec, repo))
  assert.equal(await git(path, 'rev-parse', 'HEAD'), await git(repo, 'rev-parse', 'origin/main'))
  assert.notEqual(await git(path, 'rev-parse', 'HEAD'), await git(repo, 'rev-parse', 'main'))
  assert.equal(await upstreamOf(repo, 'drove/w-ui'), '')
})

test('an explicit base wins, and a master-only repo falls back to master', async () => {
  const repo = await makeRepo()
  assert.equal(await drovegit.baseRef(nodeExec, repo, 'release'), 'release')
  await git(repo, 'branch', '-m', 'main', 'master')
  assert.equal(await drovegit.baseRef(nodeExec, repo), 'master')
})

test('baseRef fails clearly when there is no main or master', async () => {
  const repo = await makeRepo()
  await git(repo, 'branch', '-m', 'main', 'trunk')
  await assert.rejects(drovegit.baseRef(nodeExec, repo), /no base branch found/)
})

test('addWorktree reuses an existing branch instead of failing', async () => {
  const repo = await makeRepo()
  const first = join(repo, '.claude', 'worktrees', 'w-a')
  await drovegit.addWorktree(nodeExec, repo, first, 'drove/w-a', 'main')
  await drovegit.removeWorktree(nodeExec, repo, first)
  assert.equal(existsSync(first), false)
  await drovegit.addWorktree(nodeExec, repo, first, 'drove/w-a', 'main')
  assert.ok(existsSync(first))
})

test('isMerged is false until the branch is merged; removeWorktree then works', async () => {
  const repo = await makeRepo()
  const path = join(repo, '.claude', 'worktrees', 'w-m')
  await drovegit.addWorktree(nodeExec, repo, path, 'drove/w-m', 'main')
  await writeFile(join(path, 'new.txt'), 'x\n')
  await git(path, 'add', 'new.txt')
  await git(path, 'commit', '-q', '-m', 'work')
  assert.equal(await drovegit.isMerged(nodeExec, repo, 'drove/w-m', 'main'), false)
  await assert.rejects(drovegit.removeWorktree(nodeExec, repo, join(repo, 'nope')), /git worktree remove/)
  await git(repo, 'merge', '--no-ff', '-q', '-m', 'merge', 'drove/w-m')
  assert.equal(await drovegit.isMerged(nodeExec, repo, 'drove/w-m', 'main'), true)
  await drovegit.removeWorktree(nodeExec, repo, path)
  assert.equal(existsSync(path), false)
  assert.equal(await drovegit.deleteBranch(nodeExec, repo, 'drove/w-m'), true)
})

test('commonGitDir and toplevel resolve from inside a worktree', async () => {
  const repo = await makeRepo()
  const path = join(repo, '.claude', 'worktrees', 'w-c')
  await drovegit.addWorktree(nodeExec, repo, path, 'drove/w-c', 'main')
  const common = await drovegit.commonGitDir(nodeExec, path)
  assert.equal(common.endsWith('/.git'), true)
  assert.equal(await drovegit.toplevel(nodeExec, join(path, '.')), (await drovegit.toplevel(nodeExec, path)) ?? '')
  assert.equal(await drovegit.toplevel(nodeExec, await tmp('notgit')), undefined)
})

test('claude worktrees: branch name, HEAD checks, and a locked worktree is unlocked before a plain remove', async () => {
  const repo = await makeRepo()
  assert.equal(drovegit.claudeBranchName('w-api'), 'worktree-w-api')
  assert.equal(await drovegit.headBranch(nodeExec, repo), 'main')
  assert.equal(await drovegit.isHeadAt(nodeExec, repo, 'main'), true)
  await git(repo, 'switch', '-q', '-c', 'side', '--no-track')
  await writeFile(join(repo, 'b.txt'), 'x\n')
  await git(repo, 'add', 'b.txt')
  await git(repo, 'commit', '-q', '-m', 'side')
  assert.equal(await drovegit.isHeadAt(nodeExec, repo, 'main'), false)
  assert.equal(await drovegit.isHeadAt(nodeExec, repo, 'nope'), false)

  const path = join(repo, '.claude', 'worktrees', 'w-lock')
  await git(repo, 'worktree', 'add', '--no-track', '-b', 'worktree-w-lock', path, 'HEAD')
  await git(repo, 'worktree', 'lock', path)
  await drovegit.removeWorktree(nodeExec, repo, path)
  assert.equal(existsSync(path), false)

  const dirty = join(repo, '.claude', 'worktrees', 'w-dirty')
  await git(repo, 'worktree', 'add', '--no-track', '-b', 'worktree-w-dirty', dirty, 'HEAD')
  await writeFile(join(dirty, 'untracked-change.txt'), 'x\n')
  await git(dirty, 'add', 'untracked-change.txt')
  await assert.rejects(drovegit.removeWorktree(nodeExec, repo, dirty), /git worktree remove/)
  await drovegit.removeWorktree(nodeExec, repo, dirty, true)
  assert.equal(existsSync(dirty), false)
})

test('worktreeLock reads the lock reason, and only a Claude-shaped reason carries a pid', async () => {
  const repo = await makeRepo()
  const path = join(repo, '.claude', 'worktrees', 'w-lock')
  await git(repo, 'worktree', 'add', '--no-track', '-b', 'worktree-w-lock', path, 'HEAD')
  assert.equal(await drovegit.worktreeLock(nodeExec, repo, path), undefined)
  assert.equal(await drovegit.worktreeLock(nodeExec, repo, join(repo, 'nowhere')), undefined)

  const reason = 'claude session w-lock (pid 4242 start Sat Oct 10 06:32:48 2026)'
  await git(repo, 'worktree', 'lock', '--reason', reason, path)
  assert.deepEqual(await drovegit.worktreeLock(nodeExec, repo, path), { reason, claudePid: 4242 })
  await drovegit.unlockWorktree(nodeExec, repo, path)
  assert.equal(await drovegit.worktreeLock(nodeExec, repo, path), undefined)

  await git(repo, 'worktree', 'lock', '--reason', 'pid 4242 by hand', path)
  assert.deepEqual(await drovegit.worktreeLock(nodeExec, repo, path), { reason: 'pid 4242 by hand' })
  await drovegit.unlockWorktree(nodeExec, repo, path)
  await git(repo, 'worktree', 'lock', path)
  assert.deepEqual(await drovegit.worktreeLock(nodeExec, repo, path), { reason: '' })
})

test('isPidAlive is true for this process and false for an exited one', () => {
  assert.equal(drovegit.isPidAlive(process.pid), true)
  const exited = spawnSync(process.execPath, ['-e', ''])
  assert.equal(drovegit.isPidAlive(exited.pid), false)
})
