import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as detect from '../src/detect.ts'
import { assertExports, assertStub } from './helpers.ts'

test('detect exports its interface', () => {
  assertExports(detect, ['matchDialog', 'deriveState', 'needsNudge'])
})

test('the Codex version-mismatch dialog has a pattern', () => {
  const screen = '⚠ Background server has incompatible feature settings. Restart it?'
  assert.equal(detect.DIALOGS.find(({ pattern }) => pattern.test(screen))?.reason, 'codex-version-mismatch')
})

test('detect stubs throw until P3 lands', async () => {
  await assertStub(() => detect.matchDialog('w-api', '', new Date()), 'detect.matchDialog')
})
