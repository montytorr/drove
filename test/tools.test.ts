import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as tools from '../src/tools.ts'
import { assertExports, assertStub } from './helpers.ts'

test('tools exports its interface', () => {
  assertExports(tools, ['plannerTools', 'workerTools'])
  assert.deepEqual(tools.WORKER_TOOL_NAMES, ['report'])
  assert.ok(tools.PLANNER_TOOL_NAMES.includes('spawn'))
})

test('tools stubs throw until P4 lands', async () => {
  const deps = { exec: async () => ({ code: 0, stdout: '', stderr: '' }), clock: { now: () => new Date() }, home: '/tmp/drove-test' }
  await assertStub(() => tools.workerTools(deps, { home: deps.home, run: 'r', role: 'worker', seat: 'w-api' }), 'tools.workerTools')
})
