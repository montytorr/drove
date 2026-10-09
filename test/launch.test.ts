import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as launch from '../src/launch.ts'
import { assertExports, assertStub } from './helpers.ts'

test('launch exports its interface', () => {
  assertExports(launch, ['claudeWorkerSpec', 'codexWorkerSpec', 'claudePlannerSpec', 'codexPlannerSpec', 'specFor', 'claudeSettings', 'claudeMcpConfig', 'tomlString', 'redactSpec', 'writeLaunchFiles'])
  assert.match(launch.CODEX_GUARDED_TOOLS, /apply_patch/)
})

test('launch stubs throw until P3 lands', async () => {
  await assertStub(() => launch.tomlString('x'), 'launch.tomlString')
})
