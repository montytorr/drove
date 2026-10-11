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

test('an open turn counts as working even when herdr says idle, for as long as the seat shows life', () => {
  assert.equal(detect.deriveState(seatOf({ state: 'idle' }), { herdr: live('idle'), hooks: [hook('pre-tool-use', 4)] }, NOW).state, 'working')
  assert.equal(detect.deriveState(seatOf({ state: 'idle' }), { herdr: live('idle'), hooks: [hook('pre-tool-use', 40)] }, NOW).state, 'working')
  const quiet = detect.OPEN_TURN_QUIET_MS / 1000 + 1
  assert.equal(detect.deriveState(seatOf({ state: 'idle' }), { herdr: live('idle'), hooks: [hook('user-prompt-submit', quiet)] }, NOW).state, 'idle')
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

test('an idle seat with no herdr agent is gone', () => {
  const derived = detect.deriveState(seatOf({ state: 'idle' }), { hooks: [] }, NOW)
  assert.equal(derived.state, 'gone')
  assert.equal(derived.attention[0]?.reason, 'gone')
})

const restarting = (seconds = 5): Partial<Seat> => ({ state: 'starting', restartingSince: ago(seconds) })

test('a seat mid-restart keeps its state while herdr still lists the old agent', () => {
  for (const status of ['done', 'idle', 'working', 'blocked'] as const) {
    const derived = detect.deriveState(seatOf(restarting()), { herdr: live(status), hooks: [], screen: 'trust this folder' }, NOW)
    assert.deepEqual(derived, { state: 'starting', attention: [] }, status)
  }
})

test('a seat mid-restart with no agent raises no gone, whatever state the roster holds', () => {
  for (const state of ['starting', 'idle', 'working', 'done'] as const) {
    const derived = detect.deriveState(seatOf({ ...restarting(), state }), { hooks: [] }, NOW)
    assert.deepEqual(derived, { state, attention: [] }, state)
  }
})

test('applyDerived leaves a seat mid-restart untouched', () => {
  const seat = seatOf(restarting())
  assert.equal(detect.applyDerived(seat, { state: 'done', attention: [] }, NOW), seat)
})

test('past the restart bound a seat with no agent reads gone again, even while marked starting', () => {
  const seat = seatOf(restarting(detect.RESTART_BOUND_MS / 1000 + 1))
  const derived = detect.deriveState(seat, { hooks: [] }, NOW)
  assert.equal(derived.state, 'gone')
  assert.equal(derived.attention[0]?.reason, 'gone')
  assert.equal(detect.deriveState(seat, { herdr: live('idle'), hooks: [] }, NOW).state, 'idle')
})

test('the restart bound is twice the exit wait plus the start timeout', () => {
  assert.equal(detect.RESTART_BOUND_MS, 2 * detect.EXIT_WAIT_MS + 60_000)
  assert.equal(detect.isRestarting(seatOf({ restartingSince: ago(detect.RESTART_BOUND_MS / 1000 - 1) }), NOW), true)
  assert.equal(detect.isRestarting(seatOf({ restartingSince: ago(detect.RESTART_BOUND_MS / 1000) }), NOW), false)
  assert.equal(detect.isRestarting(seatOf(), NOW), false)
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

test('a done worker that takes a hook turn after its report raises nothing and is not nudged', () => {
  const seat = seatOf({ state: 'idle', lastWorkingAt: ago(60), stateAt: ago(30), lastReport: report('done', 'review', 100), owes: 'review' })
  const derived = detect.deriveState(seat, { herdr: live('idle'), hooks: [], lastReport: seat.lastReport }, NOW)
  assert.deepEqual(derived.attention, [])
  assert.equal(detect.needsNudge({ ...seat, owes: 'none' }, NOW), false)
})

test('a done Codex seat promoted with a notice that takes a turn raises nothing', () => {
  const seat = seatOf({ kind: 'codex', state: 'idle', lastWorkingAt: ago(60), stateAt: ago(30), lastReport: report('done', 'none', 100), owes: 'none' })
  const derived = detect.deriveState(seat, { herdr: live('idle'), hooks: [], lastReport: seat.lastReport }, NOW)
  assert.deepEqual(derived.attention, [])
  assert.equal(detect.needsNudge(seat, NOW), false)
})

test('a worker messaged after its done report and then silent is still flagged', () => {
  const seat = seatOf({ state: 'idle', lastWorkingAt: ago(60), stateAt: ago(30), lastReport: report('done', 'review', 100), lastSentAt: ago(80) })
  const derived = detect.deriveState(seat, { herdr: live('idle'), hooks: [], lastReport: seat.lastReport }, NOW)
  assert.deepEqual(derived.attention.map(item => item.reason), ['idle-without-report'])
})

test('an answered question followed by a silent stop is flagged, an unanswered one is not', () => {
  const base = { state: 'idle' as const, lastWorkingAt: ago(60), stateAt: ago(30), lastReport: report('question', 'answer', 100) }
  const unanswered = detect.deriveState(seatOf(base), { herdr: live('idle'), hooks: [], lastReport: base.lastReport }, NOW)
  assert.deepEqual(unanswered.attention, [])
  const answered = detect.deriveState(seatOf({ ...base, lastSentAt: ago(80) }), { herdr: live('idle'), hooks: [], lastReport: base.lastReport }, NOW)
  assert.deepEqual(answered.attention.map(item => item.reason), ['idle-without-report'])
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

const CLAUDE_LIMIT = "  ⎿ You've hit your session limit · resets 2pm (Europe/Paris)\n\n> "
const CODEX_LIMIT = "■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus),\n  or try again at Oct 11th, 2026 2:00 PM."

test('usage limit: a Claude limit screen becomes a usage-limit item carrying the reset time', () => {
  const hit = detect.matchDialog('w-api', CLAUDE_LIMIT, NOW)
  assert.equal(hit?.reason, 'usage-limit')
  assert.equal(hit?.detail, 'hit its usage limit (resets 2pm (Europe/Paris))')
  assert.equal(detect.matchDialog('w-api', "You've hit your weekly limit · resets Oct 14, 9am", NOW)?.detail, 'hit its usage limit (resets Oct 14, 9am)')
  assert.equal(detect.matchDialog('w-api', "You've hit your Opus limit", NOW)?.detail, 'hit its usage limit')
  assert.equal(detect.matchDialog('w-api', "You're out of extra usage · resets 11:30pm", NOW)?.reason, 'usage-limit')
  assert.match(detect.findDialog(CLAUDE_LIMIT)?.hint ?? '', /^Claude hit its usage limit/)
})

test('usage limit: a Codex limit screen becomes a usage-limit item, with the reset time across a wrapped line', () => {
  const hit = detect.matchDialog('w-cx', CODEX_LIMIT, NOW)
  assert.equal(hit?.reason, 'usage-limit')
  assert.equal(hit?.detail, 'hit its usage limit (resets Oct 11th, 2026 2:00 PM)')
  assert.equal(detect.matchDialog('w-cx', 'You’ve hit your usage limit.', NOW)?.detail, 'hit its usage limit')
  assert.match(detect.findDialog(CODEX_LIMIT)?.hint ?? '', /^Codex hit its usage limit/)
})

test('usage limit: the fast-mode cooldown, quoted text and a diff do not match', () => {
  assert.equal(detect.matchDialog('s', "You've hit your fast limit · resets in 3m", NOW), undefined)
  assert.equal(detect.matchDialog('s', "  42 +  assert.match(screen, /You've hit your usage limit/)", NOW), undefined)
  assert.equal(detect.matchDialog('s', "The worker said: you've hit your usage limit earlier", NOW), undefined)
})

test('usage limit: an idle seat that stopped without a report is blocked with the item, not flagged idle-without-report', () => {
  const seat = seatOf({ state: 'idle', lastWorkingAt: ago(100), stateAt: ago(40), lastReport: report('progress', 'none', 200) })
  const derived = detect.deriveState(seat, { herdr: live('idle'), hooks: [hook('session-start', 300)], screen: CLAUDE_LIMIT }, NOW)
  assert.equal(derived.state, 'blocked')
  assert.deepEqual(derived.attention.map(item => item.reason), ['usage-limit'])
  assert.equal(derived.attention[0]?.detail, 'hit its usage limit (resets 2pm (Europe/Paris))')
})

test('usage limit: needsNudge never fires for a seat carrying the item', () => {
  const base = seatOf({ state: 'idle', stateAt: ago(25), lastWorkingAt: ago(60) })
  assert.equal(detect.needsNudge(base, NOW), true)
  const limited = { ...base, attention: [{ seat: 'w-api', reason: 'usage-limit' as const, detail: 'hit its usage limit', at: ago(5) }] }
  assert.equal(detect.needsNudge(limited, NOW), false)
})

test('usage limit: a StopFailure rate_limit or billing_error hook gives the item with no limit text on screen, until the seat works again', () => {
  const seat = seatOf({ state: 'idle', lastWorkingAt: ago(100), stateAt: ago(40) })
  const limited = detect.deriveState(seat, { herdr: live('idle'), hooks: [hook('session-start', 300), hook('user-prompt-submit', 200), hook('stop-failure', 90, 'rate_limit')] }, NOW)
  assert.equal(limited.state, 'blocked')
  assert.deepEqual(limited.attention.map(item => [item.reason, item.detail]), [['usage-limit', 'hit its usage limit (rate_limit)']])
  assert.equal(detect.needsNudge({ ...seat, state: limited.state, attention: limited.attention }, NOW), false)
  const billing = detect.deriveState(seat, { herdr: live('idle'), hooks: [hook('stop-failure', 90, "billing_error: You're out of extra usage · resets 11:30pm")] }, NOW)
  assert.deepEqual(billing.attention.map(item => [item.reason, item.detail]), [['usage-limit', 'hit its usage limit (resets 11:30pm)']])
  const resumed = detect.deriveState(seat, { herdr: live('working'), hooks: [hook('stop-failure', 90, 'rate_limit'), hook('user-prompt-submit', 5)] }, NOW)
  assert.equal(resumed.attention.some(item => item.reason === 'usage-limit'), false)
  const overloaded = detect.deriveState(seat, { herdr: live('idle'), hooks: [hook('stop-failure', 90, 'overloaded')] }, NOW)
  assert.equal(overloaded.attention.some(item => item.reason === 'usage-limit'), false)
})

test('shouldReadScreen: a seat that went idle with no report since it worked is read even after its hooks fired', () => {
  const started = [hook('session-start', 500), hook('user-prompt-submit', 400)]
  const silent = seatOf({ state: 'idle', lastWorkingAt: ago(100), stateAt: ago(40) })
  assert.equal(detect.shouldReadScreen(live('idle'), started, silent), true)
  assert.equal(detect.shouldReadScreen(live('done'), started, silent), true)
  assert.equal(detect.shouldReadScreen(live('working'), started, silent), false)
  assert.equal(detect.shouldReadScreen(live('idle'), started, { ...silent, lastReport: report('progress', 'none', 200) }), true)
  assert.equal(detect.shouldReadScreen(live('idle'), started, { ...silent, lastReport: report('done', 'review', 30), owes: 'review' }), false)
  assert.equal(detect.shouldReadScreen(live('idle'), started, { ...silent, lastWorkingAt: undefined }), false)
  assert.equal(detect.shouldReadScreen(live('idle'), started), false)
})

const IDLE_SEAT = (overrides: Partial<Seat> = {}) => seatOf({ state: 'idle', ...overrides })

test('DROVE-108: a prompt with no Stop after it is a turn in flight, whatever herdr says and however old the prompt', () => {
  const hooks = [hook('user-prompt-submit', 120)]
  for (const status of ['idle', 'done', 'unknown'] as const) {
    const derived = detect.deriveState(IDLE_SEAT(), { herdr: live(status), hooks }, NOW)
    assert.equal(derived.state, 'working', status)
    assert.deepEqual(derived.attention, [])
  }
})

test('DROVE-108: a Stop, a StopFailure or a new session ends the turn', () => {
  for (const closing of ['stop', 'stop-failure', 'session-start'] as const) {
    const derived = detect.deriveState(IDLE_SEAT(), { herdr: live('idle'), hooks: [hook('user-prompt-submit', 120), hook(closing, 100)] }, NOW)
    assert.equal(derived.state, 'idle', closing)
  }
  const reopened = detect.deriveState(IDLE_SEAT(), { herdr: live('idle'), hooks: [hook('user-prompt-submit', 120), hook('stop', 100), hook('user-prompt-submit', 50)] }, NOW)
  assert.equal(reopened.state, 'working')
})

test('DROVE-108: an open turn is not flagged idle-without-report, however long the seat has been silent', () => {
  const seat = IDLE_SEAT({ lastWorkingAt: ago(900), stateAt: ago(600) })
  const derived = detect.deriveState(seat, { herdr: live('idle'), hooks: [hook('user-prompt-submit', 200)] }, NOW)
  assert.equal(derived.state, 'working')
  assert.deepEqual(derived.attention, [])
})

test('DROVE-108: an open turn goes quiet after the bound unless the transcript is still being written (Esc fires no Stop)', () => {
  const stale = detect.OPEN_TURN_QUIET_MS / 1000 + 30
  const hooks = [hook('user-prompt-submit', stale)]
  const seat = IDLE_SEAT({ lastWorkingAt: ago(stale), stateAt: ago(stale) })
  const interrupted = detect.deriveState(seat, { herdr: live('idle'), hooks }, NOW)
  assert.equal(interrupted.state, 'idle')
  assert.deepEqual(interrupted.attention.map(item => item.reason), ['idle-without-report'])
  const writing = detect.deriveState(seat, { herdr: live('idle'), hooks, transcriptAt: NOW.getTime() - 20_000 }, NOW)
  assert.equal(writing.state, 'working')
  const old = detect.deriveState(seat, { herdr: live('idle'), hooks, transcriptAt: NOW.getTime() - detect.OPEN_TURN_QUIET_MS - 1 }, NOW)
  assert.equal(old.state, 'idle')
})

test('DROVE-108: a seat that owes an answer counts a turn only when the prompt came after its report', () => {
  const seat = IDLE_SEAT({ owes: 'answer', lastReport: report('question', 'answer', 300) })
  const before = detect.deriveState(seat, { herdr: live('idle'), hooks: [hook('user-prompt-submit', 400)] }, NOW)
  assert.equal(before.state, 'idle')
  const after = detect.deriveState(seat, { herdr: live('idle'), hooks: [hook('user-prompt-submit', 400), hook('stop', 299), hook('user-prompt-submit', 200)] }, NOW)
  assert.equal(after.state, 'working')
})

test('DROVE-109: a transcript write after a permission notification clears it, the agent went on after the approval', () => {
  const hooks = [hook('notification', 60, 'permission_prompt')]
  const derived = detect.deriveState(seatOf(), { herdr: live('idle'), hooks, transcriptAt: NOW.getTime() - 20_000 }, NOW)
  assert.equal(derived.state, 'idle')
  assert.equal(derived.attention.some(item => item.reason === 'permission'), false)
})

test('DROVE-109: a transcript written before, or within the grace of, the permission notification does not clear it', () => {
  const hooks = [hook('notification', 60, 'permission_prompt')]
  for (const transcriptAt of [NOW.getTime() - 61_000, NOW.getTime() - 59_500, undefined]) {
    assert.equal(detect.deriveState(seatOf(), { herdr: live('idle'), hooks, ...(transcriptAt !== undefined ? { transcriptAt } : {}) }, NOW).state, 'needs-input')
  }
})
