import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { nodeExec } from '../src/commands.ts'
import { acquireBridge, attach, EXIT, report, runBridge } from '../src/modhost.ts'
import type { BridgeIo, BridgeLine } from '../src/modhost.ts'
import { plannerDir, seatDir } from '../src/paths.ts'
import { loadRoster, loadRun, saveRun, updateRoster } from '../src/roster.ts'
import { appendJsonl, readJson, readJsonlFrom, writeJsonAtomic } from '../src/store.ts'
import type { Deps, Report } from '../src/types.ts'
import type { WatchOptions } from '../src/watch.ts'
import { makeClock, setup } from './p4-helpers.ts'

const gitRepo = async (): Promise<string> => {
  const repo = await mkdtemp(join(tmpdir(), 'drove-mod-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  return execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel']).toString().trim()
}

// Real git, but no real cairn: attach looks for Cairn (DROVE-159), and a test must not reach the user's instance.
const realDeps = async (): Promise<Deps> => ({ exec: async (argv, options) => (argv[0] === 'cairn' ? { code: 127, stdout: '', stderr: 'not found' } : nodeExec(argv, options)), clock: makeClock(), home: await mkdtemp(join(tmpdir(), 'drove-mod-home-')) })

test('attach creates a viaMod run with this session as the Claude planner, and re-attaches the same session', async () => {
  const deps = await realDeps()
  const repo = await gitRepo()
  const first = await attach(deps, { repo, sessionId: 's-1', paneId: 'w1:p1', goal: 'ship it', budget: 4 })
  assert.equal(first.ok, true)
  const run = (first.ok ? (first.data as { run: { id: string } }).run : undefined)!
  const saved = await loadRun(deps.home, run.id)
  assert.equal(saved?.planner.viaMod, true)
  assert.equal(saved?.planner.kind, 'claude')
  assert.equal(saved?.planner.sessionId, 's-1')
  assert.equal(saved?.planner.paneId, 'w1:p1')
  assert.equal(saved?.goal, 'ship it')
  assert.equal(saved?.budget, 4)
  assert.equal(saved?.base, 'main')

  const again = await attach(deps, { repo, sessionId: 's-1', paneId: 'w1:p7' })
  assert.equal(again.ok && (again.data as { run: { id: string } }).run.id, run.id)
  assert.equal((await loadRun(deps.home, run.id))?.planner.paneId, 'w1:p7')
  assert.equal((await loadRun(deps.home, run.id))?.goal, 'ship it')

  const other = await attach(deps, { repo, sessionId: 's-2', paneId: 'w1:p9' })
  assert.notEqual(other.ok && (other.data as { run: { id: string } }).run.id, run.id)
})

test('attach refuses a down run, a session outside herdr and a folder outside git', async () => {
  const deps = await realDeps()
  const repo = await gitRepo()
  const made = await attach(deps, { repo, sessionId: 's-1', paneId: 'w1:p1' })
  const id = made.ok ? (made.data as { run: { id: string } }).run.id : ''
  const run = await loadRun(deps.home, id)
  await saveRun(deps.home, { ...run!, status: 'down' })
  const down = await attach(deps, { repo, sessionId: 's-1', paneId: 'w1:p1', run: id })
  assert.equal(down.ok ? '' : down.code, 'run-down')

  const pane = process.env.HERDR_PANE_ID
  delete process.env.HERDR_PANE_ID
  try {
    const outside = await attach(deps, { repo, sessionId: 's-1' })
    assert.equal(outside.ok ? '' : outside.code, 'not-in-herdr')
  } finally {
    if (pane !== undefined) process.env.HERDR_PANE_ID = pane
  }
  const notGit = await attach(deps, { repo: await mkdtemp(join(tmpdir(), 'drove-nogit-')), sessionId: 's-1', paneId: 'w1:p1' })
  assert.equal(notGit.ok ? '' : notGit.code, 'not-a-repo')
})

test('report stamps a worker report into its outbox and refuses a planner', async () => {
  const ctx = await setup()
  const worker = { home: ctx.home, run: ctx.run.id, role: 'worker' as const, seat: 'w-api', token: ctx.tokens['w-api'] }
  const done = await report(ctx.deps, worker, { kind: 'question', summary: 'which table?', for: 'human' })
  assert.equal(done.ok, true)
  const [line] = (await readJsonlFrom<Report>(join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'outbox.jsonl'), { offset: 0 })).items
  assert.equal(line?.kind, 'question')
  assert.equal(line?.for, 'human')
  assert.equal(line?.token, 'token-w-api')
  const bad = await report(ctx.deps, worker, { kind: 'nope', summary: 'x' })
  assert.equal(bad.ok ? '' : bad.code, 'report')
  const planner = await report(ctx.deps, { ...worker, role: 'planner', seat: 'planner' }, { kind: 'done', summary: 'x' })
  assert.equal(planner.ok ? '' : planner.code, 'forbidden')
})

type FakeIo = BridgeIo & { lines: BridgeLine[]; alive: Set<number>; killed: [number, string][]; parent: number }

const fakeIo = (pid: number, onSleep: (io: FakeIo) => void = () => {}): FakeIo => {
  const io: FakeIo = {
    lines: [],
    alive: new Set([pid]),
    killed: [],
    parent: 1000,
    pid,
    write: line => (io.lines.push(line), true),
    ppid: () => io.parent,
    isAlive: candidate => io.alive.has(candidate),
    kill: (candidate, signal) => {
      io.killed.push([candidate, signal])
      io.alive.delete(candidate)
    },
    sleep: async () => onSleep(io),
  }
  return io
}

test('the bridge lock replaces a leftover bridge of the same session and stands down for another session', async () => {
  const ctx = await setup()
  const old = { pid: 41, sessionId: 's-1', startedAt: 'x' }
  await writeJsonAtomic(join(plannerDir(ctx.home, ctx.run.id), 'bridge.json'), old)
  const io = fakeIo(42)
  io.alive.add(41)
  assert.deepEqual(await acquireBridge(ctx.deps, ctx.run.id, { pid: 42, sessionId: 's-1', startedAt: 'y' }, io), { ok: true })
  assert.deepEqual(io.killed, [[41, 'SIGTERM']])

  const other = fakeIo(43)
  other.alive.add(42)
  const busy = await acquireBridge(ctx.deps, ctx.run.id, { pid: 43, sessionId: 's-2', startedAt: 'z' }, other)
  assert.equal(busy.ok, false)
  assert.deepEqual(other.killed, [])

  other.alive.delete(42)
  assert.deepEqual(await acquireBridge(ctx.deps, ctx.run.id, { pid: 43, sessionId: 's-2', startedAt: 'z' }, other), { ok: true })
})

test('the bridge lock never signals pid 0, the marker a released bridge leaves behind', async () => {
  const ctx = await setup()
  await writeJsonAtomic(join(plannerDir(ctx.home, ctx.run.id), 'bridge.json'), { pid: 0, sessionId: 's-1', startedAt: 'x' })
  const io = fakeIo(42)
  io.alive.add(0)
  assert.deepEqual(await acquireBridge(ctx.deps, ctx.run.id, { pid: 42, sessionId: 's-1', startedAt: 'y' }, io), { ok: true })
  assert.deepEqual(io.killed, [])
})

const modRun = async () => setup({ planner: { kind: 'claude', viaMod: true, sessionId: 's-1', paneId: 'w1:p1' } })

test('the bridge carries detected agents and refreshes default model labels without changing stored seats', async () => {
  const ctx = await modRun()
  const agents = { at: ctx.clock.now().toISOString(), codex: { version: '0.162.0', model: 'first-default' } }
  await saveRun(ctx.home, { ...ctx.run, agents })
  await updateRoster(ctx.home, ctx.run.id, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, model: '' })) }))
  let loops = 0
  const io = fakeIo(63, async current => {
    loops += 1
    if (loops === 1) await saveRun(ctx.home, { ...ctx.run, agents: { ...agents, codex: { ...agents.codex, model: 'next-default' } } })
    if (loops === 2) current.parent = 1
  })
  const code = await runBridge(ctx.deps, ctx.run.id, { sessionId: 's-1', watch: (() => ({ stop: () => {} })) as never }, io, new AbortController().signal)
  assert.equal(code, EXIT.ok)
  const labels = io.lines.flatMap(line => line.t === 'roster' ? [line.roster.seats[0]?.model] : [])
  assert.deepEqual(labels, ['first-default', 'next-default'])
  const runs = io.lines.flatMap(line => line.t === 'run' ? [line.run.agents?.codex?.model] : [])
  assert.deepEqual(runs, labels)
  assert.equal((await loadRoster(ctx.home, ctx.run.id)).seats[0]?.model, '')
})

test('the bridge streams the run, the roster with mod status, events and wakes, then stops when its parent goes', async () => {
  const ctx = await modRun()
  await appendJsonl(join(ctx.home, 'runs', ctx.run.id, 'events.jsonl'), { at: 'a', type: 'run.up' })
  await writeJsonAtomic(join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'mod.json'), { ctx: 42, activity: 'editing a.ts' })
  let wake: WatchOptions['modWake']
  let stopped = false
  const watch = ((_deps: Deps, _run: unknown, options: WatchOptions = {}) => {
    wake = options.modWake
    return { tick: async () => {}, takePending: async () => [], piggyback: async (text: string) => text, start: () => {}, stop: () => void (stopped = true) }
  }) as never
  let loops = 0
  const io = fakeIo(50, async current => {
    loops += 1
    if (loops === 1) {
      await wake?.('[worker w-api · done · expects review]')
      await appendJsonl(join(ctx.home, 'runs', ctx.run.id, 'events.jsonl'), { at: 'b', type: 'report', seat: 'w-api' })
    }
    if (loops === 3) current.parent = 1
  })
  const code = await runBridge(ctx.deps, ctx.run.id, { sessionId: 's-1', watch }, io, new AbortController().signal)
  assert.equal(code, EXIT.ok)
  assert.equal(stopped, true)
  const types = io.lines.map(line => line.t)
  assert.deepEqual(types.slice(0, 2), ['ready', 'events'])
  assert.ok(types.includes('run'))
  const roster = io.lines.find(line => line.t === 'roster')
  assert.equal(roster?.t === 'roster' && roster.status['w-api']?.ctx, 42)
  assert.deepEqual(io.lines.filter(line => line.t === 'wake'), [{ t: 'wake', text: '[worker w-api · done · expects review]' }])
  const later = io.lines.filter(line => line.t === 'events' && !line.isInitial)
  assert.equal(later.length, 1)
  assert.equal(io.lines.filter(line => line.t === 'roster').length, 1)
  assert.equal((await readJson<{ pid: number }>(join(plannerDir(ctx.home, ctx.run.id), 'bridge.json')))?.pid, 0)
})

test('the bridge stands down when another session holds the run, refuses a run not attached to it, and detaches when re-attached elsewhere', async () => {
  const ctx = await modRun()
  await writeJsonAtomic(join(plannerDir(ctx.home, ctx.run.id), 'bridge.json'), { pid: 77, sessionId: 's-other', startedAt: 'x' })
  const io = fakeIo(60)
  io.alive.add(77)
  assert.equal(await runBridge(ctx.deps, ctx.run.id, { sessionId: 's-1', watch: (() => ({ stop: () => {} })) as never }, io, new AbortController().signal), EXIT.busy)
  assert.deepEqual(io.lines, [{ t: 'busy', pid: 77, sessionId: 's-other' }])

  const wrong = fakeIo(61)
  assert.equal(await runBridge(ctx.deps, ctx.run.id, { sessionId: 's-9', watch: (() => ({ stop: () => {} })) as never }, wrong, new AbortController().signal), EXIT.fatal)
  assert.equal(wrong.lines[0]?.t, 'fatal')

  io.alive.delete(77)
  const moved = fakeIo(62, async () => {
    const run = await loadRun(ctx.home, ctx.run.id)
    await saveRun(ctx.home, { ...run!, planner: { ...run!.planner, sessionId: 's-2' } })
  })
  assert.equal(await runBridge(ctx.deps, ctx.run.id, { sessionId: 's-1', watch: (() => ({ stop: () => {} })) as never }, moved, new AbortController().signal), EXIT.detached)
})

test('attach keeps a re-attached run\'s saved useCairn and never looks for cairn again; a new run is detected (DROVE-159)', async () => {
  const deps = await realDeps()
  const repo = await gitRepo()
  const first = await attach(deps, { repo, sessionId: 's-1', paneId: 'w1:p1' })
  const id = (first.ok ? (first.data as { run: { id: string } }).run.id : '')
  assert.equal((await loadRun(deps.home, id))?.useCairn, false, 'no cairn on this fake host')
  const cairnCalls: string[][] = []
  const installed: Deps = { ...deps, exec: async (argv, options) => (argv[0] === 'cairn' ? (cairnCalls.push([...argv]), { code: 0, stdout: 'cairn 0.22.3', stderr: '' }) : deps.exec(argv, options)) }
  const again = await attach(installed, { repo, sessionId: 's-1', paneId: 'w1:p7' })
  assert.equal(again.ok && (again.data as { run: { id: string } }).run.id, id)
  assert.equal((await loadRun(deps.home, id))?.useCairn, false)
  assert.deepEqual(cairnCalls.filter(call => call[1] === '--version'), [])
})
