import { test } from 'node:test'
import * as deliver from '../src/deliver.ts'
import { assertExports, assertStub } from './helpers.ts'

test('deliver exports its interface', () => {
  assertExports(deliver, ['codexQueueArgv', 'herdrPromptAdapter', 'codexQueueAdapter', 'registerAdapter', 'chooseAdapter', 'isDeliverable', 'deliverControl', 'flushPending', 'wakePlanner'])
})

test('deliver stubs throw until P3 lands', async () => {
  await assertStub(() => deliver.codexQueueArgv('thread', 'text'), 'deliver.codexQueueArgv')
})
