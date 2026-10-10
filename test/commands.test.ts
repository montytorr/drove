import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import { seatDir } from '../src/paths.ts'
import { approvedText } from '../src/prompts.ts'
import { loadRoster, loadRun, updateRoster } from '../src/roster.ts'
import type { Deps, Identity, RunMeta } from '../src/types.ts'
import { FakeHerdr, git, makeDeps, makeRepo, makeSeat, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20 })
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
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', cairn: 'DROVE-5', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const order = fake.calls.map(call => (call[0] === 'git' ? 'git' : call.slice(1, 3).join(' ')))
  assert.ok(order.indexOf('git') < order.indexOf('tab create'))
  assert.ok(order.indexOf('tab create') < order.indexOf('agent start'))
  const worktree = join(repo, '.claude', 'worktrees', 'w-api')
  assert.ok(existsSync(worktree))
  assert.equal(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'worktree-w-api')
  assert.equal(await git(repo, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/worktree-w-api'), '')
  assert.equal(await git(repo, 'branch', '--list', 'drove/w-api'), '')
  assert.deepEqual(fake.calls.filter(call => call[0] === 'git' && call.includes('worktree')), [])

  const start = fake.find('herdr', 'agent', 'start') ?? []
  assert.equal(start[3], 'w-api')
  assert.equal(start[start.indexOf('--kind') + 1], 'claude')
  assert.equal(start[start.indexOf('--worktree') + 1], 'w-api')
  assert.ok(start.includes('--session-id'))
  assert.match(start.at(-1) ?? '', /^Build the widget\. \(You are worker `w-api`\. Your Cairn task is DROVE-5/)
  assert.equal(fake.prompts.length, 0)
  const tab = fake.find('herdr', 'tab', 'create') ?? []
  assert.equal(tab[tab.indexOf('--cwd') + 1], repo)
  assert.ok(tab.includes('_CC_ACCT_PINNED=1'))
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

test('a claude spawn warns when the main checkout is not at the base, and says --base is ignored', async () => {
  const { deps, identity, repo } = await setup()
  await git(repo, 'switch', '-q', '-c', 'side', '--no-track')
  await writeFile(join(repo, 'b.txt'), 'x\n')
  await git(repo, 'add', 'b.txt')
  await git(repo, 'commit', '-q', '-m', 'side work')
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, base: 'main' })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /Note: Claude branches worktree-w-api from the main checkout's current HEAD \(side\), which is not main/)
  assert.match(spawned.text, /Note: --base main was ignored/)
  assert.equal(await git(join(repo, '.claude', 'worktrees', 'w-api'), 'rev-parse', 'HEAD'), await git(repo, 'rev-parse', 'side'))
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
  assert.match(start.at(-1) ?? '', /Build the widget/)
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
  assert.deepEqual(order.filter(item => ['tab create', 'agent start', 'tab close'].includes(item)), ['tab create', 'agent start', 'tab close'])
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

test('a failed start saves the pane output, logs seat.start_failed and hints at the folder-trust dialog', async () => {
  const fake = new FakeHerdr({ startFails: 'timeout', screen: FOLDER_TRUST_SCREEN })
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, false)
  assert.match(spawned.text, /Hint: Claude is asking to trust the folder\./)
  const file = join(seatDir(deps.home, RUN, 'w-api'), 'start-failure.txt')
  assert.match(spawned.text, new RegExp(file.replaceAll('.', '\\.')))
  assert.equal(await readFile(file, 'utf8'), `== visible screen ==\n${FOLDER_TRUST_SCREEN.trimEnd()}\n\n== recent output ==\n${FOLDER_TRUST_SCREEN.trimEnd()}\n`)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const reads = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'read')
  assert.deepEqual(reads.map(call => call.slice(3)), [
    ['w-api', '--source', 'visible', '--lines', '60'],
    ['w-api', '--source', 'recent-unwrapped', '--lines', '60'],
  ])
  assert.ok(fake.calls.findIndex(call => call[2] === 'read') < fake.calls.findIndex(call => call[1] === 'tab' && call[2] === 'close'))
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

test('a start timeout rolls back when the agent is absent, blocked, or the screen shows a dialog', async () => {
  const cases: { name: string; fake: FakeHerdr }[] = [
    { name: 'absent', fake: new FakeHerdr({ startFails: 'timeout', screen: 'zsh: command not found: claude' }) },
    { name: 'blocked', fake: new FakeHerdr({ startFails: 'timeout', startLeavesAgent: true, startStatus: 'blocked', screen: FOLDER_TRUST_SCREEN }) },
    { name: 'dialog on screen', fake: new FakeHerdr({ startFails: 'timeout', startLeavesAgent: true, startStatus: 'idle', screen: `Claude Code v2.1.295\n${FOLDER_TRUST_SCREEN}` }) },
    { name: 'dialog, no agent', fake: new FakeHerdr({ startFails: 'timeout', screen: `Claude Code v2.1.295\n${FOLDER_TRUST_SCREEN}` }) },
  ]
  for (const { name, fake } of cases) {
    const { deps, identity } = await setup(fake)
    const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
    assert.equal(spawned.ok, false, name)
    assert.match(spawned.text, /no worker exists/, name)
    assert.ok(fake.herdrCalls().includes('tab close'), name)
    assert.deepEqual((await loadRoster(deps.home, RUN)).seats, [], name)
    assert.equal((await readEvents(deps)).filter(item => item.type === 'seat.start_failed').length, 1, name)
  }
})

test('the worker role names the branch each kind is already on', async () => {
  delete process.env.DROVE_BRIEF_VIA
  const claude = await setup()
  await commands.spawn(claude.deps, claude.identity, { seat: 'w-api', kind: 'claude', brief })
  const role = await readFile(join(seatDir(claude.deps.home, RUN, 'w-api'), 'role.md'), 'utf8')
  assert.match(role, /already on your own branch \(`worktree-w-api`\) in your own worktree\. Commit there\. Do not create, switch or rebase branches unless the planner asks\./)
  assert.doesNotMatch(role, /switch -c/)
  const codex = await setup()
  await commands.spawn(codex.deps, codex.identity, { seat: 'w-cx', kind: 'codex', brief })
  const instructions = (codex.fake.find('herdr', 'agent', 'start') ?? []).find(arg => arg.startsWith('developer_instructions=')) ?? ''
  assert.match(instructions, /already on your own branch \(`drove\/w-cx`\)/)
})

test('DROVE_ROLE_IN_BRIEF=1 moves a codex worker role from developer_instructions to the brief', async () => {
  process.env.DROVE_ROLE_IN_BRIEF = '1'
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  const start = fake.find('herdr', 'agent', 'start') ?? []
  assert.ok(!start.some(arg => arg.startsWith('developer_instructions')))
  assert.ok(!start.some(arg => arg.includes('# Worker mode')))
  assert.match(fake.prompts[0]?.text ?? '', /# Worker mode[\s\S]*Build the widget/)
})

test('a single-line brief stays a launch argument; the role text is a file, not an argument', async () => {
  const { fake, deps, identity } = await setup()
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief: '  Build the widget.  ' })
  assert.equal(spawned.ok, true, spawned.text)
  const start = fake.find('herdr', 'agent', 'start') ?? []
  assert.match(start.at(-1) ?? '', /^Build the widget\. \(You are worker `w-api`\.\s/)
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
        seat.name === name ? { ...seat, owes: 'review', lastReport: { id: 'r1', kind: 'done', expects: 'review', summary: 'early', at: deps.clock.now().toISOString() } } : seat,
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
    assert.equal(seat?.paneId, fake.agents.get('w-a')?.paneId, mode)
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

test('up --seat rolls back when the agent in the pane is blocked at a dialog', async () => {
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })
  await killedMidTurn(fake, deps)
  Object.assign(fake, { startFails: 'timeout', startLeavesAgent: true, startStatus: 'blocked', screen: FOLDER_TRUST_SCREEN })
  const relaunched = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(!relaunched.ok && relaunched.code, 'relaunch')
  assert.match(relaunched.text, /Hint: Claude is asking to trust the folder/)
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
  assert.deepEqual([seat?.model, seat?.state, seat?.paneId], ['claude-opus-5-5', 'working', fake.agents.get('w-api')?.paneId])
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
  const notRepo = await commands.plan(deps, { repo: deps.home, kind: 'claude' })
  assert.equal(!notRepo.ok && notRepo.code, 'not-a-repo')
})

test('loadConfig merges ~/.drove/config.json over the defaults', async () => {
  const deps = await makeDeps(new FakeHerdr())
  assert.deepEqual(await commands.loadConfig(deps.home), commands.DEFAULT_CONFIG)
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ humanName: 'Cal', workerModel: { codex: 'gpt-x' }, claudeChannel: true }))
  const config = await commands.loadConfig(deps.home)
  assert.equal(config.humanName, 'Cal')
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
