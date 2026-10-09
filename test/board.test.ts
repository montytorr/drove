import { test } from 'node:test'
import * as board from '../src/board.ts'
import { assertExports, assertStub } from './helpers.ts'

test('board exports its interface', () => {
  assertExports(board, ['renderBoard', 'runBoard'])
})

test('board stubs throw until P5 lands', async () => {
  await assertStub(() => board.runBoard({ exec: async () => ({ code: 0, stdout: '', stderr: '' }), clock: { now: () => new Date() }, home: '/tmp' }, 'r', true), 'board.runBoard')
})
