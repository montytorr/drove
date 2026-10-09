import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as hooks from '../src/hooks.ts'
import { assertExports, assertStub } from './helpers.ts'

test('hooks exports its interface', () => {
  assertExports(hooks, ['detectAgent', 'parseHookInput', 'renderHookOutput', 'toRecord', 'recordHook', 'runHook'])
  assert.equal(hooks.DENY_EXIT_CODE, 2)
  assert.ok(hooks.HOOK_EVENTS.includes('pre-tool-use'))
})

test('hooks stubs throw until P2 lands', async () => {
  await assertStub(() => hooks.runHook('stop', '{}', {}), 'hooks.runHook')
})
