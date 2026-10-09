import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as detect from '../src/detect.ts'
import type { HerdrAgent, HookRecord, LastReport, Seat } from '../src/types.ts'
import { makeSeat } from './p3-helpers.ts'

const NOW = new Date('2026-10-09T10:00:00.000Z')
const ago = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString()
const hook = (event: HookRecord['event'], seconds: number, detail?: string): HookRecord => ({ at: ago(seconds), agent: 'claude', event, ...(detail ? { detail } : {}) })
const live = (status: HerdrAgent['status']): HerdrAgent => ({ paneId: 'w1:p1', status })
const report = (kind: LastReport['kind'], expects: LastReport['expects'], seconds: number, id = 'r-1'): LastReport => ({ id, kind, expects, summary: 's', at: ago(seconds) })
const seatOf = (overrides: Partial<Seat> = {}): Seat => makeSeat('w-api', { state: 'working', stateAt: ago(60), ...overrides })

test('the Codex version-mismatch dialog becomes a codex-version-mismatch attention item', () => {
  const screen = '\n⚠ Background server has incompatible feature settings\n  press enter to continue'
  const hit = detect.matchDialog('w-api', screen, NOW)
  assert.equal(hit?.reason, 'codex-version-mismatch')
  assert.match(hit?.detail ?? '', /align them/)
  assert.match(hit?.detail ?? '', /will not answer/)
  assert.equal(hit?.seat, 'w-api')
})

test('dialog table: folder trust, hook trust, channel confirm, and no match', () => {
  assert.equal(detect.matchDialog('s', 'Do you trust this folder?', NOW)?.reason, 'trust')
  assert.equal(detect.matchDialog('s', 'Do you trust the files in this folder?', NOW)?.reason, 'trust')
  assert.equal(detect.matchDialog('s', 'Quick safety check: Is this a project you created or one you trust?', NOW)?.reason, 'trust')
  assert.equal(detect.findDialog('Do you trust the files in this folder?')?.hint, 'Claude is asking to trust the folder')
  assert.equal(detect.matchDialog('s', '2 hooks need trust before they run', NOW)?.reason, 'hook-trust')
  assert.equal(detect.matchDialog('s', 'Loading development channels', NOW)?.reason, 'channel-confirm')
  assert.equal(detect.matchDialog('s', '1 hook needs review before it can run.', NOW)?.reason, 'hook-trust')
  assert.equal(detect.matchDialog('s', 'Hooks need review\n2 hooks are new or changed.', NOW)?.reason, 'hook-trust')
  assert.equal(detect.findDialog('1 hook needs review before it can run')?.hint, "approve Drove's hooks once in the pane; Codex remembers them")
  assert.equal(detect.matchDialog('s', 'Update available! Update now (runs `npm i -g @openai/codex`)', NOW)?.reason, 'dialog')
  assert.equal(detect.matchDialog('s', 'Codex just got an upgrade. Introducing gpt-x.', NOW)?.reason, 'dialog')
  assert.equal(detect.matchDialog('s', 'Do you trust the contents of this directory?', NOW)?.reason, 'trust')
  assert.equal(detect.matchDialog('s', 'just a normal prompt', NOW), undefined)
})

test('a blocked pane with the mismatch dialog on screen is blocked with that attention item', () => {
  const derived = detect.deriveState(seatOf(), { herdr: live('blocked'), hooks: [], screen: 'Background server has incompatible feature settings' }, NOW)
  assert.equal(derived.state, 'blocked')
  assert.deepEqual(derived.attention.map(item => item.reason), ['codex-version-mismatch'])
})

test('a blocked pane with no recognised dialog raises a generic dialog item', () => {
  const derived = detect.deriveState(seatOf(), { herdr: live('blocked'), hooks: [], screen: 'Allow this command? (y/n)' }, NOW)
  assert.equal(derived.state, 'blocked')
  assert.equal(derived.attention[0]?.reason, 'dialog')
})

test('a dialog on screen blocks the seat even when herdr is not blocked yet', () => {
  const derived = detect.deriveState(seatOf({ state: 'starting' }), { herdr: live('unknown'), hooks: [], screen: 'trust this folder' }, NOW)
  assert.equal(derived.state, 'blocked')
  assert.equal(derived.attention[0]?.reason, 'trust')
})

test('precedence: a hook permission request beats herdr blocked, which beats working', () => {
  const ask = [hook('permission-request', 2, 'shell: rm x')]
  const asked = detect.deriveState(seatOf(), { herdr: live('blocked'), hooks: ask }, NOW)
  assert.equal(asked.state, 'needs-input')
  assert.match(asked.attention[0]?.detail ?? '', /shell: rm x/)
  const blocked = detect.deriveState(seatOf(), { herdr: live('blocked'), hooks: [hook('user-prompt-submit', 2)] }, NOW)
  assert.equal(blocked.state, 'blocked')
})

test('a later stop or prompt clears a permission request', () => {
  const cleared = detect.deriveState(seatOf(), { herdr: live('idle'), hooks: [hook('permission-request', 30), hook('stop', 10)] }, NOW)
  assert.equal(cleared.state, 'idle')
})

test('a stale permission request does not hold the seat once herdr says working', () => {
  const stale = detect.deriveState(seatOf(), { herdr: live('working'), hooks: [hook('permission-request', 120)] }, NOW)
  assert.equal(stale.state, 'working')
})

test('Claude notifications count as needs-input only for permission-like types', () => {
  assert.equal(detect.deriveState(seatOf(), { herdr: live('idle'), hooks: [hook('notification', 3, 'permission_prompt')] }, NOW).state, 'needs-input')
  assert.equal(detect.deriveState(seatOf(), { herdr: live('idle'), hooks: [hook('notification', 3, 'idle_prompt')] }, NOW).state, 'idle')
})

test('a seat that reported and is owed an answer is not working on herdr lag alone', () => {
  const seat = seatOf({ owes: 'review', lastReport: report('done', 'review', 5) })
  assert.equal(detect.deriveState(seat, { herdr: live('working'), hooks: [] }, NOW).state, 'idle')
  const newTurn = detect.deriveState(seat, { herdr: live('working'), hooks: [hook('pre-tool-use', 2)] }, NOW)
  assert.equal(newTurn.state, 'working')
})

test('a new report in the outbox that the roster has not applied also holds the seat', () => {
  const seat = seatOf({ owes: 'none' })
  const derived = detect.deriveState(seat, { herdr: live('working'), hooks: [], lastReport: report('question', 'answer', 3, 'r-9') }, NOW)
  assert.equal(derived.state, 'idle')
})

test('once the planner answered (owes none), herdr working is believed again', () => {
  const seat = seatOf({ owes: 'none', lastReport: report('done', 'review', 60) })
  assert.equal(detect.deriveState(seat, { herdr: live('working'), hooks: [] }, NOW).state, 'working')
})

test('a fresh stop hook outranks a lagging herdr working', () => {
  assert.equal(detect.deriveState(seatOf(), { herdr: live('working'), hooks: [hook('pre-tool-use', 20), hook('stop', 3)] }, NOW).state, 'idle')
  assert.equal(detect.deriveState(seatOf(), { herdr: live('working'), hooks: [hook('pre-tool-use', 20), hook('stop', 40)] }, NOW).state, 'working')
})

test('a fresh hook counts as working even when herdr says idle', () => {
  assert.equal(detect.deriveState(seatOf({ state: 'idle' }), { herdr: live('idle'), hooks: [hook('pre-tool-use', 4)] }, NOW).state, 'working')
  assert.equal(detect.deriveState(seatOf({ state: 'idle' }), { herdr: live('idle'), hooks: [hook('pre-tool-use', 40)] }, NOW).state, 'idle')
})

test('herdr done and unknown map through', () => {
  assert.equal(detect.deriveState(seatOf(), { herdr: live('done'), hooks: [] }, NOW).state, 'done')
  assert.equal(detect.deriveState(seatOf(), { herdr: live('unknown'), hooks: [] }, NOW).state, 'unknown')
})

test('a seat missing from the herdr list is gone, with the one-step fix', () => {
  const derived = detect.deriveState(seatOf(), { hooks: [] }, NOW)
  assert.equal(derived.state, 'gone')
  assert.match(derived.attention[0]?.detail ?? '', /drove up --seat w-api/)
})

test('a starting seat that herdr does not list yet stays starting', () => {
  assert.equal(detect.deriveState(seatOf({ state: 'starting' }), { hooks: [] }, NOW).state, 'starting')
})

test('closed and down seats are left alone', () => {
  assert.deepEqual(detect.deriveState(seatOf({ state: 'closed' }), { hooks: [] }, NOW), { state: 'closed', attention: [] })
  assert.deepEqual(detect.deriveState(seatOf({ state: 'down' }), { hooks: [] }, NOW), { state: 'down', attention: [] })
})

test('idle without a report raises an attention item after the grace', () => {
  const seat = seatOf({ lastWorkingAt: ago(100), stateAt: ago(30), lastReport: report('progress', 'none', 200) })
  const derived = detect.deriveState(seat, { herdr: live('idle'), hooks: [] }, NOW)
  assert.deepEqual(derived.attention.map(item => item.reason), ['idle-without-report'])
  const early = detect.deriveState({ ...seat, stateAt: ago(5) }, { herdr: live('idle'), hooks: [] }, NOW)
  assert.deepEqual(early.attention, [])
})

test('needsNudge: once per working episode, after the 20 s grace, never when a report followed', () => {
  const base = seatOf({ state: 'idle', stateAt: ago(25), lastWorkingAt: ago(60) })
  assert.equal(detect.needsNudge(base, NOW), true)
  assert.equal(detect.needsNudge({ ...base, stateAt: ago(10) }, NOW), false)
  assert.equal(detect.needsNudge({ ...base, hasNudged: true }, NOW), false)
  assert.equal(detect.needsNudge({ ...base, lastReport: report('done', 'review', 30), owes: 'review' }, NOW), false)
  assert.equal(detect.needsNudge({ ...base, lastReport: report('done', 'none', 30) }, NOW), false)
  assert.equal(detect.needsNudge({ ...base, state: 'working' }, NOW), false)
  assert.equal(detect.needsNudge({ ...base, lastWorkingAt: undefined }, NOW), false)
})

test('applyDerived stamps state changes, resets nudges on working and keeps foreign attention', () => {
  const seat = seatOf({
    state: 'idle', stateAt: ago(500), hasNudged: true,
    attention: [
      { seat: 'w-api', reason: 'pending-delivery', detail: 'queued', at: ago(10) },
      { seat: 'w-api', reason: 'dialog', detail: 'old', at: ago(10) },
    ],
  })
  const next = detect.applyDerived(seat, { state: 'working', attention: [] }, NOW)
  assert.equal(next.state, 'working')
  assert.equal(next.stateAt, NOW.toISOString())
  assert.equal(next.lastWorkingAt, NOW.toISOString())
  assert.equal(next.hasNudged, false)
  assert.deepEqual(next.attention.map(item => item.reason), ['pending-delivery'])
  const same = detect.applyDerived(next, { state: 'working', attention: [] }, new Date(NOW.getTime() + 5000))
  assert.equal(same.stateAt, NOW.toISOString())
})

test('shouldReadScreen: blocked always, otherwise only until the first hook fires', () => {
  const started = [hook('session-start', 5)]
  assert.equal(detect.shouldReadScreen(undefined, []), false)
  assert.equal(detect.shouldReadScreen(live('blocked'), started), true)
  assert.equal(detect.shouldReadScreen(live('idle'), []), true)
  assert.equal(detect.shouldReadScreen(live('unknown'), []), true)
  assert.equal(detect.shouldReadScreen(live('working'), []), false)
  assert.equal(detect.shouldReadScreen(live('idle'), started), false)
})

test('a Codex hook-review dialog on an idle pane with no hooks yet blocks the seat as hook-trust', () => {
  const derived = detect.deriveState(seatOf({ state: 'starting' }), { herdr: live('idle'), hooks: [], screen: '1 hook needs review before it can run' }, NOW)
  assert.equal(derived.state, 'blocked')
  assert.equal(derived.attention[0]?.reason, 'hook-trust')
})
