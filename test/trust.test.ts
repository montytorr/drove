import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { ledgerPath } from '../src/attention.ts'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { deriveState } from '../src/detect.ts'
import { seatDir } from '../src/paths.ts'
import { loadRoster } from '../src/roster.ts'
import { canonicalRoot, readRepoTrust } from '../src/trust.ts'
import type { Deps, Identity } from '../src/types.ts'
import { FakeHerdr, git, makeDeps, makeRepo, makeSeat, RUN, seedRun, tmp } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5, worktreeWaitMs: 30 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID', 'DROVE_BRIEF_VIA']) delete process.env[key]
})

const FOLDER_TRUST_SCREEN = ' Do you trust the files in this folder?\n\n /repo\n\n 1. Yes, proceed\n 2. No, exit\n'
const brief = 'Build the widget.'

const planner = (deps: Deps): Identity => ({ home: deps.home, run: RUN, role: 'planner', seat: 'planner' })

const setup = async (fake = new FakeHerdr()) => {
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  const run = await seedRun(deps, repo)
  return { fake, repo, deps, run, identity: planner(deps), root: await realpath(repo) }
}

const readEvents = async (deps: Deps) =>
  (await readFile(join(deps.home, 'runs', RUN, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; seat?: string; data?: Record<string, unknown> })

const claudeJson = async (deps: Deps, projects: Record<string, unknown>): Promise<string> => {
  const file = join(deps.home, 'claude.json')
  await writeFile(file, JSON.stringify({ projects }))
  return file
}

const seatOf = async (deps: Deps, name = 'w-api') => (await loadRoster(deps.home, RUN)).seats.find(seat => seat.name === name)

// What Claude does once its trust prompt is accepted: it makes its worktree and moves into it.
const acceptTrust = async (fake: FakeHerdr, repo: string, paneId: string) => {
  const worktree = join(repo, '.claude', 'worktrees', 'w-api')
  await git(repo, 'worktree', 'add', '--no-track', '-b', 'worktree-w-api', worktree, 'HEAD')
  fake.agents.set('w-api-a3f1', { name: 'w-api-a3f1', paneId, tabId: 'w1:t1', status: 'idle', kind: 'claude' })
  fake.foregroundCwds.set(paneId, worktree)
  fake.screen = ' ▐▛███▜▌   Claude Code v2.1.296\n❯ \n'
  return worktree
}

test('readRepoTrust: a trusted parent folder does not trust the repo, as Claude Code 2.1.296 stops its walk at the git root (DROVE-156)', async () => {
  const dir = await tmp('trust-parent')
  const file = join(dir, 'claude.json')
  await writeFile(file, JSON.stringify({ projects: { '/Users/cal/maestro-dev': { hasTrustDialogAccepted: true }, '/': { hasTrustDialogAccepted: true } } }))
  assert.equal((await readRepoTrust(file, '/Users/cal/maestro-dev/drove-site')).state, 'untrusted')
  assert.equal((await readRepoTrust(file, '/Users/cal/maestro-dev')).state, 'trusted')
})

test('readRepoTrust: an exact trusted root is trusted, an absent entry is untrusted, a file without projects says nothing', async () => {
  const dir = await tmp('trust')
  const file = join(dir, 'claude.json')
  await writeFile(file, JSON.stringify({ projects: { '/work/repo': { hasTrustDialogAccepted: true }, '/work/other': { hasTrustDialogAccepted: false } } }))
  assert.equal((await readRepoTrust(file, '/work/repo')).state, 'trusted')
  assert.equal((await readRepoTrust(file, '/elsewhere/repo')).state, 'untrusted')
  await writeFile(file, JSON.stringify({ projects: { '/work/repo': { hasTrustDialogAccepted: false } } }))
  assert.equal((await readRepoTrust(file, '/work/repo')).state, 'untrusted')
  await writeFile(file, JSON.stringify({ mcpServers: {} }))
  assert.equal((await readRepoTrust(file, '/work/repo')).state, 'unknown')
  await writeFile(file, '{ not json')
  assert.equal((await readRepoTrust(file, '/work/repo')).state, 'unknown')
  assert.equal((await readRepoTrust(join(dir, 'absent.json'), '/work/repo')).state, 'unknown')
})

test('canonicalRoot of a linked worktree is its main checkout', async () => {
  const repo = await makeRepo()
  const linked = join(repo, '.claude', 'worktrees', 'w-x')
  await git(repo, 'worktree', 'add', '-q', '-b', 'w-x', linked, 'HEAD')
  assert.equal(await canonicalRoot(commands.nodeExec, linked), await realpath(repo))
  assert.equal(await canonicalRoot(commands.nodeExec, repo), await realpath(repo))
})

test('AC4: a Claude spawn in a repo Claude has not trusted is refused with untrusted-repo and the fix; a Codex spawn goes ahead', async () => {
  const { fake, deps, identity, root } = await setup()
  const withConfig = { ...deps, claudeUserConfig: await claudeJson(deps, { '/somewhere/else': { hasTrustDialogAccepted: true } }) }
  const refused = await commands.spawn(withConfig, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(!refused.ok && refused.code, 'untrusted-repo')
  assert.match(refused.text, new RegExp(`Claude Code has not trusted ${root.replaceAll('.', '\\.')}`))
  assert.match(refused.text, /One-time fix: run `claude` once in .*, accept its folder-trust prompt, then quit it/)
  assert.match(refused.text, /A Codex worker \(--kind codex\) is unaffected/)
  assert.equal(fake.calls.some(call => call[1] === 'agent' && call[2] === 'start'), false)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats, [])

  const codex = await commands.spawn(withConfig, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(codex.ok, true, codex.text)

  const trusted = { ...deps, claudeUserConfig: await claudeJson(deps, { [root]: { hasTrustDialogAccepted: true } }) }
  const spawned = await commands.spawn(trusted, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
})

test('AC4: drove plan warns when Claude has not trusted the repo root, and not when it has', async () => {
  const fake = new FakeHerdr()
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  process.env.HERDR_PANE_ID = 'w1:p5'
  const untrusted = await commands.plan({ ...deps, claudeUserConfig: await claudeJson(deps, {}) }, { repo, kind: 'claude', goal: 'Ship it' })
  assert.equal(untrusted.ok, true, untrusted.text)
  assert.match(untrusted.text, /Warning: Claude Code has not trusted .*One-time fix: run `claude` once in/)
  const trusted = await commands.plan({ ...deps, claudeUserConfig: await claudeJson(deps, { [await realpath(repo)]: { hasTrustDialogAccepted: true } }) }, { repo, kind: 'claude', goal: 'Ship it' })
  assert.doesNotMatch(trusted.text, /Warning/)
})

test('AC1: a Claude spawn whose worktree does not appear delivers no brief, fails with no-worktree and closes the pane', async () => {
  const fake = new FakeHerdr()
  fake.claudeSkipsWorktree = true
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(!spawned.ok && spawned.code, 'no-worktree')
  assert.match(spawned.text, /did not appear within 0s, so w-api would work in the base checkout: no brief was delivered and pane w1:p1 was closed/)
  assert.deepEqual(fake.prompts, [])
  assert.ok(fake.herdrCalls().includes('tab close'))
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats, [])
  const failed = (await readEvents(deps)).find(item => item.type === 'seat.start_failed')
  assert.equal(failed?.data?.code, 'no-worktree')
  assert.ok(existsSync(join(seatDir(deps.home, RUN, 'w-api'), 'start-failure.txt')))
  assert.equal((await readEvents(deps)).some(item => item.type === 'control.sent'), false)
})

test('AC1: a Claude pane whose foreground cwd is outside its worktree gets no brief', async () => {
  const fake = new FakeHerdr()
  const { deps, identity, repo } = await setup(fake)
  fake.foregroundOverride = repo
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(!spawned.ok && spawned.code, 'no-worktree')
  assert.match(spawned.text, /outside Claude's worktree/)
  assert.deepEqual(fake.prompts, [])
  assert.ok(fake.herdrCalls().includes('tab close'))
})

test('AC2: a start that stops at the folder-trust prompt blocks the seat on trust naming the root, keeps the pane and raises no gone', async () => {
  const fake = new FakeHerdr({ startFails: 'timeout', screen: FOLDER_TRUST_SCREEN })
  const { deps, identity, repo, root, run } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /stopped on a dialog \(trust\)/)
  assert.match(spawned.text, /Drove holds the brief/)
  assert.equal(fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').length, 1)
  assert.ok(!fake.herdrCalls().includes('pane close') && !fake.herdrCalls().includes('tab close'))
  assert.deepEqual(fake.prompts, [])
  const seat = await seatOf(deps)
  assert.equal(seat?.state, 'blocked')
  assert.equal(seat?.paneId, 'w1:p1')
  assert.deepEqual(seat?.attention.map(item => item.reason), ['trust'])
  assert.match(seat?.attention[0]?.detail ?? '', new RegExp(`not trusted ${root.replaceAll('.', '\\.')}: its folder-trust prompt is waiting in pane w1:p1`))
  assert.equal(seat?.pendingStart?.root, root)

  // The watcher's view: herdr does not list an agent at the prompt, and the seat is not called gone.
  const watched = deriveState(seat!, { hooks: [] }, new Date())
  assert.equal(watched.state, 'blocked')
  assert.deepEqual(watched.attention.map(item => item.reason), ['trust'])
  const listed = deriveState(seat!, { herdr: { paneId: 'w1:p1', status: 'blocked' }, hooks: [], screen: FOLDER_TRUST_SCREEN }, new Date())
  assert.match(listed.attention[0]?.detail ?? '', new RegExp(root.replaceAll('.', '\\.')))

  const items = await commands.attention(deps, { run: RUN, repo }, true)
  // The fake herdr has no planner agent, so the run's own planner:gone item is left out.
  const kinds = ((items.ok ? items.data : undefined) as { items: { kind: string; seat: string }[] }).items.filter(item => item.seat !== 'planner').map(item => `${item.seat}:${item.kind}`)
  assert.deepEqual(kinds, ['w-api:trust'])
  assert.deepEqual(await commands.applyPendingStarts(deps, run), [])
  assert.deepEqual(fake.prompts, [])
})

test('AC3: once the trust prompt clears and the worktree appears, the held brief goes in without a command and the attention closes', async () => {
  const fake = new FakeHerdr({ startFails: 'timeout', screen: FOLDER_TRUST_SCREEN })
  const { deps, identity, repo, run } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', cairn: 'DROVE-5', brief })
  await commands.attention(deps, { run: RUN, repo }, true)
  assert.deepEqual(await commands.applyPendingStarts(deps, run), [])

  const worktree = await acceptTrust(fake, repo, 'w1:p1')
  const results = await commands.applyPendingStarts(deps, run)
  assert.equal(results.length, 1)
  assert.equal(results[0]?.ok, true, results[0]?.text)
  assert.match(results[0]?.text ?? '', new RegExp(`runs in worktree ${worktree.replaceAll('.', '\\.')} on branch worktree-w-api\\. Brief: herdr-prompt`))
  assert.equal(fake.prompts.length, 1)
  assert.match(fake.prompts[0]?.text ?? '', /kind=brief[\s\S]*Build the widget\.[\s\S]*Your Cairn task is DROVE-5/)
  const seat = await seatOf(deps)
  assert.equal(seat?.state, 'working')
  assert.equal(seat?.pendingStart, undefined)
  assert.deepEqual(seat?.attention, [])
  const ledger = JSON.parse(await readFile(ledgerPath(deps.home, RUN), 'utf8')) as { entries: Record<string, { open: boolean }> }
  assert.equal(ledger.entries['w-api:trust']?.open, false)
  assert.deepEqual(await commands.applyPendingStarts(deps, run), [])
  assert.equal(fake.prompts.length, 1)
})

test('a cleared prompt with no worktree after the wait closes the pane and delivers nothing', async () => {
  const fake = new FakeHerdr({ startFails: 'timeout', screen: FOLDER_TRUST_SCREEN })
  const { deps, identity, run } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  fake.screen = ' ▐▛███▜▌   Claude Code v2.1.296\n❯ \n'
  assert.deepEqual(await commands.applyPendingStarts(deps, run), [])
  deps.clock.advance(commands.timing.worktreeWaitMs + 1)
  const [result] = await commands.applyPendingStarts(deps, run)
  assert.equal(result?.ok, false)
  assert.match(result?.text ?? '', /did not appear, so w-api would work in the base checkout: no brief was delivered and pane w1:p1 was closed/)
  assert.ok(fake.herdrCalls().includes('pane close'))
  assert.deepEqual(fake.prompts, [])
  const seat = await seatOf(deps)
  assert.equal(seat?.state, 'gone')
  assert.equal(seat?.pendingStart, undefined)
  assert.equal((await readEvents(deps)).filter(item => item.type === 'seat.start_failed').at(-1)?.data?.code, 'no-worktree')
})

test('trust given outside the pane relaunches the seat once with the same branch and brief', async () => {
  const fake = new FakeHerdr({ startFails: 'timeout', screen: FOLDER_TRUST_SCREEN })
  const { deps, identity, run, root } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const before = await seatOf(deps)
  const config = await claudeJson(deps, {})
  const withConfig = { ...deps, claudeUserConfig: config }
  assert.deepEqual(await commands.applyPendingStarts(withConfig, run), [])

  await claudeJson(deps, { [root]: { hasTrustDialogAccepted: true } })
  fake.startFails = undefined
  const [relaunched] = await commands.applyPendingStarts(withConfig, run)
  assert.equal(relaunched?.ok, true, relaunched?.text)
  assert.match(relaunched?.text ?? '', /was trusted outside pane w1:p1, so w-api was relaunched once/)
  assert.ok(fake.find('herdr', 'pane', 'close', 'w1:p1'))
  const starts = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start')
  assert.equal(starts.length, 2)
  assert.equal(starts[1]?.[starts[1].indexOf('--worktree') + 1], 'w-api')
  const seat = await seatOf(deps)
  assert.equal(seat?.pendingStart?.relaunched, true)
  assert.notEqual(seat?.paneId, 'w1:p1')
  assert.notEqual(seat?.sessionId, before?.sessionId)
  assert.equal(seat?.branch, before?.branch)

  fake.screen = ' ▐▛███▜▌   Claude Code v2.1.296\n❯ \n'
  const [delivered] = await commands.applyPendingStarts(withConfig, run)
  assert.equal(delivered?.ok, true, delivered?.text)
  assert.equal(fake.prompts.length, 1)
  assert.match(fake.prompts[0]?.text ?? '', /Build the widget\./)
})

test('a pane that dies while held at the trust prompt is relaunched once, then the seat is left gone with the reason', async () => {
  const fake = new FakeHerdr({ startFails: 'timeout', screen: FOLDER_TRUST_SCREEN })
  const { deps, identity, run } = await setup(fake)
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  fake.closedPanes.add('w1:p1')
  const [first] = await commands.applyPendingStarts(deps, run)
  assert.equal(first?.ok, true, first?.text)
  assert.match(first?.text ?? '', /pane w1:p1 is gone, so w-api was relaunched once .*stopped on a dialog again \(trust\)/)
  const relaunched = await seatOf(deps)
  assert.equal(relaunched?.state, 'blocked')
  assert.match(relaunched?.attention[0]?.detail ?? '', new RegExp(`waiting in pane ${relaunched?.paneId}`))

  fake.closedPanes.add(relaunched?.paneId ?? '')
  const [second] = await commands.applyPendingStarts(deps, run)
  assert.equal(second?.ok, false)
  const gone = await seatOf(deps)
  assert.equal(gone?.state, 'gone')
  assert.match(gone?.attention[0]?.detail ?? '', /its one relaunch is used; close the seat and spawn it again/)
  assert.deepEqual(fake.prompts, [])
  assert.deepEqual(await commands.applyPendingStarts(deps, run), [])
})

test('AC5: a seat respawned under the name of one that went gone leaves no open gone entry in attention.json', async () => {
  const fake = new FakeHerdr()
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  const at = '2026-10-09T09:30:00.000Z'
  await seedRun(deps, repo, [makeSeat('w-api', { worktree: join(repo, '.claude', 'worktrees', 'w-api'), branch: 'worktree-w-api', state: 'gone', stateAt: at, attention: [{ seat: 'w-api', reason: 'gone', detail: 'pane w1:p9 is gone', at }] })])
  await commands.attention(deps, { run: RUN, repo }, true)
  const ledger = async () => (JSON.parse(await readFile(ledgerPath(deps.home, RUN), 'utf8')) as { entries: Record<string, { open: boolean }> }).entries
  assert.equal((await ledger())['w-api:gone']?.open, true)

  const spawned = await commands.spawn(deps, planner(deps), { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal((await ledger())['w-api:gone']?.open, false)
  const items = await commands.attention(deps, { run: RUN, repo }, true)
  assert.deepEqual(((items.ok ? items.data : undefined) as { items: { seat: string }[] }).items.filter(item => item.seat === 'w-api'), [])
})

test('AC6: a seat with no pane that loses its agent says its pane never started, never ?', () => {
  const seat = makeSeat('w-api', { state: 'blocked', paneId: undefined })
  const derived = deriveState(seat, { hooks: [] }, new Date())
  assert.equal(derived.state, 'gone')
  assert.match(derived.attention[0]?.detail ?? '', /its pane never started/)
  assert.doesNotMatch(derived.attention[0]?.detail ?? '', /\?/)
  const withPane = deriveState({ ...seat, paneId: 'w1:p4' }, { hooks: [] }, new Date())
  assert.match(withPane.attention[0]?.detail ?? '', /^pane w1:p4 is gone/)
})
