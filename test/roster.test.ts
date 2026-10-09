import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as roster from '../src/roster.ts'
import { assertExports, assertStub } from './helpers.ts'

test('roster exports its interface', () => {
  assertExports(roster, ['loadRun', 'saveRun', 'latestRunFor', 'loadRoster', 'updateRoster', 'openSeats', 'findSeat', 'upsertSeat', 'gridSlot', 'isOverBudget', 'rosterLines', 'attentionOf'])
  assert.ok(roster.CLOSED_STATES.has('closed'))
  assert.ok(!roster.CLOSED_STATES.has('working'))
})

test('roster stubs throw until P1 lands', async () => {
  await assertStub(() => roster.gridSlot([]), 'roster.gridSlot')
})
