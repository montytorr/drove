import assert from 'node:assert/strict'
import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { loadRoster, loadRun } from '../src/roster.ts'
import type { DetachedStart, ExecResult, Identity } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const stubCairn = (fake: FakeHerdr, tasks: Record<string, { title: string; status: string; description?: string }>, next: string[] = []) => {
  const base = fake.exec
  fake.exec = async (argv, options) => {
    if (argv[0] !== 'cairn') return base(argv, options)
    const reply = (stdout: string, code = 0, stderr = ''): ExecResult => ({ code, stdout, stderr })
    const [, verb, ref] = argv
    if (verb === 'show') {
      const task = ref ? tasks[ref] : undefined
      return task ? reply(JSON.stringify({ ref, ...task })) : reply('', 1, `No task ${ref}.\n`)
    }
    if (verb === 'next') return reply(JSON.stringify({ pick: next[0] ? { ref: next[0], title: tasks[next[0]]?.title } : null }))
    return reply('')
  }
}

const startOf = (fake: FakeHerdr, name: string): string[] => fake.calls.find(call => call[1] === 'agent' && call[2] === 'start' && call[3]?.startsWith(name)) ?? []
const flag = (argv: readonly string[], name: string): string | undefined => argv[argv.indexOf(name) + 1]

test('drove plan --detached opens its own workspace and starts the planner there, with no pane env', async () => {
  assert.equal(process.env.HERDR_PANE_ID, undefined)
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  const repo = await realpath(await makeRepo())

  const planned = await commands.plan(deps, { repo, kind: 'claude', goal: 'Ship the widget.', detached: true, json: true })
  assert.equal(planned.ok, true, planned.text)
  const data = JSON.parse(planned.text) as DetachedStart
  assert.equal(data.status, 'up')
  assert.equal(data.repo, repo)
  assert.equal(data.workspace, 'w2')
  assert.equal(data.planner.pane, 'w2:p1')
  assert.equal(data.planner.kind, 'claude')
  assert.equal(data.planner.state, 'working')
  assert.match(data.planner.name, /^planner-[0-9a-f]{4}$/)
  assert.equal(data.goal, 'Ship the widget.')
  assert.equal(planned.ok && (planned.data as { argv?: unknown }).argv, undefined, 'nothing is left for the caller to launch')

  const order = fake.herdrCalls()
  assert.ok(order.indexOf('workspace list') < order.indexOf('workspace create'))
  assert.ok(order.indexOf('workspace create') < order.indexOf('agent start'))
  const created = fake.find('herdr', 'workspace', 'create') ?? []
  assert.equal(flag(created, '--cwd'), repo)
  assert.ok(created.includes('--no-focus'))
  assert.match(flag(created, '--label') ?? '', /^drove · .+ · [0-9a-f]{4}$/)
  assert.ok(created.includes(`DROVE_RUN=${data.run}`))
  assert.ok(created.includes('DROVE_ROLE=planner'))
  const start = startOf(fake, 'planner')
  assert.equal(start[3], data.planner.name)
  assert.equal(flag(start, '--kind'), 'claude')
  assert.equal(flag(start, '--pane'), 'w2:p1')
  assert.ok(start.includes('--session-id'))
  assert.equal(start.at(-1), 'Ship the widget.')
  assert.equal(fake.prompts.length, 0)

  const run = await loadRun(deps.home, data.run)
  assert.equal(run?.status, 'up')
  assert.equal(run?.planner.paneId, 'w2:p1')
  assert.equal(run?.planner.sessionId, data.planner.sessionId)
})

test('drove plan --detached --from-cairn starts the planner on the task, typing the goal when it cannot ride in the launch line', async () => {
  const fake = new FakeHerdr()
  stubCairn(fake, { 'DROVE-5': { title: 'Detach the planner', status: 'todo', description: 'Line one.\nLine two.' } })
  const deps = await makeDeps(fake)
  const repo = await makeRepo()

  const planned = await commands.plan(deps, { repo, kind: 'claude', cairn: 'DROVE-5', detached: true, json: true })
  assert.equal(planned.ok, true, planned.text)
  const data = JSON.parse(planned.text) as DetachedStart
  assert.equal(data.cairn, 'DROVE-5')
  assert.equal(data.goal, 'DROVE-5: Detach the planner')
  assert.ok(!startOf(fake, 'planner').some(arg => /Line one/.test(arg)), 'a multi-line goal is not in the launch line')
  assert.equal(fake.prompts.length, 1)
  assert.equal(fake.prompts[0]?.target, data.planner.pane)
  assert.match(fake.prompts[0]?.text ?? '', /DROVE-5[\s\S]*Line two\./)
})

test('drove plan --detached --next picks the top task of the project', async () => {
  const fake = new FakeHerdr()
  stubCairn(fake, { 'DROVE-7': { title: 'Top of the queue', status: 'todo' } }, ['DROVE-7'])
  const deps = await makeDeps(fake)

  const planned = await commands.plan(deps, { repo: await makeRepo(), kind: 'codex', next: 'DROVE', detached: true, json: true })
  assert.equal(planned.ok, true, planned.text)
  const data = JSON.parse(planned.text) as DetachedStart
  assert.equal(data.cairn, 'DROVE-7')
  assert.equal(data.planner.kind, 'codex')
  assert.equal(flag(startOf(fake, 'planner'), '--kind'), 'codex')
})

test('drove plan --detached refuses when the herdr server is not running, and starts nothing', async () => {
  const fake = new FakeHerdr()
  fake.serverDown = true
  const deps = await makeDeps(fake)

  const planned = await commands.plan(deps, { repo: await makeRepo(), kind: 'claude', goal: 'x', detached: true, json: true })
  assert.equal(planned.ok, false)
  assert.equal(!planned.ok && planned.code, 'herdr-down')
  assert.match(planned.text, /does not start one/)
  assert.deepEqual(fake.herdrCalls(), ['workspace list'])
  assert.deepEqual(await readdir(join(deps.home, 'runs')).catch(() => []), [])
})

test('drove plan without --detached still needs a herdr pane', async () => {
  const fake = new FakeHerdr()
  const planned = await commands.plan(await makeDeps(fake), { repo: await makeRepo(), kind: 'claude', goal: 'x' })
  assert.equal(!planned.ok && planned.code, 'not-in-herdr')
  assert.match(planned.text, /--detached/)
  assert.deepEqual(fake.herdrCalls(), [])
})

test('a detached planner that stops on a startup dialog is reported as blocked, not as a failure', async () => {
  const fake = new FakeHerdr({ startFails: 'agent_not_ready' })
  fake.screen = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed'
  const deps = await makeDeps(fake)

  const planned = await commands.plan(deps, { repo: await makeRepo(), kind: 'claude', goal: 'x', detached: true, json: true })
  assert.equal(planned.ok, true, planned.text)
  const data = JSON.parse(planned.text) as DetachedStart
  assert.equal(data.planner.state, 'blocked')
  assert.equal(data.planner.attention?.reason, 'trust')
  assert.equal((await loadRun(deps.home, data.run))?.planner.paneId, data.planner.pane)
})

test('a detached start that cannot open a workspace marks the new run down and says so', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  fake.exec = async (argv, options) => (argv[1] === 'workspace' && argv[2] === 'create' ? { code: 1, stdout: '', stderr: JSON.stringify({ error: { code: 'workspace_create_failed', message: 'no room' } }) } : base(argv, options))
  const deps = await makeDeps(fake)

  const planned = await commands.plan(deps, { repo: await makeRepo(), kind: 'claude', goal: 'x', detached: true })
  assert.equal(!planned.ok && planned.code, 'herdr')
  assert.match(planned.text, /was left down; drove up --run .* --detached tries it again/)
  const [name] = await readdir(join(deps.home, 'runs'))
  assert.equal((await loadRun(deps.home, name ?? ''))?.status, 'down')
})

test('drove up --detached resumes the seats and the planner in a workspace of its own', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-1' })
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo)
  const identity: Identity = { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }
  process.env.HERDR_PANE_ID = 'w1:p0'
  const spawned = await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief: 'Build the widget.' })
  assert.equal(spawned.ok, true, spawned.text)
  fake.setStatus('w-a', 'idle')
  const downed = await commands.down(deps, { run: RUN, repo })
  assert.equal(downed.ok, true, downed.text)
  delete process.env.HERDR_PANE_ID
  const before = fake.calls.length

  const upped = await commands.up(deps, { run: RUN, repo }, undefined, { detached: true, json: true })
  assert.equal(upped.ok, true, upped.text)
  const data = JSON.parse(upped.text) as DetachedStart
  assert.equal(data.run, RUN)
  assert.equal(data.status, 'up')
  assert.equal(data.workspace, 'w2')
  assert.deepEqual(data.resumed, ['w-a'])
  assert.deepEqual(data.lost, [])
  const calls = fake.calls.slice(before)
  const kinds = calls.filter(call => call[1] === 'workspace' || (call[1] === 'agent' && call[2] === 'start')).map(call => call.slice(1, 3).join(' '))
  assert.deepEqual(kinds.filter(kind => kind !== 'workspace list'), ['workspace create', 'agent start', 'agent start'])
  const seatStart = calls.find(call => call[2] === 'start' && call[3]?.startsWith('w-a'))
  assert.ok(seatStart?.includes('--resume'))
  const plannerStart = calls.find(call => call[2] === 'start' && call[3]?.startsWith('planner'))
  assert.equal(flag(plannerStart ?? [], '--pane'), data.planner.pane)
  assert.ok(plannerStart?.includes('--resume'))
  assert.equal(flag(plannerStart ?? [], '--resume'), 'planner-session')
  const created = calls.find(call => call[1] === 'tab' && call[2] === 'create')
  assert.equal(flag(created ?? [], '--workspace'), 'w2', 'the seat opens its tab in the planner workspace')
  const run = await loadRun(deps.home, RUN)
  assert.deepEqual([run?.status, run?.planner.paneId], ['up', data.planner.pane])
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats.map(seat => seat.state), ['working'])
})

test('drove up --detached refuses when the herdr server is not running', async () => {
  const fake = new FakeHerdr()
  fake.serverDown = true
  const deps = await makeDeps(fake)
  await seedRun(deps, await makeRepo(), [], { status: 'down' })

  const upped = await commands.up(deps, { run: RUN, repo: '/x' }, undefined, { detached: true })
  assert.equal(!upped.ok && upped.code, 'herdr-down')
  assert.equal((await loadRun(deps.home, RUN))?.status, 'down')
})

test('drove up --detached does not combine with --seat', async () => {
  const deps = await makeDeps(new FakeHerdr())
  const upped = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a', { detached: true })
  assert.equal(!upped.ok && upped.code, 'usage')
})

test('drove down closes the workspace a detached plan opened and clears it from the run', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  const repo = await realpath(await makeRepo())
  const planned = await commands.plan(deps, { repo, kind: 'claude', goal: 'Ship the widget.', detached: true, json: true })
  assert.equal(planned.ok, true, planned.text)
  const data = JSON.parse(planned.text) as DetachedStart
  assert.equal((await loadRun(deps.home, data.run))?.workspace, data.workspace)
  assert.ok(fake.workspaces.has(data.workspace))

  const downed = await commands.down(deps, { run: data.run, repo })
  assert.equal(downed.ok, true, downed.text)
  assert.deepEqual(fake.find('herdr', 'workspace', 'close'), ['herdr', 'workspace', 'close', data.workspace])
  assert.equal(fake.workspaces.has(data.workspace), false)
  const run = await loadRun(deps.home, data.run)
  assert.deepEqual([run?.status, run?.workspace], ['down', undefined])
})

test('drove down closes no workspace for a run that was not started detached', async () => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  await seedRun(deps, await makeRepo())
  const downed = await commands.down(deps, { run: RUN, repo: '/x' })
  assert.equal(downed.ok, true, downed.text)
  assert.equal(fake.find('herdr', 'workspace', 'close'), undefined)
})

test('drove up --detached records the new workspace, and down closes that one', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-1' })
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo, [], { status: 'down' })
  const upped = await commands.up(deps, { run: RUN, repo }, undefined, { detached: true, json: true })
  assert.equal(upped.ok, true, upped.text)
  const data = JSON.parse(upped.text) as DetachedStart
  assert.equal((await loadRun(deps.home, RUN))?.workspace, data.workspace)

  const downed = await commands.down(deps, { run: RUN, repo })
  assert.equal(downed.ok, true, downed.text)
  assert.deepEqual(fake.find('herdr', 'workspace', 'close'), ['herdr', 'workspace', 'close', data.workspace])
  assert.equal((await loadRun(deps.home, RUN))?.workspace, undefined)
})
