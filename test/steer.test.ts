import assert from 'node:assert/strict'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { advanceLedger, exitCodeOf, newLedger } from '../src/ledger.ts'
import * as commands from '../src/commands.ts'
import { runDir, seatDir } from '../src/paths.ts'
import { buildReport, renderReport } from '../src/report.ts'
import { updateRoster } from '../src/roster.ts'
import { failureStreak, isCheckCommand, normalise, repeatText, steerConfig, steeringNotes, unchecked } from '../src/steer.ts'
import { appendJsonl, readJsonlFrom } from '../src/store.ts'
import type { HookRecord, Report } from '../src/types.ts'
import { createWatcher, defaultWatchPorts } from '../src/watch.ts'
import { eventsOf, fakePorts, fileReport, rosterOf, setup } from './p4-helpers.ts'
import type { Ctx } from './p4-helpers.ts'
import { FakeHerdr, makeDeps, makeSeat, RUN, seedRun } from './p3-helpers.ts'

const jsonl = (items: unknown[]): string => `${items.map(item => JSON.stringify(item)).join('\n')}\n`

// ---------- a Claude transcript ----------

let ids = 0
const stamp = (offsetSeconds: number): string => new Date(Date.parse('2026-10-09T09:30:00.000Z') + offsetSeconds * 1000).toISOString()
// How the R2 line prints a time: without the milliseconds.
const shown = (offsetSeconds: number): string => stamp(offsetSeconds).replace(/\.\d+Z$/, 'Z')
const use = (name: string, input: Record<string, unknown>, second: number) => {
  ids += 1
  const id = `toolu_${ids}`
  return { id, line: { type: 'assistant', timestamp: stamp(second), message: { id: `msg_${ids}`, content: [{ type: 'tool_use', id, name, input }] } } }
}
const result = (id: string, isError: boolean, second: number) => ({ type: 'user', timestamp: stamp(second + 1), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'text', ...(isError ? { is_error: true } : {}) }] } })
// One Claude tool call and its answer, as two transcript lines.
const claudeCall = (name: string, input: Record<string, unknown>, isError: boolean, second: number): unknown[] => {
  const call = use(name, input, second)
  return [call.line, result(call.id, isError, second)]
}
const bash = (command: string, isError: boolean, second: number) => claudeCall('Bash', { command }, isError, second)
const edit = (path: string, second: number) => claudeCall('Edit', { file_path: path, old_string: 'a', new_string: 'b' }, false, second)

// ---------- a Codex rollout ----------

const codexCall = (name: string, args: Record<string, unknown>, output: string, second: number, custom = false): unknown[] => {
  ids += 1
  const call_id = `call_${ids}`
  return [
    { timestamp: stamp(second), type: 'response_item', payload: custom ? { type: 'custom_tool_call', name, input: String(args.input ?? ''), call_id } : { type: 'function_call', name, arguments: JSON.stringify(args), call_id } },
    { timestamp: stamp(second + 1), type: 'response_item', payload: { type: custom ? 'custom_tool_call_output' : 'function_call_output', call_id, output } },
  ]
}
const exec = (cmd: string, code: number, second: number) => codexCall('exec_command', { cmd, workdir: '/repo' }, `Chunk ID: ab12\nWall time: 0.3000 seconds\nProcess exited with code ${code}\nOriginal token count: 4\nOutput:\nsome output\n`, second)

// ---------- a watcher with a seat whose transcript this test writes ----------

const claudeSeat = async (config?: unknown) => {
  const ctx = await setup()
  const transcript = join(ctx.home, 'claude-session.jsonl')
  await writeFile(transcript, '')
  await updateRoster(ctx.home, ctx.run.id, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, kind: 'claude' as const, sessionId: 's1' })) }))
  const hook: HookRecord = { at: ctx.clock.now().toISOString(), agent: 'claude', event: 'session-start', sessionId: 's1', transcript }
  await appendJsonl(join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'hooks.jsonl'), hook)
  if (config !== undefined) await writeFile(join(ctx.home, 'config.json'), JSON.stringify(config))
  return { ctx, transcript }
}

const watching = (ctx: Ctx, overrides: Parameters<typeof fakePorts>[0] = {}) => {
  const { ports, controls } = fakePorts({ agents: () => [{ name: 'w-api', paneId: 'p-w-api', status: 'working' as const }], ...overrides })
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  // A tick of the poll: past the watcher's own 5 s and the rules' 15 s.
  const poll = async (by = 20_000) => {
    ctx.clock.advance(by)
    await watcher.tick()
  }
  return { ports, controls, watcher, poll }
}

const nudges = async (ctx: Ctx) => (await eventsOf(ctx)).filter(event => event.type === 'steer.nudged')

test('normalise strips whitespace, env -u and VAR= prefixes, and a check is told from any other command', () => {
  assert.equal(normalise('  npm   test  '), 'npm test')
  assert.equal(normalise('env -u DROVE_RUN -u DROVE_SEAT npm test'), 'npm test')
  assert.equal(normalise('CI=1 NODE_ENV=test npm test'), 'npm test')
  assert.equal(normalise('env FOO="a b" BAR=1 -u X node --test'), 'node --test')
  assert.equal(normalise('env'), 'env')
  assert.equal(normalise('env | sort'), 'env | sort')
  assert.equal(normalise('FOO=bar'), 'FOO=bar')

  const plan = ['npm run typecheck', 'npm test']
  assert.ok(isCheckCommand('npm test', plan))
  assert.ok(isCheckCommand('CI=1 npm test -- --reporter=dot', plan))
  assert.ok(isCheckCommand('cd src && npm run typecheck', plan))
  assert.ok(isCheckCommand('node --test test/steer.test.ts', plan))
  assert.ok(isCheckCommand('npx eslint src', plan))
  assert.ok(isCheckCommand('cargo test --all', []))
  assert.ok(isCheckCommand('claude plugin test mod', []))
  assert.ok(!isCheckCommand('git status', plan))
  assert.ok(!isCheckCommand('npm install', plan))
  assert.ok(!isCheckCommand('cat package.json', plan))
})

test('the steering config is on unless it says enabled: false, and a bad number keeps its default', () => {
  assert.deepEqual(steerConfig(undefined), { enabled: true, repeatFailures: 3, cooldownMinutes: 10, checkCommands: [] })
  assert.equal(steerConfig({ enabled: false }).enabled, false)
  assert.equal(steerConfig({ enabled: 'no' }).enabled, true)
  assert.equal(steerConfig({ repeatFailures: 5 }).repeatFailures, 5)
  assert.equal(steerConfig({ repeatFailures: 1 }).repeatFailures, 3)
  assert.equal(steerConfig({ cooldownMinutes: 'x' }).cooldownMinutes, 10)
  assert.deepEqual(steerConfig({ checkCommands: [' make verify ', 7, ''] }).checkCommands, ['make verify'])
})

test('the ledger pairs a Claude call with its result, and reads on from its offset', async () => {
  const { ctx, transcript } = await claudeSeat()
  const first = [...bash('npm test', true, 0), ...edit('/repo/src/a.ts', 10), ...claudeCall('Read', { file_path: '/repo/src/a.ts' }, false, 12)]
  await writeFile(transcript, jsonl([{ type: 'user', message: { content: 'hello' } }, ...first]))
  const size = async () => (await readJsonlFrom<unknown>(transcript, { offset: 0 })).cursor.offset
  let reads = 0
  const counting: typeof readJsonlFrom = async (path, cursor) => {
    reads += 1
    return readJsonlFrom(path, cursor)
  }

  const ledger = await advanceLedger('claude', transcript, await size(), undefined, counting)
  assert.deepEqual(ledger.entries.map(entry => [entry.tool, entry.command, entry.paths, entry.ok]), [
    ['Bash', 'npm test', undefined, false],
    ['Edit', undefined, ['/repo/src/a.ts'], true],
    ['Read', undefined, ['/repo/src/a.ts'], true],
  ])
  assert.equal(ledger.entries[0]?.at, stamp(0))
  assert.equal(ledger.lastEdit?.tool, 'Edit')

  // A call with no answer yet is not an entry; its answer, a tick later, makes it one, and the old lines are not read again.
  const pending = use('Bash', { command: 'npm run lint' }, 20)
  await appendFile(transcript, jsonl([pending.line]))
  assert.equal((await advanceLedger('claude', transcript, await size(), ledger, counting)).entries.length, 3)
  await appendFile(transcript, jsonl([result(pending.id, false, 20)]))
  const grown = await advanceLedger('claude', transcript, await size(), ledger, counting)
  assert.equal(grown, ledger)
  assert.deepEqual(grown.entries.at(-1), { at: stamp(20), tool: 'Bash', command: 'npm run lint', ok: true })
  assert.equal(grown.count, 4)
  assert.equal(reads, 3)
  // A line that is not finished yet is left for the next read.
  await appendFile(transcript, '{"type":"assis')
  const before = grown.offset
  assert.equal((await advanceLedger('claude', transcript, await size(), grown, counting)).offset, before)
})

test('the ledger reads Codex function calls and their exit codes, and an apply_patch edit', async () => {
  const { ctx } = await claudeSeat()
  const rollout = join(ctx.home, 'rollout.jsonl')
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch\n'
  await writeFile(rollout, jsonl([
    { type: 'session_meta', payload: { id: 'thread-1' } },
    ...exec('npm test', 1, 0),
    ...codexCall('shell', { command: ['bash', '-lc', 'npm run lint'] }, JSON.stringify({ output: 'ok', metadata: { exit_code: 0, duration_seconds: 1 } }), 5),
    ...codexCall('apply_patch', { input: patch }, JSON.stringify({ output: 'Success', metadata: { exit_code: 0 } }), 10),
    ...codexCall('apply_patch', { input: patch }, patch, 12, true),
    ...codexCall('exec_command', { cmd: 'sleep 100' }, 'Chunk ID: x\nWall time: 1.0 seconds\nProcess running with session ID 7\nOutput:\n', 14),
  ]))
  const size = (await readJsonlFrom<unknown>(rollout, { offset: 0 })).cursor.offset
  const ledger = await advanceLedger('codex', rollout, size, undefined)
  assert.deepEqual(ledger.entries.map(entry => [entry.tool, entry.command, entry.paths, entry.ok]), [
    ['exec_command', 'npm test', undefined, false],
    ['shell', 'npm run lint', undefined, true],
    ['apply_patch', undefined, ['src/a.ts'], true],
    ['apply_patch', undefined, ['src/a.ts'], true],
    ['exec_command', 'sleep 100', undefined, true],
  ])
  assert.equal(exitCodeOf([{ type: 'input_text', text: 'Exit code: 2\nWall time: 1s' }]), 2)
  assert.equal(exitCodeOf('no code here'), undefined)
})

test('a shrunk transcript starts a new ledger, and a long one is read from near its end', async () => {
  const { transcript } = await claudeSeat()
  const lines = jsonl([...bash('a', true, 0), ...bash('b', true, 5)])
  await writeFile(transcript, lines)
  const bytes = Buffer.byteLength(lines)
  const ledger = await advanceLedger('claude', transcript, bytes, undefined)
  assert.equal(ledger.entries.length, 2)
  await writeFile(transcript, jsonl(bash('c', false, 0)))
  const next = await advanceLedger('claude', transcript, Buffer.byteLength(jsonl(bash('c', false, 0))), ledger)
  assert.notEqual(next, ledger)
  assert.deepEqual(next.entries.map(entry => entry.command), ['c'])
  assert.equal(newLedger('x').count, 0)
})

test('a streak is the same command failing in a row; a success, another command or an edit ends it, a read does not', async () => {
  const { transcript } = await claudeSeat()
  const write = async (items: unknown[]) => {
    await writeFile(transcript, jsonl(items))
    return advanceLedger('claude', transcript, Buffer.byteLength(jsonl(items)), undefined)
  }
  const three = [...bash('npm test', true, 0), ...bash('  env -u DROVE_RUN npm test ', true, 10), ...claudeCall('Read', { file_path: '/repo/x.ts' }, false, 15), ...bash('CI=1 npm test', true, 20)]
  const streak = failureStreak(await write(three))
  assert.deepEqual([streak?.command, streak?.count, streak?.lastNumber], ['npm test', 3, 4])
  assert.equal(failureStreak(await write([...three, ...bash('npm test', false, 30)])), undefined)
  assert.equal(failureStreak(await write([...three, ...edit('/repo/src/a.ts', 30)])), undefined)
  assert.equal(failureStreak(await write([...three, ...bash('git status', false, 30)])), undefined)
  assert.equal(failureStreak(await write([...bash('npm test', true, 0), ...bash('npm run lint', true, 5), ...bash('npm test', true, 10)]))?.count, 1)
  assert.equal(failureStreak(await write([...bash('npm test', false, 0), ...bash('npm test', true, 5), ...bash('npm test', true, 10)]))?.count, 2)
})

test('unchecked: an edit and no passing check after it; scratch edits and failed checks do not count', async () => {
  const { transcript } = await claudeSeat()
  const read = async (items: unknown[]) => {
    await writeFile(transcript, jsonl(items))
    return advanceLedger('claude', transcript, Buffer.byteLength(jsonl(items)), undefined)
  }
  const plan = ['npm test']
  assert.equal(unchecked(await read([...bash('npm test', false, 0)]), plan), undefined)
  assert.equal(unchecked(await read([...edit('/repo/a.ts', 0), ...bash('npm test', true, 5)]), plan)?.lastEdit.at, stamp(0))
  assert.equal(unchecked(await read([...edit('/repo/a.ts', 0), ...bash('npm test', false, 5)]), plan), undefined)
  const beforeEdit = unchecked(await read([...bash('npm test', false, 0), ...edit('/repo/a.ts', 5), ...bash('ls', false, 8)]), plan)
  assert.deepEqual([beforeEdit?.lastEdit.at, beforeEdit?.lastCheck?.at], [stamp(5), stamp(0)])
  assert.equal(unchecked(await read([...edit('/repo/a.ts', 0), ...bash('npm test', false, 5), ...edit('/repo/b.ts', 10)]), plan)?.lastCheck?.at, stamp(5))
  assert.equal(unchecked(await read([...edit('/repo/a.ts', 0), ...bash('npm test', false, 5), ...edit('/tmp/scratch.txt', 10)]), plan), undefined)
  assert.equal(unchecked(await read([...edit('/repo/a.ts', 0), ...claudeCall('Bash', { command: 'npm test' }, true, 5)]), plan)?.lastEdit.at, stamp(0))
})

test('AC1: the same Bash command failing 3 times sends the worker one R1 message and records the nudge; a 4th within 10 minutes sends nothing', async () => {
  const { ctx, transcript } = await claudeSeat()
  const { controls, poll } = watching(ctx)
  await writeFile(transcript, jsonl([...bash('npm test', true, 0), ...bash('npm test', true, 5)]))
  await poll()
  assert.equal(controls.length, 0, 'two failures are not enough')

  await appendFile(transcript, jsonl(bash('env -u DROVE_RUN npm test', true, 10)))
  await poll()
  assert.equal(controls.length, 1)
  const [control] = controls
  assert.deepEqual([control?.to, control?.kind, control?.expects, control?.from], ['w-api', 'message', 'none', 'planner'])
  assert.equal(control?.body, 'Drove: `npm test` has failed 3 times with the same result. Change approach, or send a blocked or question report.')
  assert.equal(control?.body, repeatText('npm test', 3))
  const events = await nudges(ctx)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.seat, 'w-api')
  assert.deepEqual(events[0]?.data, { seat: 'w-api', rule: 'R1', detail: control?.body })

  await appendFile(transcript, jsonl(bash('npm test', true, 20)))
  await poll()
  await poll()
  assert.equal(controls.length, 1, 'a 4th failure inside the cooldown sends nothing')
  assert.equal((await nudges(ctx)).length, 1)

  // Past the 10 minutes, a failure the seat has not been told about is a new nudge.
  await appendFile(transcript, jsonl(bash('npm test', true, 700)))
  await poll(11 * 60_000)
  assert.equal(controls.length, 2)
  assert.equal((await nudges(ctx)).length, 2)
})

test('R1 waits for the throttle, skips a seat that has reported since, and an edit between failures ends the streak', async () => {
  const { ctx, transcript } = await claudeSeat()
  const { controls, poll } = watching(ctx)
  await writeFile(transcript, jsonl([...bash('make', true, 0), ...bash('make', true, 5)]))
  await poll()
  await appendFile(transcript, jsonl(bash('make', true, 10)))
  await poll(5_000)
  assert.equal(controls.length, 0, 'the rules run at most every 15 s per seat')
  await poll(11_000)
  assert.equal(controls.length, 1)

  // A second seat's worth of state: an edit resets the count, so three failures with edits between them are not a repeat.
  const other = await claudeSeat()
  const again = watching(other.ctx)
  await writeFile(other.transcript, jsonl([...bash('make', true, 0), ...edit('/repo/a.ts', 3), ...bash('make', true, 5), ...edit('/repo/a.ts', 8), ...bash('make', true, 10)]))
  await again.poll()
  assert.equal(again.controls.length, 0)

  // A seat that has reported since its last failure is waiting on the planner, not looping.
  const reported = await claudeSeat()
  const quiet = watching(reported.ctx)
  await writeFile(reported.transcript, jsonl([...bash('make', true, 0), ...bash('make', true, 1), ...bash('make', true, 2)]))
  await updateRoster(reported.ctx.home, reported.ctx.run.id, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, lastReport: { id: 'r1', kind: 'blocked' as const, expects: 'answer' as const, summary: 's', at: '2026-10-09T10:30:00.000Z' } })) }))
  await quiet.poll()
  assert.equal(quiet.controls.length, 0)
})

test('AC3: a Codex rollout with the same command failing 3 times fires R1', async () => {
  const ctx = await setup()
  const codexHome = join(ctx.home, 'codex-home')
  const day = join(codexHome, 'sessions', '2026', '10', '09')
  await mkdir(day, { recursive: true })
  const rollout = join(day, 'rollout-2026-10-09T09-00-00-thread-7.jsonl')
  await writeFile(rollout, jsonl([...exec('pytest -x', 1, 0), ...exec('pytest -x', 1, 10), ...exec('pytest -x', 1, 20)]))
  await updateRoster(ctx.home, ctx.run.id, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, kind: 'codex' as const, sessionId: 'thread-7', codexHome })) }))
  const { controls, poll } = watching(ctx)
  await poll()
  assert.equal(controls.length, 1)
  assert.match(controls[0]?.body ?? '', /^Drove: `pytest -x` has failed 3 times with the same result\./)
  const [event] = await nudges(ctx)
  assert.equal(event?.data?.rule, 'R1')
})

const doneText = async (watcher: ReturnType<typeof watching>['watcher']): Promise<string> => watcher.piggyback('')

test('AC2: a done report after an edit with no passing check carries the R2 line, and one after a passing check does not', async () => {
  const { ctx, transcript } = await claudeSeat()
  const { watcher } = watching(ctx)
  await writeFile(transcript, jsonl([...bash('npm test', true, 0), ...edit('/repo/src/a.ts', 10), ...bash('git status', false, 20)]))
  await fileReport(ctx, 'w-api', 'done', 'all done', { expects: 'review' })
  const text = await doneText(watcher)
  assert.match(text, /all done/)
  assert.ok(text.includes(`Drove: no check ran after the last edit (last edit ${shown(10)}, last check never)`), text)
  const [event] = await nudges(ctx)
  assert.equal(event?.data?.rule, 'R2')
  assert.equal(event?.seat, 'w-api')
  assert.match(String(event?.data?.detail), /^Drove: no check ran after the last edit/)
  assert.ok(event?.id, 'the event names the report')

  // The worker was told nothing, and the line is in the planner's `drove reports`, from the event log.
  const notes = await steeringNotes(join(ctx.home, 'runs', ctx.run.id, 'events.jsonl'))
  assert.equal(notes.get(event?.id as string), event?.data?.detail)

  const passing = await claudeSeat()
  const second = watching(passing.ctx)
  await writeFile(passing.transcript, jsonl([...edit('/repo/src/a.ts', 10), ...bash('npm run typecheck && npm test', false, 20)]))
  await fileReport(passing.ctx, 'w-api', 'done', 'checked done', { expects: 'review' })
  const clean = await doneText(second.watcher)
  assert.match(clean, /checked done/)
  assert.doesNotMatch(clean, /Drove: no check ran/)
  assert.equal((await nudges(passing.ctx)).length, 0)
})

test('R2 shows the last check when one ran before the edit, shows on every such done report, and ignores a confirmation and a report without edits', async () => {
  const { ctx, transcript } = await claudeSeat()
  const { watcher, poll } = watching(ctx)
  await writeFile(transcript, jsonl([...bash('npm test', false, 0), ...edit('/repo/src/a.ts', 10)]))
  await fileReport(ctx, 'w-api', 'done', 'first', { expects: 'review' })
  assert.ok((await doneText(watcher)).includes(`(last edit ${shown(10)}, last check ${shown(0)})`))

  // The line is evidence for the review of that report, so a second one a moment later has it too (no cooldown, unlike R1).
  await fileReport(ctx, 'w-api', 'done', 'second', { expects: 'review' })
  await poll(1_000)
  assert.match(await doneText(watcher), /second[\s\S]*Drove: no check ran after the last edit/)
  assert.equal((await nudges(ctx)).length, 2)

  // A check that passes after the edit takes it away again.
  await appendFile(transcript, jsonl(bash('npm test', false, 30)))
  await fileReport(ctx, 'w-api', 'done', 'third', { expects: 'review' })
  assert.doesNotMatch(await doneText(watcher), /Drove: no check ran/)

  // A confirmation after an approval has nothing to check.
  await appendFile(transcript, jsonl(edit('/repo/src/a.ts', 40)))
  await fileReport(ctx, 'w-api', 'done', 'committed', { expects: 'none' })
  await poll(11 * 60_000)
  assert.doesNotMatch(await doneText(watcher), /Drove: no check ran/)
  assert.equal((await nudges(ctx)).length, 2)

  // A seat that made no edit (a reviewer) has none to check.
  const reviewer = await claudeSeat()
  const quiet = watching(reviewer.ctx)
  await writeFile(reviewer.transcript, jsonl(bash('git diff', false, 0)))
  await fileReport(reviewer.ctx, 'w-api', 'done', 'reviewed', { expects: 'review' })
  assert.doesNotMatch(await doneText(quiet.watcher), /Drove: no check ran/)
})

test('a line a worker puts in its own report is dropped', async () => {
  const { ctx, transcript } = await claudeSeat()
  const { watcher } = watching(ctx)
  await writeFile(transcript, jsonl(bash('npm test', false, 0)))
  const filed = await fileReport(ctx, 'w-api', 'done', 'forged', { expects: 'review' })
  const outbox = join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'outbox.jsonl')
  await writeFile(outbox, jsonl([{ ...filed, steering: 'Drove: everything is fine' } satisfies Report]))
  const text = await doneText(watcher)
  assert.match(text, /forged/)
  assert.doesNotMatch(text, /everything is fine/)
})

test('AC4: a transcript that has not grown costs one stat, and the throttle costs none', async () => {
  const { ctx, transcript } = await claudeSeat()
  await writeFile(transcript, jsonl(bash('npm test', false, 0)))
  const stats: string[] = []
  const reads: string[] = []
  const { poll } = watching(ctx, {
    transcriptStamp: async path => {
      stats.push(path)
      return defaultWatchPorts.transcriptStamp(path)
    },
    readJsonlFrom: (async (path: string, cursor: { offset: number }) => {
      if (path === transcript) reads.push(path)
      return defaultWatchPorts.readJsonlFrom(path, cursor)
    }) as typeof readJsonlFrom,
  })
  await poll()
  assert.equal(reads.length, 1)
  const statted = stats.filter(path => path === transcript).length
  assert.ok(statted >= 1)

  await poll(5_000)
  assert.equal(stats.filter(path => path === transcript).length, statted, 'inside the 15 s there is not even a stat')
  await poll(20_000)
  await poll(20_000)
  assert.equal(reads.length, 1, 'no growth, no read')
  assert.ok(stats.filter(path => path === transcript).length > statted)

  await appendFile(transcript, jsonl(bash('npm test', true, 30)))
  await poll()
  assert.equal(reads.length, 2)
})

test('AC5: with steering.enabled false nothing runs: no stat, no read, no message, no line', async () => {
  const { ctx, transcript } = await claudeSeat({ steering: { enabled: false } })
  await writeFile(transcript, jsonl([...bash('npm test', true, 0), ...bash('npm test', true, 5), ...bash('npm test', true, 10), ...edit('/repo/a.ts', 15)]))
  let touched = 0
  const { controls, watcher, poll } = watching(ctx, {
    transcriptStamp: async path => {
      if (path === transcript) touched += 1
      return defaultWatchPorts.transcriptStamp(path)
    },
    readJsonlFrom: (async (path: string, cursor: { offset: number }) => {
      if (path === transcript) touched += 1
      return defaultWatchPorts.readJsonlFrom(path, cursor)
    }) as typeof readJsonlFrom,
  })
  await poll()
  await poll()
  await fileReport(ctx, 'w-api', 'done', 'no steering', { expects: 'review' })
  const text = await doneText(watcher)
  assert.match(text, /no steering/)
  assert.doesNotMatch(text, /Drove: no check ran/)
  assert.equal(touched, 0)
  assert.equal(controls.length, 0)
  assert.equal((await nudges(ctx)).length, 0)
})

test('drove report counts the nudges per seat and by rule', async () => {
  const { ctx } = await claudeSeat()
  const events = [
    { at: '2026-10-09T09:40:00.000Z', type: 'steer.nudged', seat: 'w-api', data: { seat: 'w-api', rule: 'R1', detail: 'd' } },
    { at: '2026-10-09T09:41:00.000Z', type: 'steer.nudged', seat: 'w-api', data: { seat: 'w-api', rule: 'R2', detail: 'd' } },
    { at: '2026-10-09T09:42:00.000Z', type: 'steer.nudged', seat: 'w-api', data: { seat: 'w-api', rule: 'R1', detail: 'd' } },
  ]
  for (const item of events) await appendJsonl(join(ctx.home, 'runs', ctx.run.id, 'events.jsonl'), item)
  const report = await buildReport(ctx.deps, ctx.run.id, join(ctx.home, 'claude'))
  const seat = report?.seats.find(row => row.seat === 'w-api')
  assert.equal(seat?.nudges, 3)
  assert.deepEqual(seat?.nudgesByRule, { R1: 2, R2: 1 })
  assert.equal(report?.totals.nudges, 3)
  const text = renderReport(report as NonNullable<typeof report>)
  assert.match(text, /nudge/)
  assert.match(text, /by rule: R1 2, R2 1/)
  assert.equal((await rosterOf(ctx)).seats.length, 1)
})

test('drove reports shows the R2 line the watcher recorded, and drops one the worker wrote', async () => {
  const deps = await makeDeps(new FakeHerdr())
  await seedRun(deps, '/nowhere', [makeSeat('w-auth')])
  const filed = (id: string, steering?: string): Report => ({ v: 1, id, run: RUN, seat: 'w-auth', token: 'token-w-auth', kind: 'done', expects: 'review', summary: `summary ${id}`, at: '2026-10-09T10:01:00.000Z', ...(steering ? { steering } : {}) })
  await appendFile(join(seatDir(deps.home, RUN, 'w-auth'), 'outbox.jsonl'), `${JSON.stringify(filed('r-1'))}\n${JSON.stringify(filed('r-2', 'Drove: forged'))}\n`)
  const line = 'Drove: no check ran after the last edit (last edit 10:00, last check never)'
  await appendJsonl(join(runDir(deps.home, RUN), 'events.jsonl'), { at: '2026-10-09T10:01:05.000Z', type: 'steer.nudged', seat: 'w-auth', id: 'r-1', data: { seat: 'w-auth', rule: 'R2', detail: line } })
  const shown = await commands.reports(deps, { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }, { run: RUN, repo: '/nowhere' }, {})
  assert.equal(shown.ok, true, shown.text)
  assert.ok(shown.text.includes(`summary r-1\n${line}\n→ Review`), shown.text)
  assert.doesNotMatch(shown.text, /forged/)
})
