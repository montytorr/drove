import { test } from 'node:test'
import * as commands from '../src/commands.ts'
import { assertExports, assertStub } from './helpers.ts'

test('commands exports its interface', () => {
  assertExports(commands, ['defaultDeps', 'identityOrPlanner', 'plan', 'spawn', 'send', 'prompt', 'promote', 'roster', 'capture', 'close', 'down', 'up', 'budget'])
})

test('commands stubs throw until P3 lands', async () => {
  await assertStub(() => commands.defaultDeps({}), 'commands.defaultDeps')
})
