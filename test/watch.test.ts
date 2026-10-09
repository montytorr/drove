import { test } from 'node:test'
import * as watch from '../src/watch.ts'
import { assertExports, assertStub } from './helpers.ts'

test('watch exports its interface', () => {
  assertExports(watch, ['readNewReports', 'shouldWake', 'piggyback', 'createWatcher'])
})

test('watch stubs throw until P4 lands', async () => {
  await assertStub(
    () => watch.shouldWake({ v: 1, id: 'r-1', run: 'r', seat: 'w-api', token: 't', kind: 'progress', expects: 'none', summary: 's', at: '2026-10-09T00:00:00.000Z' }),
    'watch.shouldWake',
  )
})
