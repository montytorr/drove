import { test } from 'node:test'
import * as store from '../src/store.ts'
import { assertExports, assertStub } from './helpers.ts'

test('store exports its interface', () => {
  assertExports(store, ['readJson', 'writeJsonAtomic', 'withLock', 'appendJsonl', 'readJsonlFrom', 'mintToken', 'writeToken', 'readToken'])
})

test('store stubs throw until P1 lands', async () => {
  await assertStub(() => store.mintToken(), 'store.mintToken')
})
