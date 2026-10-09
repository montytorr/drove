import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as mod from '../src/mod.ts'

const FACADE = [
  'ENV', 'attentionOf', 'briefFooter', 'capture', 'close', 'createWatcher', 'decide', 'defaultExpects', 'deliverControl', 'deriveState', 'down',
  'findSeat', 'formatControl', 'identityFromEnv', 'loadRoster', 'loadRun', 'macOf', 'openSeats', 'parseEnvelope', 'plannerRole', 'promote',
  'prompt', 'readNewReports', 'registerAdapter', 'renderReport', 'renderReports', 'rosterLines', 'saveRun', 'send', 'spawn', 'up',
  'updateRoster', 'verifyControl', 'workerRole',
]

test('the mod facade exports exactly the documented names', () => {
  assert.deepEqual(Object.keys(mod).sort(), [...FACADE].sort())
})
