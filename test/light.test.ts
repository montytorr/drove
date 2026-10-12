import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { idleTitle, needsHuman, oscTitle, paneTty, REASSERT_MS, stepLight, wantsWorking, workingTitle, writeTty } from '../src/light.ts'
import type { HerdrAgent } from '../src/types.ts'
import { makeExec, seatOf } from './p4-helpers.ts'

const at = '2026-10-12T16:00:00.000Z'
const resting = (status: HerdrAgent['status'] = 'idle'): HerdrAgent => ({ paneId: 'w2V:p1', status, title: 'Plan the run', terminalTitle: '✳ Plan the run' })
const ours = (): HerdrAgent => ({ paneId: 'w2V:p1', status: 'working', title: 'Plan the run', terminalTitle: workingTitle('Plan the run') })

test('the planner light wants working while a worker works and nobody needs the human', () => {
  assert.equal(wantsWorking([seatOf('w-api'), seatOf('w-ui', { state: 'idle' })]), true)
  assert.equal(wantsWorking([seatOf('w-api', { state: 'idle' }), seatOf('w-ui', { state: 'done' })]), false, 'no worker works')
  assert.equal(wantsWorking([]), false)
  assert.equal(wantsWorking([seatOf('w-api', { state: 'closed' })]), false, 'a closed seat is not a worker at work')
  assert.equal(wantsWorking([seatOf('w-api')], true), false, 'the run itself waits on a person')
})

test('a worker that needs the human keeps the planner light plain', () => {
  const dialog = { seat: 'w-ui', reason: 'dialog' as const, detail: 'needs you', at }
  const question = { id: 'r1', kind: 'question' as const, expects: 'answer' as const, for: 'human' as const, summary: 'which schema?', at }
  for (const seat of [
    seatOf('w-ui', { state: 'needs-input' }),
    seatOf('w-ui', { state: 'blocked' }),
    seatOf('w-ui', { state: 'idle', attention: [dialog] }),
    seatOf('w-ui', { state: 'gone', attention: [{ ...dialog, reason: 'gone' }] }),
    seatOf('w-ui', { state: 'idle', owes: 'answer', lastReport: question }),
  ]) {
    assert.equal(needsHuman(seat), true, seat.state)
    assert.equal(wantsWorking([seatOf('w-api'), seat]), false, seat.state)
  }
  const planner = { seat: 'w-ui', reason: 'idle-without-report' as const, detail: 'stopped without a report', at }
  assert.equal(wantsWorking([seatOf('w-api'), seatOf('w-ui', { state: 'idle', attention: [planner] })]), true, 'the planner handles its own attention')
  assert.equal(wantsWorking([seatOf('w-api'), seatOf('w-ui', { state: 'idle', owes: 'none', lastReport: question })]), true, 'an answered question waits on nobody')
  const { for: _human, ...forPlanner } = question
  assert.equal(wantsWorking([seatOf('w-api'), seatOf('w-ui', { state: 'idle', owes: 'answer', lastReport: forPlanner })]), true, 'a question for the planner is the planner\'s')
})

test('a resting planner gets the working title while the rule holds', () => {
  for (const status of ['idle', 'done'] as const) {
    const step = stepLight(undefined, resting(status), true, 1_000)
    assert.equal(step.write, '⠿ Plan the run')
    assert.deepEqual(step.hold, { text: 'Plan the run', at: 1_000 })
  }
  assert.deepEqual(stepLight(undefined, resting(), false, 1_000), {}, 'nothing to show')
  assert.deepEqual(stepLight(undefined, resting('working'), true, 1_000), {}, 'Claude is in a turn and owns its title')
  assert.deepEqual(stepLight(undefined, resting('blocked'), true, 1_000), {}, 'a dialog stays red')
  assert.deepEqual(stepLight(undefined, undefined, true, 1_000), {}, 'herdr does not see the planner')
  assert.equal(stepLight(undefined, { paneId: 'w2V:p1', status: 'idle', terminalTitle: '✳ Only raw' }, true, 1_000).write, '⠿ Only raw')
})

test('the light restores Claude\'s idle title when no worker works any more', () => {
  const hold = { text: 'Plan the run', at: 1_000 }
  assert.deepEqual(stepLight(hold, ours(), false, 6_000), { write: '✳ Plan the run' })
  assert.deepEqual(stepLight(hold, ours(), true, 6_000), { hold }, 'still waiting: no write between re-asserts')
  assert.deepEqual(stepLight(hold, ours(), true, 1_000 + REASSERT_MS), { hold: { text: 'Plan the run', at: 1_000 + REASSERT_MS }, write: '⠿ Plan the run' })
})

test('Claude takes the title back at its next turn, and Drove lets go without restoring', () => {
  const hold = { text: 'Plan the run', at: 1_000 }
  const turn: HerdrAgent = { paneId: 'w2V:p1', status: 'working', title: 'Plan the run', terminalTitle: '◐ Plan the run' }
  assert.deepEqual(stepLight(hold, turn, false, 6_000), {}, 'no ✳ over a live turn')
  assert.deepEqual(stepLight(hold, turn, true, 6_000), {})
  // The turn ends with Claude's own idle title, and workers still work: Drove takes it again.
  assert.equal(stepLight(undefined, resting('done'), true, 9_000).write, '⠿ Plan the run')
  // Claude rewrote its idle title while Drove held it: re-asserted on the next look.
  assert.equal(stepLight(hold, resting(), true, 6_000).write, '⠿ Plan the run')
})

test('the working title is one herdr reads as working, and the OSC sequence carries no control bytes', () => {
  assert.match(workingTitle('x'), /^[⠀-⣿◐-◓] /u)
  assert.equal(idleTitle('x'), '✳ x')
  assert.equal(oscTitle('a\x07b\x1bc'), '\x1b]0;a b c\x07')
})

test('the planner pane\'s tty comes from herdr\'s process info and ps', async () => {
  const info = JSON.stringify({ id: 'cli:pane:process_info', result: { process_info: { pane_id: 'w2V:p1', shell_pid: 50369 }, type: 'pane_process_info' } })
  const { calls, exec } = makeExec(argv => (argv[0] === 'herdr' ? { stdout: info } : { stdout: 'ttys012\n' }))
  assert.equal(await paneTty(exec, 'w2V:p1'), '/dev/ttys012')
  assert.deepEqual(calls, [['herdr', 'pane', 'process-info', '--pane', 'w2V:p1'], ['ps', '-o', 'tty=', '-p', '50369']])
  assert.equal(await paneTty(makeExec(argv => (argv[0] === 'herdr' ? { stdout: info } : { stdout: 'pts/3' })).exec, 'w2V:p1'), '/dev/pts/3')
  assert.equal(await paneTty(makeExec(argv => (argv[0] === 'herdr' ? { stdout: info } : { stdout: '??' })).exec, 'w2V:p1'), undefined, 'no terminal')
  assert.equal(await paneTty(makeExec(() => ({ code: 1, stderr: '{"error":{"code":"pane_not_found"}}' })).exec, 'w2V:p9'), undefined)
})

test('writeTty appends the sequence to the device', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'drove-light-')), 'tty')
  await writeFile(path, '')
  writeTty(path, oscTitle('⠿ x'))
  writeTty(path, oscTitle('✳ x'))
  assert.equal(await readFile(path, 'utf8'), '\x1b]0;⠿ x\x07\x1b]0;✳ x\x07')
})
