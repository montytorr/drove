import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as guard from '../src/guard.ts'
import { assertExports, assertStub } from './helpers.ts'

test('guard exports its interface', () => {
  assertExports(guard, ['decide', 'bashReason', 'isInside', 'denyText'])
  assert.ok(guard.EDIT_TOOLS.has('apply_patch'))
  assert.ok(guard.SHELL_TOOLS.has('Bash'))
})

test('guard stubs throw until P2 lands', async () => {
  await assertStub(
    () => guard.decide({ agent: 'claude', role: 'planner', tool: 'Bash', input: { command: 'ls' }, cwd: '/', writableRoots: [], openSeats: [] }),
    'guard.decide',
  )
})
