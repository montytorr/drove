import { test } from 'node:test'
import * as prompts from '../src/prompts.ts'
import { assertExports, assertStub } from './helpers.ts'

test('prompts exports its interface', () => {
  assertExports(prompts, ['plannerRole', 'workerRole', 'briefFooter', 'approvedText', 'nudgeText', 'resumedText'])
})

test('prompts stubs throw until P1 lands', async () => {
  await assertStub(() => prompts.briefFooter('w-api', 'DROVE-7'), 'prompts.briefFooter')
})
