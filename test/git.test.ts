import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as git from '../src/git.ts'
import { assertExports, assertStub } from './helpers.ts'

test('git exports its interface', () => {
  assertExports(git, ['hasRemote', 'baseRef', 'addWorktree', 'removeWorktree', 'isMerged', 'commonGitDir'])
  assert.equal(git.PROTECTED_BRANCH, 'production')
})

test('git stubs throw until P3 lands', async () => {
  await assertStub(() => git.hasRemote(async () => ({ code: 0, stdout: '', stderr: '' }), '/repo'), 'git.hasRemote')
})
