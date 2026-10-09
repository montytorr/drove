import { test } from 'node:test'
import * as shell from '../src/shell.ts'
import { assertExports, assertStub } from './helpers.ts'

test('shell exports its interface', () => {
  assertExports(shell, ['parseShell', 'unwrap', 'baseName'])
})

test('shell stubs throw until P2 lands', async () => {
  await assertStub(() => shell.parseShell('echo hi'), 'shell.parseShell')
})
