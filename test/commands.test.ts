import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { agentName } from '../src/herdr.ts'
import { seatDir } from '../src/paths.ts'
import { deriveState } from '../src/detect.ts'
import { approvedText } from '../src/prompts.ts'
import { parseEnvelope } from '../src/protocol.ts'
import { loadRoster, loadRun, updateRoster } from '../src/roster.ts'
import type { Deps, Identity, RunMeta } from '../src/types.ts'
import { FakeHerdr, git, makeDeps, makeRepo, makeSeat, RUN, seedRun, tmp } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const planner = (deps: Deps): Identity => ({ home: deps.home, run: RUN, role: 'planner', seat: 'planner' })

const setup = async (fake = new FakeHerdr(), overrides: Partial<RunMeta> = {}) => {
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  const run = await seedRun(deps, repo, [], overrides)
  return { fake, repo, deps, run, identity: planner(deps) }
}

const brief = 'Build the widget.'

test('spawn opens the tab at the repo root, then starts the agent, which creates its own worktree', async () => {
  const { fake, deps, identity, repo } = await setup()
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerEnv: { WORKER_FLAG: '1' } }))
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', cairn: 'DROVE-5', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const order = fake.calls.map(call => (call[0] === 'git' ? 'git' : call.slice(1, 3).join(' ')))
  assert.ok(order.indexOf('tab create') < order.indexOf('agent start'))
  const worktree = join(repo, '.claude', 'worktrees', 'w-api')
  // Committed policy reads precede launch; worktree inspection waits for Claude to create it.
  assert.ok(fake.calls.findIndex(call => call[0] === 'git' && call.includes(worktree)) > fake.calls.findIndex(call => call[1] === 'agent' && call[2] === 'start'))
  assert.ok(existsSync(worktree))
  assert.equal(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'worktree-w-api')
  assert.equal(await git(repo, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/worktree-w-api'), '')
  assert.equal(await git(repo, 'branch', '--list', 'drove/w-api'), '')
  assert.deepEqual(fake.calls.filter(call => call[0] === 'git' && call.includes('worktree')), [])

  const start = fake.find('herdr', 'agent', 'start') ?? []
  assert.equal(start[3], 'w-api-a3f1')
  assert.equal(start[start.indexOf('--kind') + 1], 'claude')
  assert.equal(start[start.indexOf('--worktree') + 1], 'w-api')
  assert.ok(start.includes('--session-id'))
  assert.match(start.at(-1) ?? '', /^Build the widget\. \(You are worker `w-api` on branch `worktree-w-api`\. Your Cairn task is DROVE-5/)
  assert.equal(fake.prompts.length, 0)
  const tab = fake.find('herdr', 'tab', 'create') ?? []
  assert.equal(tab[tab.indexOf('--cwd') + 1], repo)
  assert.ok(tab.includes('WORKER_FLAG=1'))
  assert.ok(tab.some(arg => arg.startsWith('DROVE_TOKEN=')))
  assert.equal(tab[tab.indexOf('--workspace') + 1], 'w1')

  const roster = await loadRoster(deps.home, RUN)
  assert.equal(roster.seats[0]?.state, 'working')
  assert.equal(roster.seats[0]?.paneId, 'w1:p1')
  assert.equal(roster.seats[0]?.worktree, worktree)
  assert.equal(roster.seats[0]?.branch, 'worktree-w-api')
  assert.equal((await loadRun(deps.home, RUN))?.tabId, 'w1:t1')
  const token = await readFile(join(seatDir(deps.home, RUN, 'w-api'), 'token'), 'utf8')
  const launch = await readFile(join(seatDir(deps.home, RUN, 'w-api'), 'launch.json'), 'utf8')
  assert.ok(!launch.includes(token.trim()))
  assert.equal(JSON.parse(launch).cwd, repo)
  assert.ok(existsSync(join(seatDir(deps.home, RUN, 'w-api'), 'mcp.json')))
})

test('a codex worker still gets a Drove git worktree on drove/<seat> and launches inside it', async () => {
  const { fake, deps, identity, repo } = await setup()
  const spawned = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const worktree = join(repo, '.claude', 'worktrees', 'w-cx')
  assert.equal(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'drove/w-cx')
  assert.ok(fake.calls.some(call => call[0] === 'git' && call.includes('worktree') && call.includes('add')))
  const tab = fake.find('herdr', 'tab', 'create') ?? []
  assert.equal(tab[tab.indexOf('--cwd') + 1], worktree)
  const start = fake.find('herdr', 'agent', 'start') ?? []
  assert.ok(!start.includes('--worktree'))
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.branch, 'drove/w-cx')
})

test('spawn saves the full brief to seats/<seat>/brief.md, mode 600, for both kinds', async () => {
  const { deps, identity } = await setup()
  for (const [seat, kind] of [['w-cl', 'claude'], ['w-cx', 'codex']] as const) {
    const spawned = await commands.spawn(deps, identity, { seat, kind, cairn: 'DROVE-5', brief })
    assert.equal(spawned.ok, true, spawned.text)
    const file = join(seatDir(deps.home, RUN, seat), 'brief.md')
    const saved = await readFile(file, 'utf8')
    assert.match(saved, /Build the widget\. \(You are worker `/)
    assert.match(saved, new RegExp(`You are worker \`${seat}\``))
    assert.match(saved, /Your Cairn task is DROVE-5/)
    assert.equal(saved.startsWith('# Worker mode') || saved.startsWith('Build the widget.'), true, 'Codex carries its role in the brief, Claude does not')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
})

const commitOn = async (repo: string, file: string): Promise<string> => {
  await writeFile(join(repo, file), 'x\n')
  await git(repo, 'add', file)
  await git(repo, 'commit', '-q', '-m', `add ${file}`)
  return git(repo, 'rev-parse', 'HEAD')
}

test('a claude spawn says --base is ignored', async () => {
  const { deps, identity } = await setup()
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, base: 'main' })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /Note: --base main was ignored: Claude creates its own worktree, which Drove then fast-forwards to the run base main/)
})

test('a claude worktree that starts behind local main is fast-forwarded to main before the brief, with a note', async () => {
  const { fake, deps, identity, repo } = await setup()
  const behind = await git(repo, 'rev-parse', 'HEAD')
  const tip = await commitOn(repo, 'b.txt')
  fake.claudeWorktreeFrom = behind
  process.env.DROVE_BRIEF_VIA = 'prompt'
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const worktree = join(repo, '.claude', 'worktrees', 'w-api')
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), tip)
  assert.equal(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'worktree-w-api')
  assert.match(spawned.text, /Note: Claude created worktree-w-api at [0-9a-f]+, behind main; it was fast-forwarded to [0-9a-f]+\./)
  assert.equal(fake.prompts.length, 1)
})

test('a claude worktree already at main is left unchanged and carries no note', async () => {
  const { fake, deps, identity, repo } = await setup()
  const tip = await commitOn(repo, 'b.txt')
  fake.claudeWorktreeFrom = tip
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(await git(join(repo, '.claude', 'worktrees', 'w-api'), 'rev-parse', 'HEAD'), tip)
  assert.doesNotMatch(spawned.text, /Note:/)
})

test('a claude worktree that diverged from main is left alone and the spawn result says so', async () => {
  const { fake, deps, identity, repo } = await setup()
  const base = await git(repo, 'rev-parse', 'HEAD')
  await git(repo, 'switch', '-q', '-c', 'other', '--no-track')
  const other = await commitOn(repo, 'o.txt')
  await git(repo, 'switch', '-q', 'main')
  await commitOn(repo, 'b.txt')
  assert.notEqual(other, base)
  fake.claudeWorktreeFrom = 'other'
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal(await git(join(repo, '.claude', 'worktrees', 'w-api'), 'rev-parse', 'HEAD'), other)
  assert.match(spawned.text, /Note: Claude created worktree-w-api at [0-9a-f]+, which is not an ancestor of main, so it was left as is/)
})

const withRemote = async () => {
  const fake = new FakeHerdr()
  const repo = await makeRepo()
  const bare = await tmp('origin')
  await git(bare, 'init', '-q', '--bare', '-b', 'main')
  await git(repo, 'remote', 'add', 'origin', bare)
  await git(repo, 'push', '-q', 'origin', 'main')
  await git(repo, 'fetch', '-q', 'origin')
  const deps = await makeDeps(fake)
  await seedRun(deps, repo, [], { base: 'origin/main' })
  fake.claudeWorktreeFrom = 'origin/main'
  return { fake, deps, repo, identity: planner(deps) }
}

test('with base origin/main and local main two commits ahead, codex and claude workers start at local main', async () => {
  const { deps, identity, repo } = await withRemote()
  await commitOn(repo, 'a.txt')
  const tip = await commitOn(repo, 'b.txt')
  const codex = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(codex.ok, true, codex.text)
  assert.equal(await git(join(repo, '.claude', 'worktrees', 'w-cx'), 'rev-parse', 'HEAD'), tip)
  assert.match(codex.text, /The base used was main, the local branch ahead of origin\/main/)
  const claude = await commands.spawn(deps, identity, { seat: 'w-cl', kind: 'claude', brief })
  assert.equal(claude.ok, true, claude.text)
  assert.equal(await git(join(repo, '.claude', 'worktrees', 'w-cl'), 'rev-parse', 'HEAD'), tip)
  assert.match(claude.text, /fast-forwarded to/)
  assert.match(claude.text, /The base used was main, the local branch ahead of origin\/main/)
  assert.equal((await loadRun(deps.home, RUN))?.base, 'origin/main')
})

test('with local main behind origin/main the workers start at origin/main', async () => {
  const { deps, identity, repo } = await withRemote()
  await commitOn(repo, 'a.txt')
  const remoteTip = await commitOn(repo, 'b.txt')
  await git(repo, 'push', '-q', 'origin', 'main')
  await git(repo, 'fetch', '-q', 'origin')
  await git(repo, 'reset', '-q', '--hard', 'HEAD~2')
  const codex = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(codex.ok, true, codex.text)
  assert.equal(await git(join(repo, '.claude', 'worktrees', 'w-cx'), 'rev-parse', 'HEAD'), remoteTip)
  assert.doesNotMatch(codex.text, /Note:/)
  const claude = await commands.spawn(deps, identity, { seat: 'w-cl', kind: 'claude', brief })
  assert.equal(await git(join(repo, '.claude', 'worktrees', 'w-cl'), 'rev-parse', 'HEAD'), remoteTip)
  assert.doesNotMatch(claude.text, /Note:/)
})

test('with local main equal to origin/main the spawn says nothing about a base ahead', async () => {
  const { deps, identity, repo } = await withRemote()
  await commitOn(repo, 'a.txt')
  const tip = await commitOn(repo, 'b.txt')
  await git(repo, 'push', '-q', 'origin', 'main')
  await git(repo, 'fetch', '-q', 'origin')
  const codex = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(codex.ok, true, codex.text)
  assert.equal(await git(join(repo, '.claude', 'worktrees', 'w-cx'), 'rev-parse', 'HEAD'), tip)
  assert.doesNotMatch(codex.text, /ahead of/)
  const claude = await commands.spawn(deps, identity, { seat: 'w-cl', kind: 'claude', brief })
  assert.equal(claude.ok, true, claude.text)
  assert.doesNotMatch(claude.text, /ahead of/)
})

test('with local main diverged from origin/main the workers start at origin/main and the result says so', async () => {
  const { deps, identity, repo } = await withRemote()
  const remoteTip = await commitOn(repo, 'a.txt')
  await git(repo, 'push', '-q', 'origin', 'main')
  await git(repo, 'fetch', '-q', 'origin')
  await git(repo, 'reset', '-q', '--hard', 'HEAD~1')
  await commitOn(repo, 'b.txt')
  const codex = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(codex.ok, true, codex.text)
  assert.equal(await git(join(repo, '.claude', 'worktrees', 'w-cx'), 'rev-parse', 'HEAD'), remoteTip)
  assert.match(codex.text, /local main and origin\/main have diverged, so origin\/main was used/)
  const claude = await commands.spawn(deps, identity, { seat: 'w-cl', kind: 'claude', brief })
  assert.equal(await git(join(repo, '.claude', 'worktrees', 'w-cl'), 'rev-parse', 'HEAD'), remoteTip)
  assert.match(claude.text, /have diverged/)
})

test('without a remote a codex worktree starts at main with no base note', async () => {
  const { deps, identity, repo } = await setup()
  const tip = await commitOn(repo, 'a.txt')
  const codex = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(codex.ok, true, codex.text)
  assert.equal(await git(join(repo, '.claude', 'worktrees', 'w-cx'), 'rev-parse', 'HEAD'), tip)
  assert.doesNotMatch(codex.text, /Note:/)
})

test('a claude spawn at the base carries no base note', async () => {
  const { deps, identity } = await setup()
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.doesNotMatch(spawned.text, /Note:/)
})

test('the second worker splits into the grid instead of opening another tab', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await commands.spawn(deps, identity, { seat: 'w-b', kind: 'codex', brief })
  await commands.spawn(deps, identity, { seat: 'w-c', kind: 'claude', brief })
  const splits = fake.calls.filter(call => call[1] === 'pane' && call[2] === 'split')
  assert.equal(fake.calls.filter(call => call[1] === 'tab' && call[2] === 'create').length, 1)
  assert.equal(splits.length, 2)
  assert.deepEqual([splits[0]?.[splits[0].indexOf('--direction') + 1], splits[1]?.[splits[1].indexOf('--direction') + 1]], ['right', 'down'])
  assert.equal(splits[0]?.[splits[0].indexOf('--pane') + 1], 'w1:p1')
})

test('a codex worker is launched with the codex spec and an initial prompt', async () => {
  const { fake, deps, identity } = await setup()
  const spawned = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', cairn: 'DROVE-6', brief, effort: 'high' })
  assert.equal(spawned.ok, true, spawned.text)
  const start = fake.find('herdr', 'agent', 'start') ?? []
  assert.equal(start[start.indexOf('--kind') + 1], 'codex')
  assert.ok(start.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(!start.includes('--add-dir') && !start.includes('-s'))
  assert.ok(start.includes('model_reasoning_effort="high"'))
  assert.ok(!start.includes('-m'))
  assert.match(start.at(-1) ?? '', /^Build the widget\. \(You are worker `w-cx` on branch `drove\/w-cx`\. Your Cairn task is DROVE-6/)
})

test('codexWorkerSandbox "workspace-write" restores the sandboxed codex worker spec', async () => {
  const { fake, deps, identity } = await setup()
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ codexWorkerSandbox: 'workspace-write' }))
  const spawned = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', cairn: 'DROVE-6', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const start = fake.find('herdr', 'agent', 'start') ?? []
  assert.ok(!start.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.deepEqual(start.slice(start.indexOf('-s'), start.indexOf('-s') + 2), ['-s', 'workspace-write'])
  assert.ok(start.includes('--add-dir'))
})

test('a failed agent start closes the new tab, removes the seat and the fresh worktree', async () => {
  const { fake, deps, identity, repo } = await setup(new FakeHerdr({ startFails: 'agent_start_failed' }))
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, false)
  assert.match(spawned.text, /no worker exists/)
  const order = fake.herdrCalls()
  assert.deepEqual(order.filter(item => ['tab create', 'agent start', 'tab close'].includes(item)), ['tab create', 'agent start', 'tab close', 'tab create', 'agent start', 'tab close'])
  assert.equal(fake.tabs.size, 0)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats, [])
  assert.equal(existsSync(join(repo, '.claude', 'worktrees', 'w-api')), false)
  assert.equal(await git(repo, 'branch', '--list', 'worktree-w-api'), '')
  assert.equal((await loadRun(deps.home, RUN))?.tabId, undefined)
})

test('a failed codex start removes the Drove worktree and its branch', async () => {
  const { deps, identity, repo } = await setup(new FakeHerdr({ startFails: 'agent_start_failed' }))
  const spawned = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(spawned.ok, false)
  assert.equal(existsSync(join(repo, '.claude', 'worktrees', 'w-cx')), false)
  assert.equal(await git(repo, 'branch', '--list', 'drove/w-cx'), '')
})

const FOLDER_TRUST_SCREEN = ' Do you trust the files in this folder?\n\n /repo/.claude/worktrees/w-api\n\n 1. Yes, proceed\n 2. No, exit\n'

const readEvents = async (deps: Deps) =>
  (await readFile(join(deps.home, 'runs', RUN, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; seat?: string; data?: Record<string, unknown> })

test('a start that times out at the folder-trust dialog saves the pane output, logs seat.start_failed and keeps the pane (DROVE-147)', async () => {
  const fake = new FakeHerdr({ startFails: 'timeout', screen: FOLDER_TRUST_SCREEN })
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /stopped on a dialog \(trust\)/)
  const file = join(seatDir(deps.home, RUN, 'w-api'), 'start-failure.txt')
  assert.equal(await readFile(file, 'utf8'), `== visible screen ==\n${FOLDER_TRUST_SCREEN.trimEnd()}\n\n== recent output ==\n${FOLDER_TRUST_SCREEN.trimEnd()}\n`)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const reads = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'read')
  assert.deepEqual(reads.map(call => call.slice(3)).slice(0, 2), [
    ['w-api-a3f1', '--source', 'visible', '--lines', '60'],
    ['w-api-a3f1', '--source', 'recent-unwrapped', '--lines', '60'],
  ])
  assert.ok(!fake.herdrCalls().includes('tab close') && !fake.herdrCalls().includes('pane close'))
  const event = (await readEvents(deps)).find(item => item.type === 'seat.start_failed')
  assert.equal(event?.seat, 'w-api')
  assert.equal(event?.data?.code, 'timeout')
  assert.equal(event?.data?.reason, 'trust')
})

test('the failure capture falls back to a pane read and omits the hint when no dialog matches', async () => {
  const fake = new FakeHerdr({ startFails: 'agent_start_failed', screen: 'command not found: claude', agentReadFails: true })
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, false)
  assert.doesNotMatch(spawned.text, /Hint:/)
  assert.ok(fake.find('herdr', 'pane', 'read', 'w1:p1'))
  assert.equal(await readFile(join(seatDir(deps.home, RUN, 'w-api'), 'start-failure.txt'), 'utf8'), '== visible screen ==\ncommand not found: claude\n\n== recent output ==\ncommand not found: claude\n')
  const event = (await readEvents(deps)).find(item => item.type === 'seat.start_failed')
  assert.equal(event?.data?.reason, undefined)
})

test('a startup dialog on a claude worker also saves the capture', async () => {
  const fake = new FakeHerdr({ startFails: 'agent_not_ready', screen: FOLDER_TRUST_SCREEN })
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true)
  assert.match(spawned.text, /\(trust\)/)
  assert.match(await readFile(join(seatDir(deps.home, RUN, 'w-api'), 'start-failure.txt'), 'utf8'), /^== visible screen ==\n Do you trust the files in this folder\?/)
  assert.equal((await readEvents(deps)).filter(item => item.type === 'seat.start_failed').length, 1)
})

test('a failed start into an existing grid closes only that pane', async () => {
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  fake.startFails = 'agent_start_failed'
  const spawned = await commands.spawn(deps, identity, { seat: 'w-b', kind: 'claude', brief })
  assert.equal(spawned.ok, false)
  assert.ok(fake.herdrCalls().includes('pane close'))
  assert.ok(!fake.herdrCalls().includes('tab close'))
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats.map(seat => seat.name), ['w-a'])
})

test('agent_pane_busy on a fresh pane is retried', async () => {
  const fake = new FakeHerdr({ busyStarts: 2 })
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal(fake.calls.filter(call => call[2] === 'agent' || call[1] === 'agent').filter(call => call[2] === 'start').length, 3)
})

test('a startup dialog keeps the pane and turns the version-mismatch text into an attention item', async () => {
  const fake = new FakeHerdr({ startFails: 'agent_not_ready', screen: 'Background server has incompatible feature settings' })
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(spawned.ok, true)
  assert.match(spawned.text, /codex-version-mismatch/)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.equal(seat?.state, 'blocked')
  assert.equal(seat?.attention[0]?.reason, 'codex-version-mismatch')
  assert.ok(!fake.herdrCalls().includes('pane close'))
  assert.ok(!fake.herdrCalls().includes('tab close'))
  assert.ok(!fake.calls.some(call => call.includes('/exit')))
})

test('DROVE_BRIEF_VIA=herdr-prompt starts without the prompt and sends the brief with herdr agent prompt', async () => {
  process.env.DROVE_BRIEF_VIA = 'herdr-prompt'
  const { fake, deps, identity } = await setup()
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const start = fake.find('herdr', 'agent', 'start') ?? []
  assert.ok(!start.some(arg => arg.includes('Build the widget')))
  assert.equal(fake.prompts.length, 1)
  assert.match(fake.prompts[0]?.text ?? '', /kind=brief/)
  assert.match(fake.prompts[0]?.text ?? '', /Build the widget/)
})

test('by default the agent starts without the brief and the brief arrives as the first herdr prompt', async () => {
  delete process.env.DROVE_BRIEF_VIA
  for (const kind of ['claude', 'codex'] as const) {
    const { fake, deps, identity } = await setup()
    const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind, cairn: 'DROVE-5', brief })
    assert.equal(spawned.ok, true, `${kind}: ${spawned.text}`)
    const start = fake.find('herdr', 'agent', 'start') ?? []
    assert.ok(!start.some(arg => arg.includes('Build the widget')), kind)
    const order = fake.herdrCalls()
    assert.ok(order.indexOf('agent start') < order.indexOf('agent prompt'), kind)
    assert.equal(fake.prompts.length, 1, kind)
    assert.match(fake.prompts[0]?.text ?? '', /kind=brief[\s\S]*Build the widget\.[\s\S]*Your Cairn task is DROVE-5/)
    assert.match(spawned.text, /Brief: herdr-prompt\./)
    const seat = (await loadRoster(deps.home, RUN)).seats[0]
    assert.equal(seat?.state, 'working')
    assert.ok(seat?.lastWorkingAt)
  }
})

test('briefVia "launch-arg" in the config restores the launch argument, and DROVE_BRIEF_VIA overrides the config', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const configured = await setup()
  await writeFile(join(configured.deps.home, 'config.json'), JSON.stringify({ briefVia: 'launch-arg' }))
  assert.equal((await commands.spawn(configured.deps, configured.identity, { seat: 'w-api', kind: 'claude', brief })).ok, true)
  assert.match((configured.fake.find('herdr', 'agent', 'start') ?? []).at(-1) ?? '', /^Build the widget\./)
  assert.equal(configured.fake.prompts.length, 0)

  process.env.DROVE_BRIEF_VIA = 'prompt'
  const overridden = await setup()
  await writeFile(join(overridden.deps.home, 'config.json'), JSON.stringify({ briefVia: 'launch-arg' }))
  assert.equal((await commands.spawn(overridden.deps, overridden.identity, { seat: 'w-api', kind: 'claude', brief })).ok, true)
  assert.equal(overridden.fake.prompts.length, 1)
})

test('a brief herdr typed but did not submit is submitted by Drove and the spawn says so (DROVE-124)', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const { fake, deps, identity } = await setup(new FakeHerdr({ promptStalls: 'pasted', startStatus: 'idle' }))
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /Brief: delivered \(after submitting the pasted text\)\./)
  assert.equal(fake.prompts.length, 1)
  assert.equal(fake.keys.length, 1)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.state, 'working')
})

test('a stalled brief with nothing in the input stays not delivered and presses nothing', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const { fake, deps, identity } = await setup(new FakeHerdr({ promptStalls: 'empty', startStatus: 'idle' }))
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /Brief: not delivered \(agent_prompt_stalled/)
  assert.equal(fake.keys.length, 0)
})

const briefPath = (deps: Deps): string => join(seatDir(deps.home, RUN, 'w-api'), 'brief.md')
const tenLines = Array.from({ length: 10 }, (_, index) => `Step ${index + 1} of the brief.`).join('\n')
const pointerBody = (text: string | undefined): string => parseEnvelope(text ?? '')?.body ?? ''

test('a stalled brief with nothing in the input is sent again once as a pointer to brief.md (DROVE-136)', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const { fake, deps, identity } = await setup(new FakeHerdr({ promptStalls: 'empty', stallsFor: 1, startStatus: 'idle' }))
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief: tenLines })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /Brief: herdr-prompt\./)
  assert.equal(fake.keys.length, 0)
  assert.equal(fake.prompts.length, 2)
  assert.match(fake.prompts[0]?.text ?? '', /Step 10 of the brief\./)
  const pointer = pointerBody(fake.prompts[1]?.text)
  const saved = (await readFile(briefPath(deps), 'utf8')).trim()
  assert.equal(pointer, `Your brief is in \`${briefPath(deps)}\` (${saved.split('\n').length} lines): read it with the Read tool, then start.`)
  assert.doesNotMatch(fake.prompts[1]?.text ?? '', /Step 10 of the brief\./)
  const sent = (await readEvents(deps)).find(item => item.type === 'control.sent')
  assert.equal(sent?.data?.pointer, true)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.state, 'working')
})

test('a brief longer than briefPointerLines goes out as a pointer first, with the full text already in brief.md (DROVE-136)', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const { fake, deps, identity } = await setup(new FakeHerdr({ startStatus: 'idle' }))
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ briefPointerLines: 5 }))
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief: tenLines })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal(fake.prompts.length, 1)
  const saved = (await readFile(briefPath(deps), 'utf8')).trim()
  assert.match(saved, /^Step 1 of the brief\.\nStep 2/)
  assert.ok(saved.split('\n').length > 10)
  assert.equal(pointerBody(fake.prompts[0]?.text), `Your brief is in \`${briefPath(deps)}\` (${saved.split('\n').length} lines): read it with the Read tool, then start.`)
  assert.doesNotMatch(fake.prompts[0]?.text ?? '', /Step 2 of the brief/)
  const sent = (await readEvents(deps)).find(item => item.type === 'control.sent')
  assert.deepEqual(sent?.data, { kind: 'brief', via: 'herdr-prompt', pointer: true })
})

test('a brief at or under briefPointerLines, or with a setting that is not a count, goes out in full as before (DROVE-136)', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const fits = await setup(new FakeHerdr({ startStatus: 'idle' }))
  await writeFile(join(fits.deps.home, 'config.json'), JSON.stringify({ briefPointerLines: 40 }))
  assert.equal((await commands.spawn(fits.deps, fits.identity, { seat: 'w-api', kind: 'claude', brief: tenLines })).ok, true)
  assert.match(fits.fake.prompts[0]?.text ?? '', /Step 10 of the brief\./)

  const invalid = await setup(new FakeHerdr({ startStatus: 'idle' }))
  await writeFile(join(invalid.deps.home, 'config.json'), JSON.stringify({ briefPointerLines: 'few' }))
  assert.equal((await commands.spawn(invalid.deps, invalid.identity, { seat: 'w-api', kind: 'claude', brief: tenLines })).ok, true)
  assert.match(invalid.fake.prompts[0]?.text ?? '', /Step 10 of the brief\./)
  assert.equal(invalid.fake.prompts.length, 1)
})

test('a first turn that outlasts the prompt wait still yields a successful spawn', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const { fake, deps, identity } = await setup(new FakeHerdr({ promptTimesOut: true }))
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /Brief: herdr-prompt \(typed; herdr did not confirm/)
  assert.equal(fake.prompts.length, 1)
  assert.ok(!fake.herdrCalls().includes('pane close') && !fake.herdrCalls().includes('tab close'))
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.equal(seat?.state, 'working')
  assert.equal(seat?.paneId, 'w1:p1')
  const sent = (await readEvents(deps)).find(item => item.type === 'control.sent')
  assert.equal(sent?.data?.unconfirmed, true)
})

test('a start timeout with a live agent in the pane keeps the seat instead of rolling back', async () => {
  for (const kind of ['claude', 'codex'] as const) {
    for (const status of ['working', 'idle'] as const) {
      const fake = new FakeHerdr({ startFails: 'timeout', startLeavesAgent: true, startStatus: status })
      const { deps, identity } = await setup(fake)
      process.env.DROVE_BRIEF_VIA = 'launch-arg'
      const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind, brief })
      assert.equal(spawned.ok, true, `${kind} ${status}: ${spawned.text}`)
      assert.match(spawned.text, /timed out but the \w+ agent is up in the pane/)
      assert.ok(!fake.herdrCalls().includes('pane close') && !fake.herdrCalls().includes('tab close'))
      const seat = (await loadRoster(deps.home, RUN)).seats[0]
      assert.equal(seat?.paneId, 'w1:p1')
      assert.equal(seat?.state, status)
      const events = await readEvents(deps)
      assert.equal(events.find(item => item.type === 'seat.spawn')?.data?.startTimeout, true)
      assert.equal(events.some(item => item.type === 'seat.start_failed'), false)
    }
  }
})

test('after a start timeout the brief still goes by herdr prompt in the default mode', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const fake = new FakeHerdr({ startFails: 'timeout', startLeavesAgent: true, startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal(fake.prompts.length, 1)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.state, 'working')
})

test('a start timeout with the agent screen up and no dialog registers the seat for the watcher to judge', async () => {
  const fake = new FakeHerdr({ startFails: 'timeout', screen: ' ▐▛███▛█   Claude Code v2.1.295\n❯ Build the widget.\n' })
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.state, 'starting')
  assert.ok(!fake.herdrCalls().includes('tab close'))
})

test('a start timeout rolls back when the agent is absent', async () => {
  const fake = new FakeHerdr({ startFails: 'timeout', screen: 'zsh: command not found: claude' })
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, false)
  assert.match(spawned.text, /no worker exists/)
  assert.ok(fake.herdrCalls().includes('tab close'))
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats, [])
  assert.equal((await readEvents(deps)).filter(item => item.type === 'seat.start_failed').length, 1)
})

test('a start timeout at a dialog keeps the pane, blocks the seat and holds the brief, whether or not herdr lists the agent (DROVE-147)', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const cases: { name: string; fake: FakeHerdr }[] = [
    { name: 'blocked', fake: new FakeHerdr({ startFails: 'timeout', startLeavesAgent: true, startStatus: 'blocked', screen: FOLDER_TRUST_SCREEN }) },
    { name: 'dialog on screen', fake: new FakeHerdr({ startFails: 'timeout', startLeavesAgent: true, startStatus: 'idle', screen: `Claude Code v2.1.295\n${FOLDER_TRUST_SCREEN}` }) },
    { name: 'dialog, no agent', fake: new FakeHerdr({ startFails: 'timeout', screen: `Claude Code v2.1.295\n${FOLDER_TRUST_SCREEN}` }) },
  ]
  for (const { name, fake } of cases) {
    const { deps, identity } = await setup(fake)
    const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
    assert.equal(spawned.ok, true, `${name}: ${spawned.text}`)
    assert.ok(!fake.herdrCalls().includes('tab close') && !fake.herdrCalls().includes('pane close'), name)
    assert.equal(fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').length, 1, name)
    const seat = (await loadRoster(deps.home, RUN)).seats[0]
    assert.deepEqual([seat?.state, seat?.attention[0]?.reason, seat?.pendingStart?.via], ['blocked', 'trust', 'prompt'], name)
    assert.deepEqual(fake.prompts, [], name)
  }
})

test('every seat of a run gets the same role text, and the brief footer names the seat and the branch it is on', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const { fake, deps, identity } = await setup()
  for (const seat of ['w-api', 'w-web']) assert.equal((await commands.spawn(deps, identity, { seat, kind: 'claude', brief })).ok, true)
  const roleOf = (seat: string) => readFile(join(seatDir(deps.home, RUN, seat), 'role.md'), 'utf8')
  const role = await roleOf('w-api')
  assert.equal(role, await roleOf('w-web'))
  assert.doesNotMatch(role, /w-api|worktree-w-api/)
  assert.match(role, /already on your own branch \(the brief names it\) in your own worktree\. Commit there\. Do not create, switch or rebase branches unless the planner asks\./)
  assert.match(fake.prompts[0]?.text ?? '', /\(You are worker `w-api` on branch `worktree-w-api`\./)
  assert.match(fake.prompts[1]?.text ?? '', /\(You are worker `w-web` on branch `worktree-w-web`\./)
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })).ok, true)
  assert.match(fake.prompts[2]?.text ?? '', /\nBuild the widget\. \(You are worker `w-cx` on branch `drove\/w-cx`\./)
})

test('a codex worker role goes in its CODEX_HOME config.toml as developer_instructions, never in the launch line or the brief', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  const start = fake.find('herdr', 'agent', 'start') ?? []
  assert.ok(!start.some(arg => arg.startsWith('developer_instructions') || arg.includes('# Worker mode')))
  const config = await readFile(join(deps.home, 'runs', RUN, 'codex-home', 'config.toml'), 'utf8')
  assert.match(config, /^developer_instructions = "# Worker mode\\n\\n## Overview\\nYou are a worker of Drove run /m)
})

test('the brief footer carries the repo verify commands from package.json', async () => {
  const { fake, deps, identity, repo } = await setup()
  await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc --noEmit', build: 'tsc' } }))
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const start = fake.find('herdr', 'agent', 'start') ?? []
  assert.match(start.at(-1) ?? '', /Verify with `npm run typecheck`, `npm test`\. Report with the drove report tool/)
})

test('workerMcp and a spawn --mcp list make a claude seat strict with the union, read from the user Claude config', async () => {
  const { fake, deps, identity } = await setup()
  const claudeUserConfig = join(deps.home, 'claude.json')
  await writeFile(claudeUserConfig, JSON.stringify({ mcpServers: { mongodb: { command: 'mongo-mcp' }, notion: { command: 'notion-mcp' }, filesystem: { command: 'fs-mcp' } } }))
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerMcp: ['notion'] }))
  const spawned = await commands.spawn({ ...deps, claudeUserConfig }, identity, { seat: 'w-api', kind: 'claude', brief, mcp: ['mongodb', 'nope'] })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /MCP server nope is not in the user's Claude setup, so w-api runs without it\./)
  assert.ok((fake.find('herdr', 'agent', 'start') ?? []).includes('--strict-mcp-config'))
  const mcp = JSON.parse(await readFile(join(seatDir(deps.home, RUN, 'w-api'), 'mcp.json'), 'utf8')) as { mcpServers: object }
  assert.deepEqual(Object.keys(mcp.mcpServers), ['notion', 'mongodb', 'drove'])
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats[0]?.mcp, ['mongodb', 'nope'])
})

test('with no workerMcp and no --mcp a claude seat keeps the user MCP setup and never reads it', async () => {
  const { fake, deps, identity } = await setup()
  const spawned = await commands.spawn({ ...deps, claudeUserConfig: join(deps.home, 'absent.json') }, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.ok(!(fake.find('herdr', 'agent', 'start') ?? []).includes('--strict-mcp-config'))
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.mcp, undefined)
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-bad', kind: 'claude', brief, mcp: ['a b'] })).ok, false)
})

test('a lean claude seat runs --no-chrome, and naming claude-in-chrome in the allowlist is not reported missing and keeps Chrome', async () => {
  const { fake, deps, identity } = await setup()
  const claudeUserConfig = join(deps.home, 'claude.json')
  await writeFile(claudeUserConfig, JSON.stringify({ mcpServers: { notion: { command: 'notion-mcp' } } }))
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerMcp: ['notion'] }))
  const lean = await commands.spawn({ ...deps, claudeUserConfig }, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(lean.ok, true, lean.text)
  assert.ok((fake.find('herdr', 'agent', 'start') ?? []).includes('--no-chrome'))

  const withChrome = await commands.spawn({ ...deps, claudeUserConfig }, identity, { seat: 'w-web', kind: 'claude', brief, mcp: ['claude-in-chrome'] })
  assert.equal(withChrome.ok, true, withChrome.text)
  assert.doesNotMatch(withChrome.text, /claude-in-chrome/)
  const starts = fake.calls.filter(call => call[0] === 'herdr' && call[1] === 'agent' && call[2] === 'start')
  assert.ok(!(starts.at(-1) ?? []).includes('--no-chrome'))
  const mcp = JSON.parse(await readFile(join(seatDir(deps.home, RUN, 'w-web'), 'mcp.json'), 'utf8')) as { mcpServers: object }
  assert.deepEqual(Object.keys(mcp.mcpServers), ['notion', 'drove'], 'Chrome is not an MCP server of the user; the flag alone leaves it on')
})

test('with no allowlist a claude seat keeps Chrome', async () => {
  const { fake, deps, identity } = await setup()
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })).ok, true)
  assert.ok(!(fake.find('herdr', 'agent', 'start') ?? []).includes('--no-chrome'))
})

test('workerPlugins and workerUserMemory false shape a claude seat\'s settings.json from the user Claude settings and folders', async () => {
  const { deps, identity, repo } = await setup()
  const claudeUserDir = join(deps.home, 'claude-dir')
  await mkdir(join(claudeUserDir, 'mods', 'ci-watch'), { recursive: true })
  await mkdir(join(claudeUserDir, 'mods', 'orch', '.claude-plugin'), { recursive: true })
  await writeFile(join(claudeUserDir, 'mods', 'orch', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'orchestrator' }))
  const dirs = [join(claudeUserDir, 'mods', 'ci-watch'), join(claudeUserDir, 'mods', 'orch')]
  await writeFile(join(claudeUserDir, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'context7@claude-plugins-official': true, 'ccc-skills@ccc': true, 'old@x': false },
    env: { CLAUDE_CODE_PLUGIN_DIRS: dirs.join(':') },
  }))
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerPlugins: ['context7'], workerUserMemory: false }))
  const spawned = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const settings = JSON.parse(await readFile(join(seatDir(deps.home, RUN, 'w-api'), 'settings.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(settings.enabledPlugins, { 'ccc-skills@ccc': false })
  assert.deepEqual(settings.env, { CLAUDE_CODE_PLUGIN_DIRS: dirs[1] })
  const excludes = settings.claudeMdExcludes as string[]
  assert.equal(excludes[0], join(claudeUserDir, 'CLAUDE.md'))
  assert.ok(excludes.includes(join(dirname(repo), 'CLAUDE.md')), 'the folder above the repo')
  assert.ok(!excludes.includes(join(repo, 'CLAUDE.md')), "the repo's own file stays")
})

test('with neither switch set a claude seat\'s settings.json is hooks only, and the user settings are never read', async () => {
  const { deps, identity } = await setup()
  const spawned = await commands.spawn({ ...deps, claudeUserDir: join(deps.home, 'absent-dir') }, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const settings = JSON.parse(await readFile(join(seatDir(deps.home, RUN, 'w-api'), 'settings.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(settings), ['hooks'])
})

test('workerUserMemory false keeps AGENTS.md out of a codex worker CODEX_HOME and unlinks an earlier link; on, it stays linked', async () => {
  const { deps, identity } = await setup()
  const codexUserHome = join(deps.home, 'user-codex')
  await mkdir(codexUserHome, { recursive: true })
  await writeFile(join(codexUserHome, 'AGENTS.md'), 'user rules')
  await writeFile(join(codexUserHome, 'auth.json'), '{}')
  const first = await commands.spawn({ ...deps, codexUserHome }, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(first.ok, true, first.text)
  const home = join(deps.home, 'runs', RUN, 'codex-home')
  assert.ok(existsSync(join(home, 'AGENTS.md')), 'linked by default')

  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerUserMemory: false }))
  const second = await commands.spawn({ ...deps, codexUserHome }, identity, { seat: 'w-cx2', kind: 'codex', brief })
  assert.equal(second.ok, true, second.text)
  assert.ok(!existsSync(join(home, 'AGENTS.md')), 'unlinked')
  assert.ok(existsSync(join(home, 'auth.json')), 'the login stays')
})

test('loadConfig reads workerPlugins as names and workerUserMemory as a boolean, and ignores other values', async () => {
  const deps = await makeDeps(new FakeHerdr())
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerPlugins: [' context7 ', 'ccc-skills@ccc', 3, '', 'context7'], workerUserMemory: false }))
  const config = await commands.loadConfig(deps.home)
  assert.deepEqual(config.workerPlugins, ['context7', 'ccc-skills@ccc'])
  assert.equal(config.workerUserMemory, false)
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerPlugins: 'context7', workerUserMemory: 'no' }))
  const bad = await commands.loadConfig(deps.home)
  assert.equal(bad.workerPlugins, undefined)
  assert.equal(bad.workerUserMemory, undefined)
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerPlugins: [] }))
  assert.deepEqual((await commands.loadConfig(deps.home)).workerPlugins, [], 'an empty list is the lean setting: the user plugins off')
})

test('loadConfig reads workerAgents as names and workerUserHooks as a boolean, and ignores other values', async () => {
  const deps = await makeDeps(new FakeHerdr())
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerSkills: ['cairn'], workerAgents: [' debugger ', 7, 'debugger'], workerUserHooks: false }))
  const config = await commands.loadConfig(deps.home)
  assert.deepEqual([config.workerSkills, config.workerAgents, config.workerUserHooks], [['cairn'], ['debugger'], false])
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerAgents: 'debugger', workerUserHooks: 'no' }))
  const bad = await commands.loadConfig(deps.home)
  assert.deepEqual([bad.workerAgents, bad.workerUserHooks], [undefined, undefined])
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerAgents: [], workerSkills: [] }))
  const empty = await commands.loadConfig(deps.home)
  assert.deepEqual([empty.workerAgents, empty.workerSkills], [[], []], 'an empty list is the lean setting: none of the user ones')
})

test('a single-line brief stays a launch argument; the role text is a file, not an argument', async () => {
  const { fake, deps, identity } = await setup()
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief: '  Build the widget.  ' })
  assert.equal(spawned.ok, true, spawned.text)
  const start = fake.find('herdr', 'agent', 'start') ?? []
  assert.match(start.at(-1) ?? '', /^Build the widget\. \(You are worker `w-api` on branch `worktree-w-api`\.\s/)
  assert.equal(fake.prompts.length, 0)
  const roleFlag = start.indexOf('--append-system-prompt-file')
  assert.equal(start[roleFlag + 1], join(seatDir(deps.home, RUN, 'w-api'), 'role.md'))
  assert.match(await readFile(join(seatDir(deps.home, RUN, 'w-api'), 'role.md'), 'utf8'), /^# Worker mode\n/)
  assert.ok(!start.includes('--append-system-prompt'))
  assert.ok(start.slice(start.indexOf('--') + 1).every(arg => !/[\u0000-\u001f\u007f]/.test(arg)))
})

test('a multi-line brief starts the agent without it and arrives as the first herdr prompt', async () => {
  const multi = 'Build the widget.\n\n## Rules\n- one\n- two with `ticks`'
  for (const kind of ['claude', 'codex'] as const) {
    const { fake, deps, identity } = await setup()
    const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind, cairn: 'DROVE-5', brief: multi })
    assert.equal(spawned.ok, true, `${kind}: ${spawned.text}`)
    const start = fake.find('herdr', 'agent', 'start') ?? []
    assert.ok(!start.some(arg => arg.includes('Build the widget')), kind)
    assert.ok(start.slice(start.indexOf('--') + 1).every(arg => !/[\u0000-\u001f\u007f]/.test(arg)), kind)
    assert.equal(fake.prompts.length, 1, kind)
    assert.match(fake.prompts[0]?.text ?? '', /kind=brief[\s\S]*Build the widget\.\n\n## Rules\n- one\n- two with `ticks`[\s\S]*Your Cairn task is DROVE-5/)
  }
})

test('the fake herdr refuses a start whose argv has a newline, with the real error code', async () => {
  const fake = new FakeHerdr()
  const refused = await fake.exec(['herdr', 'agent', 'start', 'w-x', '--kind', 'claude', '--pane', 'w1:p1', '--timeout', '1', '--', 'claude', 'two\nlines'])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /invalid_agent_argument.*cannot be encoded safely for the target shell/)
  assert.equal(fake.agents.size, 0)
})

test('spawn refuses a full budget with the human-run hint, and a taken or bad name', async () => {
  const { fake, deps, identity } = await setup(new FakeHerdr(), { budget: 1 })
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })).ok, true)
  const full = await commands.spawn(deps, identity, { seat: 'w-b', kind: 'claude', brief })
  assert.equal(!full.ok && full.code, 'over-budget')
  assert.match(full.text, /ask the human to run `drove budget 2`/)
  const taken = await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  assert.equal(!taken.ok && taken.code, 'seat-taken')
  const bad = await commands.spawn(deps, identity, { seat: 'Bad Name', kind: 'claude', brief })
  assert.equal(!bad.ok && bad.code, 'usage')
  const worker = await commands.spawn(deps, { ...identity, role: 'worker' }, { seat: 'w-z', kind: 'claude', brief })
  assert.equal(!worker.ok && worker.code, 'forbidden')
  assert.equal(fake.calls.filter(call => call[2] === 'start' || call[3] === 'w-b').length, 1)
})

test('send verdict approve puts the approval text in once and types the envelope', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  fake.setStatus('w-api', 'idle')
  const sent = await commands.send(deps, identity, { seat: 'w-api', kind: 'verdict', verdict: 'approve', body: '' })
  assert.equal(sent.ok, true, sent.text)
  const text = fake.prompts[0]?.text ?? ''
  assert.match(text, /kind=verdict verdict=approve expects=none/)
  assert.equal(text.split(approvedText()).length, 2)
  const again = await commands.send(deps, identity, { seat: 'w-api', kind: 'verdict', verdict: 'approve', body: approvedText() })
  assert.equal(again.ok, true)
  assert.equal((fake.prompts[1]?.text ?? '').split(approvedText()).length, 2)
})

test('send changes needs notes and expects a review; answers clear what the seat is owed', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  fake.setStatus('w-api', 'idle')
  const noNotes = await commands.send(deps, identity, { seat: 'w-api', kind: 'verdict', verdict: 'changes', body: ' ' })
  assert.equal(!noNotes.ok && noNotes.code, 'usage')
  const { updateRoster } = await import('../src/roster.ts')
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, owes: 'answer' as const })) }))
  const changes = await commands.send(deps, identity, { seat: 'w-api', kind: 'verdict', verdict: 'changes', body: 'rename x' })
  assert.equal(changes.ok, true)
  assert.match(fake.prompts.at(-1)?.text ?? '', /expects=review/)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.owes, 'none')
  const missing = await commands.send(deps, identity, { seat: 'ghost', kind: 'message', body: 'x' })
  assert.equal(!missing.ok && missing.code, 'no-seat')
})

test('send to a blocked seat queues and reports it without typing', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  fake.setStatus('w-api', 'blocked')
  const sent = await commands.send(deps, identity, { seat: 'w-api', kind: 'message', body: 'hello' })
  assert.equal(sent.ok, true)
  assert.match(sent.text, /Queued message/)
  assert.equal(fake.prompts.length, 0)
})

test('send uses codex queue once the codex seat has a thread', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-xyz', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.sessionId, 'thread-xyz')
  const sent = await commands.send(deps, identity, { seat: 'w-cx', kind: 'answer', body: 'use sqlite' })
  assert.equal(sent.ok, true)
  assert.equal(fake.queued[0]?.thread, 'thread-xyz')
  assert.equal(fake.prompts.length, 0)
})

test('prompt types raw text but refuses a blocked pane', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  fake.setStatus('w-api', 'idle')
  assert.equal((await commands.prompt(deps, identity, 'w-api', 'carry on')).ok, true)
  assert.equal(fake.prompts[0]?.text, 'carry on')
  fake.setStatus('w-api', 'blocked')
  const refused = await commands.prompt(deps, identity, 'w-api', 'again')
  assert.equal(!refused.ok && refused.code, 'blocked')
  assert.equal(fake.prompts.length, 1)
})

test('close stops a Claude seat by closing its pane, never /exit, then closes the empty tab and keeps the worktree by default', async () => {
  const { fake, deps, identity, repo } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const closed = await commands.close(deps, identity, 'w-api', false)
  assert.equal(closed.ok, true, closed.text)
  assert.equal(fake.prompts.length, 0)
  assert.equal(fake.calls.filter(call => call[1] === 'pane' && call[2] === 'close').length, 1)
  assert.ok(fake.herdrCalls().includes('pane close'))
  assert.ok(fake.herdrCalls().includes('tab close'))
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.state, 'closed')
  assert.ok(existsSync(join(repo, '.claude', 'worktrees', 'w-api')))
  assert.equal((await loadRun(deps.home, RUN))?.tabId, undefined)
})

test('close releases each seat as its own runtime and preserves explicit CAIRN_AGENT (DROVE-162)', async () => {
  const previous = process.env.CAIRN_AGENT
  try {
    for (const [kind, explicit, expected] of [['codex', undefined, 'codex'], ['claude', undefined, 'claude-code'], ['codex', 'custom', 'custom']] as const) {
      if (explicit === undefined) delete process.env.CAIRN_AGENT
      else process.env.CAIRN_AGENT = explicit
      const fake = new FakeHerdr()
      const base = fake.exec
      const released: { argv: string[]; agent: string | undefined }[] = []
      fake.exec = async (argv, options) => {
        if (argv[0] !== 'cairn') return base(argv, options)
        if (argv[1] === 'release') released.push({ argv: [...argv], agent: options?.env?.CAIRN_AGENT })
        return { code: 0, stdout: '', stderr: '' }
      }
      const { deps, identity, run } = await setup(fake)
      assert.equal(run.planner.kind, 'claude')
      const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind, cairn: 'DROVE-5', brief })
      assert.equal(spawned.ok, true, spawned.text)
      const closed = await commands.close(deps, identity, 'w-api', false)
      assert.equal(closed.ok, true, closed.text)
      assert.deepEqual(released, [{ argv: ['cairn', 'release', 'DROVE-5', '--force'], agent: expected }])
      assert.match(closed.text, /Released the Cairn claim on DROVE-5/)
    }
  } finally {
    if (previous === undefined) delete process.env.CAIRN_AGENT
    else process.env.CAIRN_AGENT = previous
  }
})

test('close names the holder when Cairn refuses ownership (DROVE-162)', async () => {
  const { deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'codex', cairn: 'DROVE-5', brief })
  const base = deps.exec
  const reads: string[][] = []
  deps.exec = async (argv, options) => {
    if (argv[0] !== 'cairn') return base(argv, options)
    if (argv[1] === 'release') return { code: 1, stdout: '', stderr: 'Claim ownership changed; nothing was released.' }
    reads.push([...argv])
    return { code: 0, stdout: JSON.stringify({ claimed_by: 'claude-code · Cal' }), stderr: '' }
  }
  const closed = await commands.close(deps, identity, 'w-api', false)
  assert.equal(closed.ok, true, closed.text)
  assert.match(closed.text, /Note: the Cairn claim on DROVE-5 is still held by claude-code · Cal; it was not released\./)
  assert.deepEqual(reads, [['cairn', 'show', 'DROVE-5', '--json']])
})

test('close stays silent after an ownership refusal when the worker already released or finished its claim (DROVE-162)', async () => {
  for (const claimed_by of [null, '']) {
    const { deps, identity } = await setup()
    await commands.spawn(deps, identity, { seat: 'w-api', kind: 'codex', cairn: 'DROVE-5', brief })
    const base = deps.exec
    deps.exec = async (argv, options) => {
      if (argv[0] !== 'cairn') return base(argv, options)
      if (argv[1] === 'release') return { code: 1, stdout: '', stderr: 'Claim ownership changed; nothing was released.' }
      return { code: 0, stdout: JSON.stringify({ claimed_by }), stderr: '' }
    }
    const closed = await commands.close(deps, identity, 'w-api', false)
    assert.equal(closed.ok, true, closed.text)
    assert.doesNotMatch(closed.text, /Cairn claim|release it by hand/)
  }
})

test('close skips Cairn release when the run does not use Cairn (DROVE-159)', async () => {
  const { deps, identity, fake } = await setup(new FakeHerdr(), { useCairn: false })
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'codex', brief })
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, cairn: 'DROVE-5' })) }))
  const closed = await commands.close(deps, identity, 'w-api', false)
  assert.equal(closed.ok, true, closed.text)
  assert.equal(fake.calls.filter(call => call[0] === 'cairn').length, 0)
})

test('close adds no note when cairn has nothing to release, and keeps one for a real failure', async () => {
  const cases = [
    { stderr: 'cairn: acme could not be checked (stale project cache); routing DROVE to personal on its own record\nNothing was released.', note: false },
    { stderr: 'Claim ownership changed; nothing was released.', note: true },
    { stderr: 'Cannot release DROVE-5: it is already released.', note: false },
    { stderr: 'Cannot release DROVE-5: it is already done.', note: false },
    { stderr: 'cairn: acme could not be checked (stale project cache); routing DROVE to personal on its own record\ndatabase locked', note: true },
  ]
  for (const { stderr, note } of cases) {
    const fake = new FakeHerdr()
    const base = fake.exec
    fake.exec = async (argv, options) => (argv[0] === 'cairn' ? { code: 1, stdout: '', stderr } : base(argv, options))
    const { deps, identity } = await setup(fake)
    await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', cairn: 'DROVE-5', brief })
    const closed = await commands.close(deps, identity, 'w-api', false)
    assert.equal(closed.ok, true, closed.text)
    assert.equal(/Cairn claim on DROVE-5 was not released/.test(closed.text), note, closed.text)
    if (note) assert.doesNotMatch(closed.text, /could not be checked/)
  }
})

test('close still closes when cairn is not on PATH, with a note, and skips release for a seat without a ref', async () => {
  for (const missing of ['exit', 'throw'] as const) {
    const fake = new FakeHerdr()
    const base = fake.exec
    fake.exec = async (argv, options) => {
      if (argv[0] !== 'cairn') return base(argv, options)
      if (missing === 'throw') throw new Error('spawn cairn ENOENT')
      return { code: 127, stdout: '', stderr: 'command not found' }
    }
    const { deps, identity } = await setup(fake)
    await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', cairn: 'DROVE-5', brief })
    const closed = await commands.close(deps, identity, 'w-api', false)
    assert.equal(closed.ok, true, closed.text)
    assert.match(closed.text, /Cairn claim on DROVE-5 was not released/)
    assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.state, 'closed')
  }
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  await commands.close(deps, identity, 'w-api', false)
  assert.equal(fake.calls.filter(call => call[0] === 'cairn').length, 0)
})

test('a first turn that outlasts the prompt wait is confirmed when the seat\'s hook record shows the prompt', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const fake = new FakeHerdr({ promptTimesOut: true })
  const { deps, identity } = await setup(fake)
  const base = deps.exec
  deps.exec = async (argv, options) => {
    if (argv[1] === 'agent' && argv[2] === 'prompt') {
      await mkdir(seatDir(deps.home, RUN, 'w-api'), { recursive: true })
      await appendFile(join(seatDir(deps.home, RUN, 'w-api'), 'hooks.jsonl'), `${JSON.stringify({ at: new Date(Date.now() + 60_000).toISOString(), agent: 'claude', event: 'user-prompt-submit' })}\n`)
    }
    return base(argv, options)
  }
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /Brief: herdr-prompt(?! \(typed)/)
  const sent = (await readEvents(deps)).find(item => item.type === 'control.sent')
  assert.equal(sent?.data?.unconfirmed, undefined)
})

test('close marks the seat closing before the pane goes, so nothing the closing pane shows raises attention', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const seen: string[] = []
  const exec = deps.exec
  const watching: Deps = {
    ...deps,
    exec: async argv => {
      if (argv[1] === 'pane' && argv[2] === 'close') seen.push((await loadRoster(deps.home, RUN)).seats[0]?.state ?? 'missing')
      return exec(argv)
    },
  }
  const closed = await commands.close(watching, identity, 'w-api', false)
  assert.equal(closed.ok, true, closed.text)
  assert.deepEqual(seen, ['closing'])
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.equal(seat?.state, 'closed')
  assert.deepEqual(seat?.attention, [])
  assert.ok(fake.herdrCalls().includes('pane close'))
})

test('a report filed while herdr starts the agent survives the spawn bookkeeping', async () => {
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  fake.onStart = async name => {
    await updateRoster(deps.home, RUN, roster => ({
      ...roster,
      seats: roster.seats.map(seat =>
        agentName(RUN, seat.name) === name ? { ...seat, owes: 'review', lastReport: { id: 'r1', kind: 'done', expects: 'review', summary: 'early', at: deps.clock.now().toISOString() } } : seat,
      ),
    }))
  }
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.equal(seat?.lastReport?.id, 'r1')
  assert.equal(seat?.owes, 'review')
  assert.equal(seat?.state, 'working')
})

test('close --remove-worktree keeps an unmerged worktree and removes a merged one', async () => {
  const { deps, identity, repo } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const worktree = join(repo, '.claude', 'worktrees', 'w-api')
  await writeFile(join(worktree, 'a.txt'), 'x\n')
  await git(worktree, 'add', 'a.txt')
  await git(worktree, 'commit', '-q', '-m', 'work')
  const kept = await commands.close(deps, identity, 'w-api', true)
  assert.match(kept.text, /Branch worktree-w-api is not merged into main, so the worktree .* was kept/)
  assert.ok(existsSync(worktree))

  await git(repo, 'merge', '--no-ff', '-q', '-m', 'merge', 'worktree-w-api')
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const removed = await commands.close(deps, identity, 'w-api', true)
  assert.match(removed.text, /Removed worktree/)
  assert.equal(existsSync(worktree), false)
})

test('promote on a settled Claude worker restarts it with --resume and the new model, in a new pane in its worktree', async () => {
  const { fake, deps, identity, repo } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const { updateRoster } = await import('../src/roster.ts')
  await updateRoster(deps.home, RUN, roster => ({
    ...roster,
    seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, owes: 'answer' as const, lastReport: { id: 'r-1', kind: 'promote' as const, expects: 'answer' as const, summary: 'stuck', at: '2026-10-09T10:30:00.000Z' } })),
  }))
  fake.setStatus('w-api', 'idle')
  const sessionId = (await loadRoster(deps.home, RUN)).seats[0]?.sessionId
  const promoted = await commands.promote(deps, identity, { seat: 'w-api', model: 'opus', effort: 'high', reason: 'subtle bug' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.ok(!fake.prompts.some(item => item.text === '/exit' || item.text === '/quit'))
  const starts = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start')
  assert.equal(starts.length, 2)
  const restart = starts[1] ?? []
  assert.equal(restart[restart.indexOf('--resume') + 1], sessionId)
  assert.equal(restart[restart.indexOf('--model') + 1], 'claude-opus-5-5')
  assert.equal(restart[restart.indexOf('--effort') + 1], 'high')
  assert.ok(!restart.includes('--session-id'))
  assert.ok(!restart.includes('--worktree'))
  assert.ok(!restart.some(arg => arg.includes('kind=promote')))
  const worktree = join(repo, '.claude', 'worktrees', 'w-api')
  const order = fake.herdrCalls()
  assert.ok(order.lastIndexOf('pane close') < order.lastIndexOf('tab create'))
  const created = fake.calls.filter(call => call[1] === 'tab' && call[2] === 'create').at(-1) ?? []
  assert.equal(created[created.indexOf('--cwd') + 1], worktree)
  assert.equal(restart[restart.indexOf('--pane') + 1], 'w1:p2')
  assert.equal(fake.prompts.length, 1)
  assert.match(fake.prompts[0]?.text ?? '', /kind=promote model=claude-opus-5-5 effort=high/)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.model, seat?.effort, seat?.state, seat?.owes], ['claude-opus-5-5', 'high', 'working', 'none'])
  assert.equal(seat?.paneId, 'w1:p2')
  assert.equal(seat?.worktree, worktree)
})

test('promote on a codex worker quits with /quit and resumes the thread', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-xyz', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  const { updateRoster } = await import('../src/roster.ts')
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, lastReport: { id: 'r-1', kind: 'done' as const, expects: 'none' as const, summary: 'ok', at: '2026-10-09T10:30:00.000Z' } })) }))
  const promoted = await commands.promote(deps, identity, { seat: 'w-cx', model: 'gpt-big', effort: 'xhigh' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.equal(fake.prompts[0]?.text, '/quit')
  const restart = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start')[1] ?? []
  const argv = restart.slice(restart.indexOf('--') + 1)
  assert.deepEqual(argv.slice(0, 2), ['resume', 'thread-xyz'])
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-big')
  assert.ok(argv.includes('model_reasoning_effort="xhigh"'))
})

test('promote --model opus resolves to the configured promoted Codex model', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-alias', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ promotedModel: { codex: 'gpt-promoted' } }))
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-cx-alias', kind: 'codex', brief })).ok, true)
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, lastReport: { id: 'r-alias', kind: 'done' as const, expects: 'none' as const, summary: 'ok', at: '2026-10-09T10:30:00.000Z' } })) }))
  const promoted = await commands.promote(deps, identity, { seat: 'w-cx-alias', model: 'opus', effort: 'xhigh' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.model, 'gpt-promoted')
  const restart = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start')[1] ?? []
  assert.match(restart.join(' '), /-m gpt-promoted/)
})

test('a codex promote marks the seat starting before the agent stops, so the restart window never reads gone', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-xyz', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, lastReport: { id: 'r-1', kind: 'done' as const, expects: 'none' as const, summary: 'ok', at: '2026-10-09T10:30:00.000Z' } })) }))
  let seen: { state?: string; derived?: string; attention?: number; agents?: number } = {}
  fake.onStart = async () => {
    const seat = (await loadRoster(deps.home, RUN)).seats[0]
    const derived = seat ? deriveState(seat, { hooks: [] }, deps.clock.now()) : undefined
    seen = { state: seat?.state, derived: derived?.state, attention: derived?.attention.length, agents: fake.agents.size }
  }
  const promoted = await commands.promote(deps, identity, { seat: 'w-cx', model: 'gpt-big', effort: 'xhigh' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.deepEqual(seen, { state: 'starting', derived: 'starting', attention: 0, agents: 0 })
})

const probed = (deps: Deps) => {
  const snapshots: { call: string[]; since: string | undefined }[] = []
  const probe: Deps = {
    ...deps,
    exec: async (argv, options) => {
      snapshots.push({ call: [...argv], since: (await loadRoster(deps.home, RUN)).seats[0]?.restartingSince })
      return deps.exec(argv, options)
    },
  }
  return { probe, snapshots }
}

const startsOf = (snapshots: { call: string[]; since: string | undefined }[]) => snapshots.filter(item => item.call[1] === 'agent' && item.call[2] === 'start')
const quitsOf = (snapshots: { call: string[]; since: string | undefined }[]) => snapshots.filter(item => item.call[2] === 'prompt' && item.call[4] === '/quit')

const idleCodex = async (fake: FakeHerdr) => {
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, lastReport: { id: 'r-1', kind: 'done' as const, expects: 'none' as const, summary: 'ok', at: '2026-10-09T10:30:00.000Z' } })) }))
  return { deps, identity }
}

test('a codex promote holds restartingSince from before /quit to the end, and clears it on success', async () => {
  const { deps, identity } = await idleCodex(new FakeHerdr({ startSession: 'thread-xyz', startStatus: 'idle' }))
  const { probe, snapshots } = probed(deps)
  const promoted = await commands.promote(probe, identity, { seat: 'w-cx', model: 'gpt-big', effort: 'xhigh' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.ok(quitsOf(snapshots)[0]?.since, 'set before /quit is typed')
  assert.ok(startsOf(snapshots).at(-1)?.since, 'still set when the resumed agent starts')
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.equal(seat?.restartingSince, undefined)
  assert.equal(seat?.state, 'working')
})

test('a promote that cannot stop the agent clears restartingSince and restores the state', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-xyz', startStatus: 'idle' })
  const { deps, identity } = await idleCodex(fake)
  fake.agents.delete = () => false
  const { probe, snapshots } = probed(deps)
  const promoted = await commands.promote(probe, identity, { seat: 'w-cx', model: 'gpt-big', effort: 'xhigh' })
  assert.equal(!promoted.ok && promoted.code, 'restart')
  assert.ok(quitsOf(snapshots)[0]?.since, 'set before /quit is typed')
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.equal(seat?.restartingSince, undefined)
  assert.equal(seat?.state, 'idle')
})

test('a promote whose restart fails clears restartingSince and leaves the seat gone', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-xyz', startStatus: 'idle' })
  const { deps, identity } = await idleCodex(fake)
  const { probe, snapshots } = probed(deps)
  fake.startFails = 'agent_start_failed'
  const promoted = await commands.promote(probe, identity, { seat: 'w-cx', model: 'gpt-big', effort: 'xhigh' })
  assert.equal(!promoted.ok && promoted.code, 'restart')
  assert.ok(quitsOf(snapshots)[0]?.since, 'set before /quit is typed')
  assert.ok(startsOf(snapshots).at(-1)?.since, 'still set when the resumed agent starts')
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.equal(seat?.restartingSince, undefined)
  assert.equal(seat?.state, 'gone')
})

test('a promote that throws midway still clears restartingSince', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-xyz', startStatus: 'idle' })
  const { deps, identity } = await idleCodex(fake)
  const { probe, snapshots } = probed(deps)
  const failing: Deps = { ...probe, exec: async (argv, options) => (argv[1] === 'agent' && argv[2] === 'start' ? Promise.reject(new Error('boom')) : probe.exec(argv, options)) }
  await assert.rejects(commands.promote(failing, identity, { seat: 'w-cx', model: 'gpt-big', effort: 'xhigh' }), /boom/)
  assert.ok(quitsOf(snapshots)[0]?.since, 'set before /quit is typed')
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.restartingSince, undefined)
})

test('up --seat holds restartingSince while it relaunches and clears it on success and on failure', async () => {
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await killedMidTurn(fake, deps)
  const first = probed(deps)
  const relaunched = await commands.up(first.probe, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(relaunched.ok, true, relaunched.text)
  assert.ok(startsOf(first.snapshots).at(-1)?.since, 'set while the agent starts')
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.restartingSince, undefined)

  await killedMidTurn(fake, deps)
  fake.startFails = 'agent_start_failed'
  const second = probed(deps)
  const failed = await commands.up(second.probe, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(!failed.ok && failed.code, 'relaunch')
  assert.ok(startsOf(second.snapshots).at(-1)?.since, 'set while the agent starts')
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.equal(seat?.restartingSince, undefined)
  assert.equal(seat?.state, 'gone')
})

test('promote mid-turn is queued until the seat is idle, not restarted', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const promoted = await commands.promote(deps, identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.equal(promoted.ok, true)
  assert.match(promoted.text, /Queued until w-api is idle/)
  assert.equal(fake.prompts.length, 0)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats[0]?.pendingPromote, { model: 'claude-opus-5-5', effort: 'high' })
})

test('applyPendingPromotes completes a queued promote once the seat has settled', async () => {
  const { fake, deps, identity, run } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  await commands.promote(deps, identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.deepEqual(await commands.applyPendingPromotes(deps, run), [])
  const { updateRoster } = await import('../src/roster.ts')
  await updateRoster(deps.home, RUN, roster => ({
    ...roster,
    seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, lastReport: { id: 'r-1', kind: 'done' as const, expects: 'none' as const, summary: 'ok', at: '2026-10-09T10:30:00.000Z' } })),
  }))
  fake.setStatus('w-api', 'idle')
  const results = await commands.applyPendingPromotes(deps, run)
  assert.deepEqual(results.map(item => item.ok), [true])
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.model, seat?.pendingPromote], ['claude-opus-5-5', undefined])
  assert.equal(fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').length, 2)
})

test('promote on a Claude worker with the mod only updates the roster and sends a control', async () => {
  const { fake, deps, identity } = await setup(new FakeHerdr(), { planner: { kind: 'claude', paneId: 'w1:p0', model: 'claude-opus-5-5', effort: 'high', viaMod: true } })
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  fake.setStatus('w-api', 'idle')
  const promoted = await commands.promote(deps, identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.ok(!fake.prompts.some(item => item.text === '/exit'))
  assert.match(fake.prompts[0]?.text ?? '', /kind=promote model=claude-opus-5-5 effort=high/)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.model, 'claude-opus-5-5')
})

test('roster refreshes states from herdr and prints one line per seat plus the attention list', async () => {
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  fake.setStatus('w-api', 'blocked')
  const listed = await commands.roster(deps, { run: RUN, repo: '/nowhere' }, false)
  assert.equal(listed.ok, true)
  assert.match(listed.text, /^run drove-20261009-1042-a3f1 · /)
  assert.match(listed.text, /- w-api \[blocked\] claude Sonnet 5\.5 medium/)
  assert.match(listed.text, /needs attention:\n- w-api: dialog/)
  const json = await commands.roster(deps, { run: RUN, repo: '/nowhere' }, true)
  assert.equal(JSON.parse(json.ok ? json.text : '{}').seats[0].state, 'blocked')
})

test('roster marks a vanished pane gone', async () => {
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  fake.agents.clear()
  const listed = await commands.roster(deps, { run: RUN, repo: '/nowhere' }, false)
  assert.match(listed.text, /\[gone\]/)
  assert.match(listed.text, /drove up --seat w-api/)
})

test('capture reads the seat through herdr', async () => {
  const fake = new FakeHerdr({ screen: 'last lines' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const captured = await commands.capture(deps, { run: RUN, repo: '/nowhere' }, 'w-api', 20)
  assert.deepEqual([captured.ok, captured.text], [true, 'last lines'])
  assert.ok(fake.calls.some(call => call[2] === 'read' && call[3] === 'w1:p1'))
})

test('capture falls back to the pane read while the agent read refuses', async () => {
  const fake = new FakeHerdr({ screen: 'busy lines', agentReadFails: 'agent_not_idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const captured = await commands.capture(deps, { run: RUN, repo: '/nowhere' }, 'w-api', 20)
  assert.deepEqual([captured.ok, captured.text], [true, 'busy lines'])
  assert.ok(fake.find('herdr', 'pane', 'read', 'w1:p1'))
})

test('capture names the pane read code when both reads fail', async () => {
  const fake = new FakeHerdr({ agentReadFails: 'agent_not_idle', paneReadFails: 'pane_not_found' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const captured = await commands.capture(deps, { run: RUN, repo: '/nowhere' }, 'w-api', 20)
  assert.equal(captured.ok, false)
  assert.match(captured.text, /could not read w-api: pane_not_found/)
})

test('capture does not read the pane when the agent read succeeds', async () => {
  const fake = new FakeHerdr({ screen: 'fine' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const before = fake.calls.length
  await commands.capture(deps, { run: RUN, repo: '/nowhere' }, 'w-api', 20)
  assert.equal(fake.calls.slice(before).some(call => call[1] === 'pane' && call[2] === 'read'), false)
})

test('goal sets and replaces the run goal, records goal.set and takes a Cairn ref', async () => {
  const { deps } = await setup()
  const first = await commands.setGoal(deps, { run: RUN, repo: '/x' }, { goal: '  Work\nDROVE-86  ' })
  assert.equal(first.ok, true)
  assert.equal((await loadRun(deps.home, RUN))?.goal, 'Work DROVE-86')
  const second = await commands.setGoal(deps, { run: RUN, repo: '/x' }, { goal: 'Release 0.3.0', cairn: 'DROVE-102' })
  assert.equal(second.ok, true)
  const run = await loadRun(deps.home, RUN)
  assert.deepEqual([run?.goal, run?.cairn], ['Release 0.3.0', 'DROVE-102'])
  const events = (await readEvents(deps)).filter(item => item.type === 'goal.set')
  assert.deepEqual(events.map(item => item.data), [{ goal: 'Work DROVE-86' }, { goal: 'Release 0.3.0', cairn: 'DROVE-102', previous: 'Work DROVE-86' }])
  const kept = await commands.setGoal(deps, { run: RUN, repo: '/x' }, { goal: 'Software factory' })
  assert.equal((await loadRun(deps.home, RUN))?.cairn, 'DROVE-102')
  assert.equal(kept.ok, true)
})

test('goal refuses an empty line, a bad ref, an unknown run and a worker', async () => {
  const { deps } = await setup()
  const empty = await commands.setGoal(deps, { run: RUN, repo: '/x' }, { goal: '  ' })
  assert.equal(!empty.ok && empty.code, 'usage')
  const bad = await commands.setGoal(deps, { run: RUN, repo: '/x' }, { goal: 'x', cairn: 'nope' })
  assert.equal(!bad.ok && bad.code, 'usage')
  const missing = await commands.setGoal(deps, { run: 'nothing', repo: '/x' }, { goal: 'x' })
  assert.equal(!missing.ok && missing.code, 'no-run')
  process.env.DROVE_ROLE = 'worker'
  const denied = await commands.setGoal(deps, { run: RUN, repo: '/x' }, { goal: 'x' })
  assert.equal(!denied.ok && denied.code, 'forbidden')
  assert.equal((await loadRun(deps.home, RUN))?.goal, undefined)
})

test('budget is for the human only and validates the number', async () => {
  const { deps } = await setup()
  const raised = await commands.budget(deps, { run: RUN, repo: '/x' }, 6)
  assert.equal(raised.ok, true)
  assert.equal((await loadRun(deps.home, RUN))?.budget, 6)
  assert.equal((await commands.budget(deps, { run: RUN, repo: '/x' }, 0)).ok, false)
  process.env.DROVE_ROLE = 'planner'
  const denied = await commands.budget(deps, { run: RUN, repo: '/x' }, 9)
  assert.equal(!denied.ok && denied.code, 'forbidden')
  assert.equal((await loadRun(deps.home, RUN))?.budget, 6)
})

test('down saves session ids and closes everything; up relaunches each seat with resume and the planner resume plan', async () => {
  const fake = new FakeHerdr({ startSession: 'codex-thread' })
  const { deps, identity, repo } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await commands.spawn(deps, identity, { seat: 'w-b', kind: 'codex', brief })
  fake.setStatus('w-a', 'idle')
  fake.setStatus('w-b', 'idle')
  const downed = await commands.down(deps, { run: RUN, repo: '/x' })
  assert.equal(downed.ok, true, downed.text)
  assert.match(downed.text, /2 seat\(s\) saved/)
  assert.equal(fake.agents.size, 0)
  assert.deepEqual(fake.prompts.map(item => item.text), ['/quit'])
  assert.ok(fake.find('herdr', 'pane', 'close', 'w1:p1'))
  assert.ok(fake.herdrCalls().includes('tab close'))
  assert.equal((await loadRun(deps.home, RUN))?.status, 'down')
  const seats = (await loadRoster(deps.home, RUN)).seats
  assert.deepEqual(seats.map(seat => seat.state), ['down', 'down'])
  assert.ok(seats.every(seat => seat.sessionId))

  process.env.HERDR_PANE_ID = 'w1:p77'
  const upped = await commands.up(deps, { run: RUN, repo: '/x' })
  assert.equal(upped.ok, true, upped.text)
  const starts = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').slice(2)
  assert.equal(starts.length, 2)
  assert.ok(starts[0]?.includes('--resume'))
  assert.ok(!starts[0]?.includes('--worktree'))
  assert.ok(starts[1]?.includes('resume'))
  const placedAt = fake.calls.filter(call => call[1] === 'tab' || (call[1] === 'pane' && call[2] === 'split')).filter(call => call[2] === 'create' || call[2] === 'split').slice(-2).map(call => call[call.indexOf('--cwd') + 1])
  assert.deepEqual(placedAt, [join(repo, '.claude', 'worktrees', 'w-a'), join(repo, '.claude', 'worktrees', 'w-b')])
  const plan = upped.ok ? (upped.data as commands.ProcessPlan) : undefined
  assert.equal(plan?.argv[0], 'claude')
  assert.ok(plan?.argv.includes('--resume'))
  assert.equal(plan?.argv[plan.argv.indexOf('--resume') + 1], 'planner-session')
  assert.equal(plan?.env.DROVE_ROLE, 'planner')
  const run = await loadRun(deps.home, RUN)
  assert.equal(run?.status, 'up')
  assert.equal(run?.planner.paneId, 'w1:p77')
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats.map(seat => seat.state), ['working', 'working'])
})

test('up --seat relaunches only a dead seat, and refuses a live one or one with no session', async () => {
  const fake = new FakeHerdr()
  const { deps, identity, repo } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  const live = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(!live.ok && live.code, 'not-dead')
  fake.agents.clear()
  await commands.roster(deps, { run: RUN, repo: '/x' }, false)
  const relaunched = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(relaunched.ok, true, relaunched.text)
  const restart = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').at(-1) ?? []
  assert.ok(restart.includes('--resume'))
  assert.ok(!restart.includes('--worktree'))
  assert.match(restart.at(-1) ?? '', /Resumed by Drove/)
  const placed = fake.calls.filter(call => call[1] === 'pane' && call[2] === 'split' || call[1] === 'tab' && call[2] === 'create').at(-1) ?? []
  assert.equal(placed[placed.indexOf('--cwd') + 1], join(repo, '.claude', 'worktrees', 'w-a'))

  const { updateRoster } = await import('../src/roster.ts')
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: [{ ...makeSeat('w-x', { kind: 'codex', state: 'gone' }) }] }))
  const none = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-x')
  assert.equal(!none.ok && none.code, 'relaunch')
  assert.match(none.text, /no saved session id/)
  const events = (await readEvents(deps)).filter(item => item.type === 'seat.relaunch')
  assert.equal(events.length, 2)
  assert.equal(events[0]?.seat, 'w-a')
  assert.equal(events[0]?.data?.ok, true)
  assert.equal(events[0]?.data?.resumed, true)
  assert.ok(events[0]?.data?.pane)
  assert.equal(events[1]?.seat, 'w-x')
  assert.equal(events[1]?.data?.ok, false)
  assert.match(String(events[1]?.data?.error), /no saved session id/)
})

const settleSeat = async (deps: Deps, fake: FakeHerdr, name: string) => {
  await updateRoster(deps.home, RUN, roster => ({
    ...roster,
    seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, owes: 'none' as const, lastReport: { id: 'r-1', kind: 'done' as const, expects: 'none' as const, summary: 'ok', at: '2099-01-01T00:00:00.000Z' } })),
  }))
  fake.setStatus(name, 'idle')
}

const killedMidTurn = async (fake: FakeHerdr, deps: Deps) => {
  fake.agents.clear()
  await commands.roster(deps, { run: RUN, repo: '/x' }, false)
}

test('by default up --seat resumes with no prompt argument and sends the resume notice by herdr prompt', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await killedMidTurn(fake, deps)
  const relaunched = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(relaunched.ok, true, relaunched.text)
  const restart = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').at(-1) ?? []
  assert.ok(restart.includes('--resume'))
  assert.ok(!restart.some(arg => arg.includes('Resumed by Drove')))
  assert.equal(fake.prompts.at(-1)?.text, 'Resumed by Drove after a restart: carry on, and report when done.')
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.state, 'working')
})

test('a slow resumed turn does not fail up --seat: the notice is typed and the seat stays', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const fake = new FakeHerdr({ promptTimesOut: true })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await killedMidTurn(fake, deps)
  const closesBefore = fake.herdrCalls().filter(call => call === 'pane close').length
  const relaunched = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(relaunched.ok, true, relaunched.text)
  assert.equal(fake.herdrCalls().filter(call => call === 'pane close').length, closesBefore)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.equal(seat?.state, 'working')
  assert.deepEqual(seat?.attention, [])
})

test('up --seat keeps a seat whose agent start timed out but is up in the pane, and rolls back when it is absent', async () => {
  for (const mode of ['prompt', 'launch-arg'] as const) {
    process.env.DROVE_BRIEF_VIA = mode
    const fake = new FakeHerdr()
    const { deps, identity } = await setup(fake)
    await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
    await killedMidTurn(fake, deps)
    Object.assign(fake, { startFails: 'timeout', startLeavesAgent: true, startStatus: 'working' })
    const closesBefore = fake.herdrCalls().filter(call => call === 'pane close').length
    const kept = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a')
    assert.equal(kept.ok, true, `${mode}: ${kept.text}`)
    assert.equal(fake.herdrCalls().filter(call => call === 'pane close').length, closesBefore, mode)
    const seat = (await loadRoster(deps.home, RUN)).seats[0]
    assert.equal(seat?.state, 'working', mode)
    assert.equal(seat?.paneId, fake.seatAgent('w-a')?.paneId, mode)
    assert.equal(fake.prompts.some(item => item.text.includes('Resumed by Drove')), mode === 'prompt', mode)
  }

  const absent = new FakeHerdr()
  const { deps, identity } = await setup(absent)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await killedMidTurn(absent, deps)
  absent.startFails = 'timeout'
  const rolledBack = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(!rolledBack.ok && rolledBack.code, 'relaunch')
  assert.ok(absent.herdrCalls().includes('pane close'))
})

test('AC7: up --seat that stops at the folder-trust prompt keeps the pane and blocks the seat on trust, not a generic dialog (DROVE-167)', async () => {
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await killedMidTurn(fake, deps)
  Object.assign(fake, { startFails: 'timeout', startLeavesAgent: true, startStatus: 'blocked', screen: FOLDER_TRUST_SCREEN })
  const relaunched = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(relaunched.ok, true, relaunched.text)
  const paneId = (relaunched.data as { paneId: string }).paneId
  const seat = (await loadRoster(deps.home, RUN)).seats.find(entry => entry.name === 'w-a')
  assert.deepEqual([seat?.state, seat?.paneId, seat?.attention.map(item => item.reason)], ['blocked', paneId, ['trust']])
  assert.match(seat?.attention[0]?.detail ?? '', new RegExp(`folder-trust prompt is waiting in pane ${paneId}\\. Accept it in the pane`))
  assert.match(seat?.attention[0]?.detail ?? '', /run `drove trust /)
  assert.equal(fake.calls.some(call => call[1] === 'pane' && call[2] === 'close' && call[3] === paneId), false, 'the pane at the prompt is kept')
})

test('promote with a slow resumed turn still succeeds: the notice is typed and unconfirmed', async () => {
  const fake = new FakeHerdr({ promptTimesOut: true })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  await settleSeat(deps, fake, 'w-api')
  const promoted = await commands.promote(deps, identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.match(promoted.text, /herdr did not confirm/)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.model, seat?.state], ['claude-opus-5-5', 'working'])
  const sent = (await readEvents(deps)).filter(item => item.type === 'control.sent').at(-1)
  assert.equal(sent?.data?.unconfirmed, true)
})

test('promote with a slow resumed turn is confirmed by the seat\'s hook record', async () => {
  const fake = new FakeHerdr({ promptTimesOut: true })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  await settleSeat(deps, fake, 'w-api')
  const base = deps.exec
  deps.exec = async (argv, options) => {
    if (argv[1] === 'agent' && argv[2] === 'prompt') await appendFile(join(seatDir(deps.home, RUN, 'w-api'), 'hooks.jsonl'), `${JSON.stringify({ at: new Date(Date.now() + 60_000).toISOString(), agent: 'claude', event: 'user-prompt-submit' })}\n`)
    return base(argv, options)
  }
  const promoted = await commands.promote(deps, identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.doesNotMatch(promoted.text, /herdr did not confirm/)
  const sent = (await readEvents(deps)).filter(item => item.type === 'control.sent').at(-1)
  assert.equal(sent?.data?.unconfirmed, undefined)
})

test('promote keeps the restarted seat when agent start timed out but the agent is up, and marks it gone when it is not', async () => {
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  await settleSeat(deps, fake, 'w-api')
  Object.assign(fake, { startFails: 'timeout', startLeavesAgent: true, startStatus: 'working' })
  const promoted = await commands.promote(deps, identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.match(promoted.text, /timed out but the agent is up in the pane/)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.model, seat?.state, seat?.paneId], ['claude-opus-5-5', 'working', fake.seatAgent('w-api')?.paneId])
  assert.match(fake.prompts.at(-1)?.text ?? '', /kind=promote/)
  const sent = (await readEvents(deps)).filter(item => item.type === 'control.sent').at(-1)
  assert.equal(sent?.data?.startTimeout, true)

  const absent = new FakeHerdr()
  const second = await setup(absent)
  await commands.spawn(second.deps, second.identity, { seat: 'w-api', kind: 'claude', brief })
  await settleSeat(second.deps, absent, 'w-api')
  absent.startFails = 'timeout'
  const failed = await commands.promote(second.deps, second.identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.equal(!failed.ok && failed.code, 'restart')
  assert.equal((await loadRoster(second.deps.home, RUN)).seats[0]?.state, 'gone')
})

const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid

const lockWorktree = (repo: string, seat: string, reason: string): Promise<string> => git(repo, 'worktree', 'lock', '--reason', reason, join(repo, '.claude', 'worktrees', seat))

const isLocked = async (repo: string, seat: string): Promise<boolean> => {
  const listed = await git(repo, 'worktree', 'list', '--porcelain')
  const block = listed.split('\n\n').find(entry => entry.includes(`/.claude/worktrees/${seat}\n`) || entry.endsWith(`/.claude/worktrees/${seat}`))
  return /^locked\b/m.test(block ?? '')
}

test('relaunch clears a stale Claude lock before agent start, and leaves a live pid or a foreign lock alone', async () => {
  const cases = [
    { name: 'dead pid', reason: `claude session w-a (pid ${deadPid()} start Sat Oct 10 06:32:48 2026)`, unlocked: true },
    { name: 'live pid', reason: `claude session w-a (pid ${process.pid})`, unlocked: false },
    { name: 'foreign lock', reason: 'held by hand', unlocked: false },
  ]
  for (const { name, reason, unlocked } of cases) {
    const fake = new FakeHerdr()
    const { deps, identity, repo } = await setup(fake)
    await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
    await killedMidTurn(fake, deps)
    await lockWorktree(repo, 'w-a', reason)
    assert.equal(await isLocked(repo, 'w-a'), true, name)
    const relaunched = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a')
    assert.equal(relaunched.ok, true, `${name}: ${relaunched.text}`)
    assert.equal(await isLocked(repo, 'w-a'), !unlocked, name)
    const unlock = fake.calls.findIndex(call => call.includes('unlock'))
    const start = fake.calls.findLastIndex(call => call[1] === 'agent' && call[2] === 'start')
    assert.equal(unlock >= 0, unlocked, name)
    if (unlocked) assert.ok(unlock < start, `${name}: unlock comes before agent start`)
    assert.match(relaunched.text, name === 'live pid' ? /locked by a running Claude/ : /^Relaunched w-a in pane \S+ with resume\.$/, name)
  }
})

test('promote clears a stale Claude lock between closing the pane and starting the resumed agent', async () => {
  const { fake, deps, identity, repo } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  await settleSeat(deps, fake, 'w-api')
  await lockWorktree(repo, 'w-api', `claude session w-api (pid ${deadPid()})`)
  const promoted = await commands.promote(deps, identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.equal(await isLocked(repo, 'w-api'), false)
  const unlock = fake.calls.findIndex(call => call.includes('unlock'))
  const close = fake.calls.findIndex(call => call[1] === 'pane' && call[2] === 'close')
  const start = fake.calls.findLastIndex(call => call[1] === 'agent' && call[2] === 'start')
  assert.ok(close < unlock && unlock < start)
})

test('promote leaves a lock held by a live Claude alone and says so', async () => {
  const { fake, deps, identity, repo } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  await settleSeat(deps, fake, 'w-api')
  await lockWorktree(repo, 'w-api', `claude session w-api (pid ${process.pid})`)
  const promoted = await commands.promote(deps, identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.match(promoted.text, /locked by a running Claude \(pid \d+\), so the lock was left alone/)
  assert.equal(await isLocked(repo, 'w-api'), true)
})

test('down closes each Claude pane without typing anything and saves the session ids it minted at launch', async () => {
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await commands.spawn(deps, identity, { seat: 'w-b', kind: 'claude', brief })
  const minted = (await loadRoster(deps.home, RUN)).seats.map(seat => seat.sessionId)
  assert.ok(minted.every(Boolean))
  const downed = await commands.down(deps, { run: RUN, repo: '/x' })
  assert.equal(downed.ok, true, downed.text)
  assert.equal(fake.prompts.length, 0)
  assert.equal(fake.calls.filter(call => call[1] === 'pane' && call[2] === 'close').length, 2)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats.map(seat => [seat.state, seat.sessionId]), [['down', minted[0]], ['down', minted[1]]])
  assert.equal((await loadRun(deps.home, RUN))?.tabId, undefined)
})

test('plan creates a run, writes the planner files and returns the exec plan', async () => {
  const repo = await makeRepo()
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake)
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan(deps, { repo, kind: 'claude', goal: 'Ship the thing' })
  assert.equal(planned.ok, true, planned.text)
  const plan = (planned.ok ? planned.data : undefined) as commands.ProcessPlan
  assert.equal(plan.argv[0], 'claude')
  assert.ok(!plan.argv.includes('--dangerously-skip-permissions'))
  assert.equal(plan.argv.at(-1), 'Ship the thing')
  assert.equal(plan.env.DROVE_ROLE, 'planner')
  assert.equal(plan.cwd, await realpath(repo))
  const id = plan.env.DROVE_RUN as string
  const run = await loadRun(deps.home, id)
  assert.deepEqual([run?.status, run?.base, run?.hasRemote, run?.planner.paneId, run?.goal], ['up', 'main', false, 'w1:p5', 'Ship the thing'])
  assert.ok(run?.planner.sessionId)
  assert.ok(existsSync(join(deps.home, 'runs', id, 'planner', 'settings.json')))
})

test('plan for codex has an initial prompt and no session id yet; it needs a herdr pane and a repo', async () => {
  const repo = await makeRepo()
  const deps = await makeDeps(new FakeHerdr())
  const outside = await commands.plan(deps, { repo, kind: 'codex' })
  assert.equal(!outside.ok && outside.code, 'not-in-herdr')
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan(deps, { repo, kind: 'codex' })
  const plan = (planned.ok ? planned.data : undefined) as commands.ProcessPlan
  assert.equal(plan.argv[0], 'codex')
  assert.equal(plan.argv.at(-1), 'Read the roster and wait for the human.')
  assert.equal((await loadRun(deps.home, plan.env.DROVE_RUN as string))?.planner.sessionId, undefined)
  process.env.HERDR_PANE_ID = 'w1:p6'
  const notRepo = await commands.plan(deps, { repo: deps.home, kind: 'claude' })
  assert.equal(!notRepo.ok && notRepo.code, 'not-a-repo')
})

test('loadConfig merges ~/.drove/config.json over the defaults', async () => {
  const deps = await makeDeps(new FakeHerdr())
  assert.deepEqual(await commands.loadConfig(deps.home), commands.DEFAULT_CONFIG)
  await writeFile(
    join(deps.home, 'config.json'),
    JSON.stringify({ humanName: 'Sam', workerModel: { codex: 'gpt-x' }, claudeChannel: true, workerEnv: { WORKER_FLAG: '1', NOT_TEXT: 2, 'BAD NAME': 'x' } }),
  )
  const config = await commands.loadConfig(deps.home)
  assert.equal(config.humanName, 'Sam')
  assert.deepEqual(config.workerEnv, { WORKER_FLAG: '1' })
  assert.deepEqual(config.workerModel, { claude: 'claude-sonnet-5-5', codex: 'gpt-x' })
  assert.equal(config.claudeChannel, true)
  assert.equal(config.budget, 5)
})

test('identityOrPlanner falls back to a planner identity without a run', () => {
  assert.deepEqual(commands.identityOrPlanner({ DROVE_HOME: '/h' }), { home: '/h', run: '', role: 'planner', seat: 'planner' })
  const env = { DROVE_HOME: '/h', DROVE_RUN: 'r', DROVE_ROLE: 'worker', DROVE_SEAT: 'w-a', DROVE_TOKEN: 't' }
  assert.equal(commands.identityOrPlanner(env).role, 'worker')
})

test('nodeExec captures output, passes input and reports a missing binary', async () => {
  const echoed = await commands.nodeExec(['cat'], { input: 'hi' })
  assert.deepEqual([echoed.code, echoed.stdout], [0, 'hi'])
  const missing = await commands.nodeExec(['definitely-not-a-binary-xyz'])
  assert.equal(missing.code, 127)
  const slow = await commands.nodeExec(['sleep', '5'], { timeoutMs: 50 })
  assert.equal(slow.code, 124)
})

const withPromptAfter = (fake: FakeHerdr, reads: number): { paneReads: () => number } => {
  const inner = fake.exec
  let paneReads = 0
  fake.exec = async argv => {
    if (argv[1] === 'pane' && argv[2] === 'read') {
      paneReads += 1
      fake.screen = paneReads >= reads ? 'user@host drove % ' : 'Last login: Sat Oct 10'
    }
    return inner(argv)
  }
  return { paneReads: () => paneReads }
}

const startIndexes = (fake: FakeHerdr): number[] => fake.calls.flatMap((call, index) => (call[1] === 'agent' && call[2] === 'start' ? [index] : []))

test('the agent is started only once the pane shows a stable shell prompt', async () => {
  Object.assign(commands.timing, { promptWaitMs: 200 })
  const fake = new FakeHerdr()
  const { paneReads } = withPromptAfter(fake, 4)
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const start = startIndexes(fake)[0] ?? -1
  const readsBefore = fake.calls.slice(0, start).filter(call => call[1] === 'pane' && call[2] === 'read').length
  assert.ok(readsBefore >= 5, `prompt first appears at read 4 and must hold for a second read, saw ${readsBefore}`)
  assert.ok(paneReads() >= 5)
})

test('every pane Drove creates for an agent has the powerlevel10k instant prompt off', async () => {
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'codex', brief })
  await commands.spawn(deps, identity, { seat: 'w-b', kind: 'claude', brief })
  const created = fake.calls.filter(call => call[0] === 'herdr' && ((call[1] === 'tab' && call[2] === 'create') || (call[1] === 'pane' && call[2] === 'split')))
  assert.deepEqual(created.map(call => call.slice(1, 3).join(' ')), ['tab create', 'pane split'])
  for (const call of created) assert.ok(call.some((arg, index) => arg === 'POWERLEVEL9K_INSTANT_PROMPT=off' && call[index - 1] === '--env'), call.join(' '))
})

test('a shell that never shows a prompt does not hang the start: the wait is bounded and the line is typed anyway', async () => {
  const fake = new FakeHerdr({ screen: 'Last login: Sat Oct 10' })
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal(startIndexes(fake).length, 1)
})

test('an agent that never appears is retried once in a fresh pane, and not a second time', async () => {
  for (const succeedsOnRetry of [true, false]) {
    const fake = new FakeHerdr({ startFails: 'timeout' })
    if (succeedsOnRetry) {
      const inner = fake.exec
      fake.exec = async argv => {
        const out = await inner(argv)
        if (argv[1] === 'agent' && argv[2] === 'start') fake.startFails = undefined
        return out
      }
    }
    const { deps, identity } = await setup(fake)
    const spawned = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
    assert.equal(spawned.ok, succeedsOnRetry, spawned.text)
    assert.equal(startIndexes(fake).length, 2, `succeedsOnRetry=${succeedsOnRetry}`)
    const retries = (await readEvents(deps)).filter(item => item.type === 'seat.state' && item.data?.startRetry === true)
    assert.equal(retries.length, 1)
    const starts = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start')
    assert.notEqual(starts[0]?.[starts[0].indexOf('--pane') + 1], starts[1]?.[starts[1].indexOf('--pane') + 1])
    if (!succeedsOnRetry) assert.deepEqual((await loadRoster(deps.home, RUN)).seats, [])
  }
})

test('close clears the stale Claude lock once the pane is gone, and leaves a live pid or a foreign lock alone', async () => {
  const cases = [
    { name: 'dead pid', reason: `claude session w-a (pid ${deadPid()} start Sat Oct 10 06:32:48 2026)`, unlocked: true },
    { name: 'live pid', reason: `claude session w-a (pid ${process.pid})`, unlocked: false },
    { name: 'foreign lock', reason: 'held by hand', unlocked: false },
  ]
  for (const { name, reason, unlocked } of cases) {
    const fake = new FakeHerdr()
    const { deps, identity, repo } = await setup(fake)
    await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
    await lockWorktree(repo, 'w-a', reason)
    const closed = await commands.close(deps, identity, 'w-a', false)
    assert.equal(closed.ok, true, `${name}: ${closed.text}`)
    assert.equal(await isLocked(repo, 'w-a'), !unlocked, name)
    const unlock = fake.calls.findIndex(call => call.includes('unlock'))
    const paneClose = fake.calls.findIndex(call => call[1] === 'pane' && call[2] === 'close')
    assert.equal(unlock >= 0, unlocked, name)
    if (unlocked) assert.ok(paneClose < unlock, `${name}: the lock is cleared after the pane closes`)
    if (name === 'live pid') assert.match(closed.text, /locked by a running Claude/)
  }
})

test('promote takes the session id from the session-start hook when the roster has none yet', async () => {
  const { appendJsonl } = await import('../src/store.ts')
  const fake = new FakeHerdr({ startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief, model: 'gpt-5.5' })
  await settleSeat(deps, fake, 'w-cx')
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, sessionId: undefined })) }))
  const refused = await commands.promote(deps, identity, { seat: 'w-cx', model: 'gpt-big', effort: 'high' })
  assert.equal(!refused.ok && refused.code, 'no-session')
  await appendJsonl(join(seatDir(deps.home, RUN, 'w-cx'), 'hooks.jsonl'), { at: '2026-10-10T12:39:17.330Z', agent: 'codex', event: 'session-start', sessionId: 'thread-from-hook' })
  const promoted = await commands.promote(deps, identity, { seat: 'w-cx', model: 'gpt-big', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  const restart = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start')[1] ?? []
  const after = restart.slice(restart.indexOf('--') + 1)
  assert.deepEqual(after.slice(0, 2), ['resume', 'thread-from-hook'])
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.sessionId, 'thread-from-hook')
})

test('promote of a codex seat without a model keeps the seat model, and the resumed launch line carries no role', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-xyz', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief, model: 'gpt-5.5' })
  await settleSeat(deps, fake, 'w-cx')
  const promoted = await commands.promote(deps, identity, { seat: 'w-cx', model: '', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  const restart = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start')[1] ?? []
  const argv = restart.slice(restart.indexOf('--') + 1)
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5.5')
  assert.ok(argv.includes('model_reasoning_effort="high"'))
  assert.ok(!argv.some(arg => arg.startsWith('developer_instructions=')))
})

const startArgv = (fake: FakeHerdr): string[] => {
  const call = fake.calls.filter(item => item[1] === 'agent' && item[2] === 'start').at(-1) ?? []
  return call.slice(call.indexOf('--') + 1)
}
const placedEnv = (fake: FakeHerdr): string[] => {
  const call = fake.calls.filter(item => (item[1] === 'pane' && item[2] === 'split') || (item[1] === 'tab' && item[2] === 'create')).at(-1) ?? []
  return call.filter((_, index) => call[index - 1] === '--env')
}
const markIdle = (deps: Deps) =>
  updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, lastReport: { id: 'r-1', kind: 'done' as const, expects: 'none' as const, summary: 'ok', at: '2026-10-09T10:30:00.000Z' } })) }))

test('a codex worker gets a Drove-owned CODEX_HOME through the pane env, recorded on the seat, and a short launch line', async () => {
  const { fake, deps, identity, repo } = await setup()
  const spawned = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.equal(seat?.codexHome, join(deps.home, 'runs', RUN, 'codex-home'))
  const home = await realpath(seat?.codexHome ?? '')
  assert.ok(placedEnv(fake).includes(`CODEX_HOME=${home}`), placedEnv(fake).join(' '))
  const argv = startArgv(fake)
  assert.ok(!argv.some(arg => /^(hooks\.|mcp_servers|projects\.)/.test(arg)), argv.join(' '))
  const config = await readFile(join(home, 'config.toml'), 'utf8')
  assert.ok(config.includes(`[projects."${repo}"]`), config)
  assert.match(config, /\[mcp_servers\.drove\]/)
  assert.match(await readFile(join(home, 'hooks.json'), 'utf8'), /pre-tool-use/)
})

test('promote and up --seat resume a codex seat with the CODEX_HOME it started with', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-xyz', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  const recorded = join(deps.home, 'runs', RUN, 'codex-home')
  await markIdle(deps)
  const promoted = await commands.promote(deps, identity, { seat: 'w-cx', model: 'gpt-big', effort: 'xhigh' })
  assert.equal(promoted.ok, true, promoted.text)
  const resumed = startArgv(fake)
  assert.deepEqual(resumed.slice(0, 2), ['resume', 'thread-xyz'])
  assert.ok(!resumed.some(arg => arg.startsWith('mcp_servers') || arg.startsWith('hooks.')), resumed.join(' '))
  const launchJson = JSON.parse(await readFile(join(seatDir(deps.home, RUN, 'w-cx'), 'launch.json'), 'utf8')) as { env: Record<string, string> }
  assert.equal(launchJson.env.CODEX_HOME, await realpath(recorded))

  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'gone' as const })) }))
  fake.agents.clear()
  const relaunched = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-cx')
  assert.equal(relaunched.ok, true, relaunched.text)
  assert.deepEqual(startArgv(fake).slice(0, 2), ['resume', 'thread-xyz'])
  assert.ok(placedEnv(fake).includes(`CODEX_HOME=${await realpath(recorded)}`), placedEnv(fake).join(' '))
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.codexHome, recorded)
})

test('a codex seat with no recorded CODEX_HOME resumes the old way: inline overrides and no CODEX_HOME', async () => {
  const fake = new FakeHerdr()
  const { deps } = await setup(fake)
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: [makeSeat('w-old', { kind: 'codex', model: 'gpt-x', state: 'gone', sessionId: 'thread-old' })] }))
  const relaunched = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-old')
  assert.equal(relaunched.ok, true, relaunched.text)
  const argv = startArgv(fake)
  assert.deepEqual(argv.slice(0, 2), ['resume', 'thread-old'])
  assert.ok(argv.some(arg => arg.startsWith('mcp_servers.drove=')))
  assert.ok(argv.some(arg => arg.startsWith('hooks.PreToolUse=')))
  assert.ok(!placedEnv(fake).some(entry => entry.startsWith('CODEX_HOME=')))
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.codexHome, undefined)
  assert.ok(!existsSync(join(deps.home, 'runs', RUN, 'codex-home')))
})

const settled = async (fake: FakeHerdr, deps: Deps, ...names: string[]) => {
  for (const name of names) fake.setStatus(name, 'idle')
  await markIdle(deps)
}

test('up adopts an up run whose planner and seat panes are all gone, keeps the session ids and resumes', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-1', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await commands.spawn(deps, identity, { seat: 'w-b', kind: 'codex', brief })
  await settled(fake, deps, 'w-a', 'w-b')
  const before = (await loadRoster(deps.home, RUN)).seats.map(seat => seat.sessionId)
  assert.ok(before.every(Boolean))
  fake.agents.clear()
  process.env.HERDR_PANE_ID = 'w1:p77'

  const upped = await commands.up(deps, { run: RUN, repo: '/x' })
  assert.equal(upped.ok, true, upped.text)
  assert.match(upped.text, /recovered after a crash: 2 seat\(s\) adopted/)
  assert.match(upped.text, /resumed w-a, w-b/)
  const starts = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').slice(2)
  assert.equal(starts.length, 2)
  assert.ok(starts[0]?.includes('--resume'))
  assert.ok(starts[1]?.includes('resume'))
  const seats = (await loadRoster(deps.home, RUN)).seats
  assert.deepEqual(seats.map(seat => seat.state), ['idle', 'idle'])
  assert.ok(seats.every(seat => seat.paneId?.startsWith('w1:p') && seat.paneId !== 'w1:p77'))
  assert.deepEqual(seats.map(seat => seat.sessionId), before)
  const plan = upped.ok ? (upped.data as commands.ProcessPlan) : undefined
  assert.equal(plan?.argv[plan.argv.indexOf('--resume') + 1], 'planner-session')
  const run = await loadRun(deps.home, RUN)
  assert.deepEqual([run?.status, run?.planner.paneId], ['up', 'w1:p77'])
  const recovered = (await readEvents(deps)).filter(item => item.type === 'run.recovered')
  assert.equal(recovered.length, 1)
  assert.deepEqual(recovered[0]?.data?.seats, ['w-a', 'w-b'])
})

test('up refuses an up run that still has a live pane and names it', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-1', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await commands.spawn(deps, identity, { seat: 'w-b', kind: 'claude', brief })
  await settled(fake, deps, 'w-a', 'w-b')
  fake.agents.delete([...fake.agents.keys()].find(name => name.startsWith('w-a')) as string)
  const livePane = fake.seatAgent('w-b')?.paneId
  assert.ok(livePane)
  process.env.HERDR_PANE_ID = 'w1:p77'
  const startsBefore = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').length
  fake.agents.set('planner', { name: 'planner', paneId: 'w1:p0', tabId: 'w1:t1', status: 'idle', sessionId: 'planner-session' })

  const refused = await commands.up(deps, { run: RUN, repo: '/x' })
  assert.equal(!refused.ok && refused.code, 'not-down')
  assert.match(refused.text, new RegExp(`w-b \\(pane ${livePane}\\)`))
  assert.doesNotMatch(refused.text, /w-a/)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats.map(seat => seat.state), ['idle', 'idle'])
  assert.equal(fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').length, startsBefore)
  assert.equal((await readEvents(deps)).filter(item => item.type === 'run.recovered').length, 0)

  fake.agents.clear()
  fake.agents.set('planner', { name: 'planner', paneId: 'w1:p0', tabId: 'w1:t1', status: 'idle', sessionId: 'planner-session' })
  const plannerLive = await commands.up(deps, { run: RUN, repo: '/x' })
  assert.equal(!plannerLive.ok && plannerLive.code, 'not-down')
  assert.match(plannerLive.text, /the planner pane w1:p0/)
})

test('up refuses to adopt when herdr cannot say whether a pane is alive', async () => {
  const fake = new FakeHerdr()
  const { deps } = await setup(fake)
  const exec = fake.exec
  const unreachable = { ...deps, exec: async (argv: readonly string[]) => (argv[1] === 'agent' && argv[2] === 'get' ? { code: 1, stdout: '', stderr: 'failed to connect to herdr socket' } : exec(argv)) }
  process.env.HERDR_PANE_ID = 'w1:p77'
  const refused = await commands.up(unreachable, { run: RUN, repo: '/x' })
  assert.equal(!refused.ok && refused.code, 'herdr')
  assert.match(refused.text, /could not say whether/)
  assert.equal((await loadRun(deps.home, RUN))?.planner.paneId, 'w1:p0')
})

test('up --seat relaunches a stale seat the roster still calls working when its pane is gone', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-1', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  const spawned = (await loadRoster(deps.home, RUN)).seats[0]
  assert.ok(spawned && !['gone', 'down', 'closed'].includes(spawned.state))
  assert.ok(spawned.sessionId)
  fake.agents.clear()

  const relaunched = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(relaunched.ok, true, relaunched.text)
  const argv = startArgv(fake)
  assert.equal(argv[argv.indexOf('--resume') + 1], spawned.sessionId)
  const events = (await readEvents(deps)).filter(item => item.type === 'seat.relaunch')
  assert.equal(events.at(-1)?.data?.ok, true)
})

test('up --seat refuses a stale-looking seat whose pane is still alive', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-1', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const })) }))
  const refused = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(!refused.ok && refused.code, 'not-dead')
})

test('a recovered codex seat keeps its CODEX_HOME through the adopt and the relaunch', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-xyz', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  await settled(fake, deps, 'w-cx')
  const recorded = join(deps.home, 'runs', RUN, 'codex-home')
  fake.agents.clear()
  process.env.HERDR_PANE_ID = 'w1:p77'

  const upped = await commands.up(deps, { run: RUN, repo: '/x' })
  assert.equal(upped.ok, true, upped.text)
  assert.deepEqual(startArgv(fake).slice(0, 2), ['resume', 'thread-xyz'])
  assert.ok(placedEnv(fake).includes(`CODEX_HOME=${await realpath(recorded)}`), placedEnv(fake).join(' '))
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.codexHome, recorded)
})

test('nodeExec escalates for a child ignoring SIGTERM after its leader closes (DROVE-140)', async () => {
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    console.log(process.pid, child.pid);
    setInterval(() => {}, 1000);
  `
  const ran = await commands.nodeExec([process.execPath, '-e', script], { timeoutMs: 500 })
  assert.equal(ran.code, 124)
  assert.equal(ran.timedOut, true)
  const pids = ran.stdout.trim().split(/\s+/).map(Number)
  assert.equal(pids.length, 2)
  const ps = await commands.nodeExec(['ps', '-eo', 'pid=,pgid=,stat='])
  assert.equal(ps.code, 0)
  for (const line of ps.stdout.trim().split('\n')) {
    const [pid, pgid, state] = line.trim().split(/\s+/)
    if (pids.includes(Number(pid)) || Number(pgid) === pids[0]) assert.match(state!, /^Z/, `process still alive: ${line}`)
  }
})
