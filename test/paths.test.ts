import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as paths from '../src/paths.ts'
import { assertExports, assertStub } from './helpers.ts'

test('paths exports its interface', () => {
  assertExports(paths, ['defaultHome', 'newRunId', 'runDir', 'seatDir', 'plannerDir', 'worktreePath', 'branchName', 'identityFromEnv', 'identityEnv'])
  assert.deepEqual(Object.values(paths.ENV), ['DROVE_HOME', 'DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN'])
})

test('seat names follow the herdr agent-name rule', () => {
  assert.match('w-api', paths.SEAT_RE)
  assert.match(paths.PLANNER_SEAT, paths.SEAT_RE)
  assert.doesNotMatch('W-api', paths.SEAT_RE)
  assert.doesNotMatch('a'.repeat(33), paths.SEAT_RE)
})

test('paths stubs throw until P1 lands', async () => {
  await assertStub(() => paths.runDir('/h', 'r'), 'paths.runDir')
})
