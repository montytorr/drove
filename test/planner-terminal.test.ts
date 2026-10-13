import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import { wakePlanner } from '../src/deliver.ts'
import { loadRun, saveRun, loadRoster } from '../src/roster.ts'
import { markPlannerUnavailable } from '../src/planner.ts'
import { createWatcher } from '../src/watch.ts'
import { eventsOf, fakePorts, fileReport, setup as watchSetup } from './p4-helpers.ts'
import { FakeHerdr, makeDeps, makeRepo, makeSeat, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => { process.env.HERDR_PANE_ID = 'w31:p1' })

for (const terminal of [{ stdin: false, stdout: true }, { stdin: true, stdout: false }]) {
  test(`attached plan refuses non-TTY stdin=${terminal.stdin} stdout=${terminal.stdout} before any side effect`, async () => {
    const fake = new FakeHerdr()
    const deps = await makeDeps(fake)
    deps.terminal = terminal
    const result = await commands.plan(deps, { repo: '/unused', kind: 'claude', cairn: 'BOTHY-22' })
    assert.equal(result.ok, false)
    assert.match(result.text, /drove plan needs a terminal of its own.*--detached/)
    assert.deepEqual(await readdir(deps.home), [])
    assert.deepEqual(fake.calls, [])
  })
}

test('attached up refuses a non-TTY without changing the existing run or roster', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  await seedRun(deps, '/repo', [makeSeat('w-a', { state: 'down' })], { status: 'down' })
  const files = ['run.json', 'roster.json'].map(file => join(deps.home, 'runs', RUN, file))
  const before = await Promise.all(files.map(file => readFile(file, 'utf8')))
  deps.terminal = { stdin: true, stdout: false }
  const result = await commands.up(deps, { repo: '/repo', run: RUN })
  assert.equal(result.ok, false)
  assert.match(result.text, /drove up needs a terminal of its own.*--detached/)
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before)
  assert.deepEqual(fake.calls, [])
})

test('plan and up refuse a pane hosting another agent, including an agent with no known session', async () => {
  for (const sessionId of ['other-session', undefined]) {
    const fake = new FakeHerdr()
    const deps = await makeDeps(fake)
    fake.agents.set('other', { name: 'other', paneId: 'w31:p1', tabId: 'w31:t1', kind: 'claude', status: 'idle', sessionId })
    const result = await commands.plan(deps, { repo: '/unused', kind: 'claude' })
    assert.equal(result.ok, false)
    assert.match(result.text, /pane w31:p1 already hosts another agent.*--detached/)
    assert.deepEqual(await readdir(deps.home), [])
    const run = await seedRun(deps, '/repo', [], { status: 'down' })
    const resumed = await commands.up(deps, { repo: '/repo', run: RUN })
    assert.equal(resumed.ok, false)
    assert.match(resumed.text, /already hosts another agent.*--detached/)
    assert.deepEqual(await loadRun(deps.home, RUN), run)
    assert.equal(fake.herdrCalls().includes('agent start'), false)
  }
})

test('a pane reserved by another live run is refused even before herdr recognises its agent', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  const run = await seedRun(deps, '/repo', [], { planner: { kind: 'claude', paneId: 'w31:p1', sessionId: 'existing', model: '', effort: 'high', viaMod: false } })
  const result = await commands.plan(deps, { repo: '/unused', kind: 'codex' })
  assert.equal(result.ok, false)
  assert.match(result.text, /planner pane of live run.*--detached/)
  assert.deepEqual(await readdir(join(deps.home, 'runs')), [run.id])
})

test('detached plan works from a non-TTY inside another agent and gives the planner its own pane', async () => {
  const fake = new FakeHerdr({ startSession: 'new-planner-session' })
  const deps = await makeDeps(fake)
  deps.terminal = { stdin: false, stdout: false }
  fake.agents.set('other', { name: 'other', paneId: 'w31:p1', tabId: 'w31:t1', kind: 'claude', status: 'working', sessionId: 'other-session' })
  const result = await commands.plan(deps, { repo: await makeRepo(), kind: 'claude', goal: 'Do the task', detached: true })
  assert.equal(result.ok, true, result.text)
  assert.ok(fake.herdrCalls().includes('workspace create'))
  const start = fake.find('herdr', 'agent', 'start')!
  assert.notEqual(start[start.indexOf('--pane') + 1], 'w31:p1')
  assert.equal(fake.seatAgent('other')?.sessionId, 'other-session')
})

test('a planner session mismatch immediately before paste keeps the report pending and raises one attention across restarts', async () => {
  const ctx = await watchSetup({ planner: { kind: 'claude' }, respond: argv => argv[2] === 'get' ? { stdout: JSON.stringify({ result: { agent: { pane_id: 'p-planner', agent_status: 'idle', agent_session: { value: 'other-session' } } } }) } : {} })
  // The poll still sees the old session: delivery must probe again before pasting.
  const { ports, titles } = fakePorts({ agents: () => [{ paneId: 'p-planner', status: 'idle', sessionId: ctx.run.planner.sessionId }] })
  await fileReport(ctx, 'w-api', 'question', 'which schema?')
  const first = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await first.tick()
  for (let i = 0; i < 5; i++) { ctx.clock.advance(6000); await first.tick() }
  first.stop()
  const saved = (await loadRun(ctx.home, ctx.run.id))!
  assert.match(saved.planner.unavailable?.detail ?? '', /agent_session other-session, expected thread-1.*drove up --run drove-test/)
  const second = createWatcher(ctx.deps, saved, { ports, loop: false })
  await second.tick()
  ctx.clock.advance(20000)
  await second.tick()
  const events = await eventsOf(ctx)
  assert.equal(events.filter(event => event.type === 'attention' && event.seat === 'planner').length, 1)
  assert.equal(events.filter(event => event.type === 'report.delivered').length, 0)
  assert.ok(events.some(event => event.type === 'report.pending'))
  assert.equal(ctx.calls.filter(argv => argv[2] === 'prompt').length, 0)
  assert.match(await second.piggyback('ok'), /which schema\?/)
  assert.deepEqual(titles, [], 'the watcher must not change another agent’s title after detecting a mismatch')
  second.stop()
})

test('the direct planner delivery path also refuses a changed session', async () => {
  const ctx = await watchSetup({ planner: { kind: 'claude' }, respond: argv => argv[2] === 'get' ? { stdout: JSON.stringify({ result: { agent: { pane_id: 'p-planner', agent_status: 'idle', agent_session: { value: 'other' } } } }) } : {} })
  const report = await fileReport(ctx, 'w-api', 'done', 'done')
  await wakePlanner(ctx.deps, ctx.run, [report])
  ctx.clock.advance(6000)
  const result = await wakePlanner(ctx.deps, ctx.run, [report])
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.queued, true)
  assert.equal(ctx.calls.filter(argv => argv[2] === 'prompt').length, 0)
  assert.equal((await eventsOf(ctx)).filter(event => event.type === 'attention').length, 1)
})

test('attached planner exit is saved as gone with one immediate attention, and a stale exit cannot affect a replacement', async () => {
  const ctx = await watchSetup()
  const run = { ...ctx.run, planner: { ...ctx.run.planner, launchId: 'first' } }
  await saveRun(ctx.home, run)
  await Promise.all([commands.attachedPlannerExited(ctx.deps, run), commands.attachedPlannerExited(ctx.deps, run)])
  let saved = (await loadRun(ctx.home, run.id))!
  assert.match(saved.planner.unavailable?.detail ?? '', /the planner exited; run `drove up --run drove-test`/)
  const attention = await commands.attention(ctx.deps, { run: run.id, repo: run.repo }, true)
  assert.equal(attention.ok, true, attention.text)
  assert.match(attention.text, /the planner exited/)
  assert.equal((await eventsOf(ctx)).filter(event => event.type === 'attention').length, 1)
  saved = { ...saved, planner: { ...saved.planner, launchId: 'replacement', unavailable: undefined } }
  await saveRun(ctx.home, saved)
  await commands.attachedPlannerExited(ctx.deps, run)
  assert.equal((await loadRun(ctx.home, run.id))?.planner.unavailable, undefined)
  await saveRun(ctx.home, { ...saved, status: 'down' })
  await markPlannerUnavailable(ctx.deps, saved, 'should not raise')
  assert.equal((await eventsOf(ctx)).filter(event => event.type === 'attention').length, 1)
})

test('up relaunches a marked-gone planner while keeping existing live workers', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  const repo = await makeRepo()
  const worker = makeSeat('w-a', { paneId: 'w1:p2', sessionId: 'worker-session' })
  const run = await seedRun(deps, repo, [worker], { tabId: 'w1:t2' })
  fake.agents.set('w-a', { name: 'w-a', paneId: 'w1:p2', tabId: 'w1:t2', status: 'working', sessionId: 'worker-session' })
  await commands.attachedPlannerExited(deps, run)
  const result = await commands.up(deps, { repo, run: run.id })
  assert.equal(result.ok, true, result.text)
  assert.equal((await loadRun(deps.home, run.id))?.planner.unavailable, undefined)
  assert.equal((await loadRun(deps.home, run.id))?.planner.paneId, 'w31:p1')
  assert.equal((await loadRun(deps.home, run.id))?.tabId, 'w1:t2')
  assert.deepEqual((await loadRoster(deps.home, run.id)).seats, [worker])
  assert.equal(fake.herdrCalls().includes('agent start'), false, 'the attached planner is returned for the CLI to launch; workers stay alive')
})

test('detached recovery treats a live planner pane hosting another session as gone', async () => {
  const fake = new FakeHerdr({ startSession: 'planner-session' })
  const deps = await makeDeps(fake)
  deps.terminal = { stdin: false, stdout: false }
  const run = await seedRun(deps, await makeRepo())
  fake.agents.set('other', { name: 'other', kind: 'claude', paneId: run.planner.paneId!, tabId: 'w1:t0', status: 'working', sessionId: 'unrelated-session' })
  const result = await commands.up(deps, { run: run.id, repo: run.repo }, undefined, { detached: true })
  assert.equal(result.ok, true, result.text)
  const start = fake.find('herdr', 'agent', 'start')!
  assert.equal(start[start.indexOf('--resume') + 1], run.planner.sessionId)
  assert.notEqual(start[start.indexOf('--pane') + 1], run.planner.paneId)
  assert.equal(fake.seatAgent('other')?.sessionId, 'unrelated-session')
  assert.equal(fake.prompts.filter(prompt => prompt.target === run.planner.paneId).length, 0)
})

for (const mismatched of [false, true]) {
  test(`detached recovery relaunches only a ${mismatched ? 'mismatched' : 'missing'} planner with its saved session and leaves live seats untouched`, async () => {
    const fake = new FakeHerdr({ startSession: 'planner-session' })
    const deps = await makeDeps(fake)
    deps.terminal = { stdin: false, stdout: false }
    const workers = [makeSeat('w-a', { paneId: 'w1:p2', sessionId: 'worker-a', state: 'working' }), makeSeat('w-b', { paneId: 'w1:p3', sessionId: 'worker-b', state: 'idle' })]
    const run = await seedRun(deps, await makeRepo(), workers, { tabId: 'w1:t2' })
    for (const worker of workers) fake.agents.set(worker.name, { name: worker.name, paneId: worker.paneId!, tabId: 'w1:t2', status: worker.state as 'working' | 'idle', sessionId: worker.sessionId })
    if (mismatched) fake.agents.set('other', { name: 'other', paneId: run.planner.paneId!, tabId: 'w1:t0', status: 'idle', sessionId: 'other-session' })
    const result = await commands.up(deps, { run: run.id, repo: run.repo }, undefined, { detached: true, json: true })
    assert.equal(result.ok, true, result.text)
    const starts = fake.calls.filter(argv => argv[1] === 'agent' && argv[2] === 'start')
    assert.equal(starts.length, 1)
    assert.equal(starts[0]![starts[0]!.indexOf('--resume') + 1], run.planner.sessionId)
    assert.deepEqual((await loadRoster(deps.home, run.id)).seats, workers)
    assert.equal((await loadRun(deps.home, run.id))?.tabId, 'w1:t2')
    const resultData = JSON.parse(result.text)
    assert.deepEqual(resultData.resumed, [])
    assert.equal((await loadRun(deps.home, run.id))?.workspace, resultData.workspace)
    for (const worker of workers) assert.equal(fake.seatAgent(worker.name)?.paneId, worker.paneId)
    assert.equal(fake.calls.some(argv => argv[1] === 'pane' && argv[2] === 'close'), false)
    assert.equal(fake.prompts.length, 0)
  })
}

test('planner paste retries validate the session again after a busy refusal', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  let attempts = 0
  fake.exec = async (argv, options) => {
    if (argv[0] === 'herdr' && argv[2] === 'prompt') {
      attempts++
      fake.seatAgent('planner')!.sessionId = 'replacement'
      return { code: 1, stdout: '', stderr: JSON.stringify({ error: { code: 'agent_pane_busy' } }) }
    }
    return base(argv, options)
  }
  const deps = await makeDeps(fake)
  const run = await seedRun(deps, '/repo')
  fake.agents.set('planner', { name: 'planner', paneId: run.planner.paneId!, tabId: 'w1:t0', status: 'idle', sessionId: run.planner.sessionId })
  const ctx = await watchSetup()
  const report = await fileReport(ctx, 'w-api', 'done', 'done')
  await wakePlanner(deps, run, [report])
  deps.clock.advance(6000)
  const result = await wakePlanner(deps, run, [report])
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.queued, true)
  assert.equal(attempts, 1, 'the retry must not reach the replacement session')
  assert.match((await loadRun(deps.home, run.id))?.planner.unavailable?.detail ?? '', /agent_session replacement/)
})
