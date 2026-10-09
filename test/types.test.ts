import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Control, Report, Seat } from '../src/types.ts'

test('types is type-only and importable', async () => {
  const types = await import('../src/types.ts')
  assert.deepEqual(Object.keys(types), [])
  const report: Pick<Report, 'kind' | 'expects'> = { kind: 'done', expects: 'review' }
  const control: Pick<Control, 'from' | 'kind'> = { from: 'planner', kind: 'verdict' }
  const seat: Pick<Seat, 'state' | 'owes'> = { state: 'working', owes: 'none' }
  assert.ok(report && control && seat)
})
