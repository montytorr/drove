import { test } from 'node:test'
import * as herdr from '../src/herdr.ts'
import { assertExports, assertStub } from './helpers.ts'

test('herdr exports its interface', () => {
  assertExports(herdr, [
    'tabCreateArgv', 'paneSplitArgv', 'agentStartArgv', 'agentPromptArgv', 'agentReadArgv', 'paneCloseArgv', 'tabCloseArgv',
    'herdrError', 'parseAgents', 'parseAgent', 'parseNewPane', 'listAgents', 'getAgent', 'retryWhileBusy',
  ])
})

test('herdr stubs throw until P3 lands', async () => {
  await assertStub(() => herdr.paneCloseArgv('w1:p2'), 'herdr.paneCloseArgv')
})
