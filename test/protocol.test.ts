import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as protocol from '../src/protocol.ts'
import { assertExports, assertStub } from './helpers.ts'

test('protocol exports its interface', () => {
  assertExports(protocol, ['defaultExpects', 'validateReport', 'stampReport', 'macOf', 'formatControl', 'parseEnvelope', 'verifyControl', 'replyLine', 'renderReport', 'renderReports'])
  assert.deepEqual(protocol.REPORT_KINDS, ['done', 'question', 'blocked', 'progress', 'promote'])
  assert.deepEqual(protocol.EXPECTS, ['review', 'answer', 'none'])
  assert.equal(protocol.ENVELOPE_OPEN, '⟦drove v1')
})

test('protocol stubs throw until P1 lands', async () => {
  await assertStub(() => protocol.defaultExpects('done'), 'protocol.defaultExpects')
})
