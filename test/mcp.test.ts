import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as mcp from '../src/mcp.ts'
import { assertExports, assertStub } from './helpers.ts'

test('mcp exports its interface', () => {
  assertExports(mcp, ['handleMessage', 'notify', 'serveMcp'])
  assert.equal(mcp.SERVER_NAME, 'drove')
})

test('mcp stubs throw until P4 lands', async () => {
  await assertStub(() => mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, []), 'mcp.handleMessage')
})
