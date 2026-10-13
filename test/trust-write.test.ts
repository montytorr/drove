import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, realpath, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { main } from '../src/cli.ts'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { loadRoster, updateRoster } from '../src/roster.ts'
import { trustRepo } from '../src/trust.ts'
import type { CommandResult, Deps, Identity } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, RUN, seedRun, tmp } from './p3-helpers.ts'

// DROVE-167. Every Claude config here is a temp file: no test reads or writes the real ~/.claude.json.

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5, worktreeWaitMs: 30 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID', 'DROVE_BRIEF_VIA']) delete process.env[key]
})

const FOLDER_TRUST_SCREEN = ' Do you trust the files in this folder?\n\n /repo\n\n 1. Yes, proceed\n 2. No, exit\n'
const FAST = { retryMs: [5, 5], staleMs: 60_000 }
const brief = 'Build the widget.'

// A config the way Claude writes it: two-space JSON with account data around the projects map.
const CONFIG = {
  numStartups: 42,
  oauthAccount: { emailAddress: 'someone@example.com', organizationUuid: 'org-1' },
  projects: {
    '/a/first': { allowedTools: ['Bash'], hasTrustDialogAccepted: true },
    '/a/partial': { allowedTools: [], hasTrustDialogAccepted: false, lastCost: 1.5 },
    '/a/last': { hasTrustDialogAccepted: true },
  },
  theme: 'dark',
  userID: 'abc',
}

const configFile = async (content: unknown = CONFIG, name = 'cfg'): Promise<string> => {
  const file = join(await tmp(name), '.claude.json')
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return file
}

const planner = (deps: Deps): Identity => ({ home: deps.home, run: RUN, role: 'planner', seat: 'planner' })

test('AC1: trustRepo sets only projects[root].hasTrustDialogAccepted, keeps every other key and their order, and a second run changes nothing', async () => {
  const file = await configFile()
  await chmod(file, 0o600)
  const written = await trustRepo(file, '/a/new', FAST)
  assert.deepEqual(written, { state: 'trusted', root: '/a/new', file, changed: true })
  const text = await readFile(file, 'utf8')
  const after = JSON.parse(text) as typeof CONFIG & { projects: Record<string, unknown> }
  assert.deepEqual(Object.keys(after), Object.keys(CONFIG))
  assert.deepEqual(Object.keys(after.projects), ['/a/first', '/a/partial', '/a/last', '/a/new'])
  const { '/a/new': added, ...others } = after.projects
  assert.deepEqual({ ...after, projects: others }, CONFIG, 'nothing else changed')
  assert.deepEqual(added, { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false })
  assert.match(text, /^\{\n {2}"numStartups": 42,/, 'two-space JSON as Claude writes it')
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'the mode is kept')

  const again = await trustRepo(file, '/a/new', FAST)
  assert.equal(again.changed, false)
  assert.equal(await readFile(file, 'utf8'), text)
})

test('AC1: an existing entry keeps its keys and their order, and only its trust flag flips', async () => {
  const file = await configFile()
  assert.equal((await trustRepo(file, '/a/partial', FAST)).changed, true)
  const after = JSON.parse(await readFile(file, 'utf8')) as { projects: Record<string, unknown> }
  assert.deepEqual(Object.keys(after.projects), ['/a/first', '/a/partial', '/a/last'])
  assert.deepEqual(after.projects['/a/partial'], { allowedTools: [], hasTrustDialogAccepted: true, lastCost: 1.5 })
  assert.deepEqual(Object.keys(after.projects['/a/partial'] as object), ['allowedTools', 'hasTrustDialogAccepted', 'lastCost'])
})

test('AC1: a config with no projects map gets one, at the end', async () => {
  const file = await configFile({ theme: 'dark', userID: 'abc' })
  await trustRepo(file, '/a/new', FAST)
  const after = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(after), ['theme', 'userID', 'projects'])
})

test('AC2: a lock held past the bound fails with a clear message and leaves the file unchanged', async () => {
  const file = await configFile()
  const before = await readFile(file, 'utf8')
  await mkdir(`${file}.lock`)
  await assert.rejects(trustRepo(file, '/a/new', FAST), /\.claude\.json\.lock is held by another process .*nothing was written/)
  assert.equal(await readFile(file, 'utf8'), before)
  assert.ok((await stat(`${file}.lock`)).isDirectory(), "another holder's lock is not removed")
})

test('a stale lock (older than its stale time) is taken over, as proper-lockfile does, and released after', async () => {
  const file = await configFile()
  await mkdir(`${file}.lock`)
  const old = new Date(Date.now() - 120_000)
  await utimes(`${file}.lock`, old, old)
  assert.equal((await trustRepo(file, '/a/new', FAST)).changed, true)
  await assert.rejects(stat(`${file}.lock`), /ENOENT/)
})

test('trustRepo refuses a missing or unparseable config and writes nothing', async () => {
  await assert.rejects(trustRepo(join(await tmp('cfg'), '.claude.json'), '/a/new', FAST), /no config at .*start claude once/)
  const bad = await configFile('{ not json')
  await assert.rejects(trustRepo(bad, '/a/new', FAST), /not valid JSON/)
  assert.equal(await readFile(bad, 'utf8'), '{ not json')
})

test('AC3: with CLAUDE_CONFIG_DIR set, drove trust reads and writes $CLAUDE_CONFIG_DIR/.claude.json', async t => {
  const dir = await tmp('claude-config-dir')
  const file = join(dir, '.claude.json')
  await writeFile(file, JSON.stringify(CONFIG, null, 2))
  assert.equal(commands.defaultDeps({ CLAUDE_CONFIG_DIR: dir }).claudeUserConfig, file)
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  t.after(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved })
  const repo = await makeRepo()
  const out: string[] = []
  const err: string[] = []
  assert.equal(await main(['trust', repo, '--yes', '--json'], { out: text => out.push(text), err: text => err.push(text), stdin: async () => '' }), 0, err.join('\n'))
  const root = await realpath(repo)
  assert.deepEqual(JSON.parse(out.join('\n')), { root, file, state: 'trusted', changed: true })
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted: boolean }> }).projects[root]?.hasTrustDialogAccepted, true)
})

const cli = async (deps: Deps, argv: string[]) => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(['trust', ...argv], { deps, out: text => out.push(text), err: text => err.push(text), stdin: async () => '' })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

test('AC4: with no terminal and no --yes, drove trust prints what it would change and exits 1 without writing; --yes --json writes and prints the result', async () => {
  const repo = await makeRepo()
  const root = await realpath(repo)
  const file = await configFile()
  const before = await readFile(file, 'utf8')
  const deps: Deps = { ...(await makeDeps(new FakeHerdr())), exec: commands.nodeExec, claudeUserConfig: file, terminal: { stdin: false, stdout: false }, ask: async () => assert.fail('no question without a terminal') }

  const refused = await cli(deps, [repo])
  assert.equal(refused.code, 1)
  assert.ok(refused.err.includes(`no-terminal: Would set projects["${root}"].hasTrustDialogAccepted to true in ${file}`), refused.err)
  assert.match(refused.err, /Not a terminal and no --yes: nothing written\. Run `drove trust .* --yes`/)
  assert.equal(await readFile(file, 'utf8'), before)

  const dry = await cli(deps, [repo, '--dry-run', '--json'])
  assert.equal(dry.code, 0)
  assert.deepEqual(JSON.parse(dry.out), { root, file, state: 'untrusted', changed: false })
  assert.equal(await readFile(file, 'utf8'), before)

  const yes = await cli(deps, [repo, '--yes', '--json'])
  assert.equal(yes.code, 0, yes.err)
  assert.deepEqual(JSON.parse(yes.out), { root, file, state: 'trusted', changed: true })
  const again = await cli(deps, [repo, '--json'])
  assert.equal(again.code, 0, 'already trusted is fine without --yes or a terminal')
  assert.deepEqual(JSON.parse(again.out), { root, file, state: 'trusted', changed: false })
})

test('drove trust asks on a terminal: no writes nothing, yes writes; a linked worktree trusts its main checkout', async () => {
  const repo = await makeRepo()
  const root = await realpath(repo)
  const file = await configFile()
  const questions: string[] = []
  let answer = false
  const deps: Deps = { ...(await makeDeps(new FakeHerdr())), exec: commands.nodeExec, claudeUserConfig: file, ask: async question => { questions.push(question); return answer } }
  const sub = join(repo, 'src')
  await mkdir(sub)
  const declined = await commands.trust(deps, { dir: sub })
  assert.equal(!declined.ok && declined.code, 'declined')
  assert.deepEqual(questions, [`Trust ${root} for Claude Code? This is what accepting its folder-trust prompt does. [y/N] `])
  answer = true
  const accepted = await commands.trust(deps, { dir: sub })
  assert.equal(accepted.ok, true, accepted.text)
  assert.deepEqual(accepted.data, { root, file, state: 'trusted', changed: true })
})

// A run with one Claude seat that went down, a config that does not trust its repo, and a fake herdr that records panes.
const downedClaudeSeat = async () => {
  const fake = new FakeHerdr()
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo)
  const identity = planner(deps)
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief })).ok, true)
  const untrusted = { ...deps, claudeUserConfig: await configFile({ projects: {} }) }
  return { fake, repo, deps, untrusted, identity }
}

const panesTouched = (fake: FakeHerdr, from: number) =>
  fake.calls.slice(from).filter(call => (call[1] === 'agent' && call[2] === 'start') || (call[1] === 'pane' && ['split', 'close'].includes(call[2] ?? '')) || (call[1] === 'tab' && call[2] === 'create'))

const assertUntrusted = (result: CommandResult) => {
  assert.equal(!result.ok && result.code, 'untrusted-repo', result.text)
  assert.match(result.text, /Fix: run `drove trust /)
  assert.doesNotMatch(result.text, /--kind/)
}

test('AC5: drove up --seat of a Claude seat in an untrusted root is refused with untrusted-repo before any pane is opened', async () => {
  const { fake, deps, untrusted } = await downedClaudeSeat()
  fake.agents.clear()
  await commands.roster(deps, { run: RUN, repo: '/x' }, false)
  const from = fake.calls.length
  assertUntrusted(await commands.up(untrusted, { run: RUN, repo: '/x' }, 'w-a'))
  assert.deepEqual(panesTouched(fake, from), [])
})

test('AC5: a promote restart of a Claude seat in an untrusted root is refused before the agent is stopped', async () => {
  const { fake, deps, untrusted, identity } = await downedClaudeSeat()
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, owes: 'none' as const, lastReport: { id: 'r-1', kind: 'done' as const, expects: 'none' as const, summary: 'ok', at: '2099-01-01T00:00:00.000Z' } })) }))
  fake.setStatus('w-a', 'idle')
  const from = fake.calls.length
  assertUntrusted(await commands.promote(untrusted, identity, { seat: 'w-a', model: 'opus', effort: 'high' }))
  assert.deepEqual(panesTouched(fake, from), [])
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.state, 'idle')
})

test('AC5: a migrate to claude in an untrusted root is refused before the old agent is stopped', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-old', startStatus: 'idle' })
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo)
  const identity = planner(deps)
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })).ok, true)
  const from = fake.calls.length
  assertUntrusted(await commands.migrate({ ...deps, claudeUserConfig: await configFile({ projects: {} }) }, identity, { seat: 'w-cx', kind: 'claude' }))
  assert.deepEqual(panesTouched(fake, from), [])
  assert.deepEqual(fake.prompts, [], 'no /quit was sent')
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.kind, 'codex')
})

test('AC6: on a terminal, drove plan asks before launching and writes trust on yes; no leaves the warning, naming drove trust', async () => {
  const fake = new FakeHerdr()
  const repo = await makeRepo()
  const root = await realpath(repo)
  process.env.HERDR_PANE_ID = 'w1:p5'
  const file = await configFile({ projects: {} })
  const questions: string[] = []
  const base = await makeDeps(fake)
  const declined = await commands.plan({ ...base, claudeUserConfig: file, ask: async question => { questions.push(question); return false } }, { repo, kind: 'claude', goal: 'Ship it' })
  assert.equal(declined.ok, true, declined.text)
  assert.equal(questions.length, 1)
  assert.match(declined.text, /Warning: Claude Code has not trusted .*Fix: run `drove trust /)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { projects: {} })

  const accepted = await commands.plan({ ...(await makeDeps(new FakeHerdr())), claudeUserConfig: file, ask: async () => true }, { repo, kind: 'claude', goal: 'Ship it' })
  assert.equal(accepted.ok, true, accepted.text)
  assert.ok(accepted.text.includes(`Trusted ${root} for Claude Code in ${file}.`), accepted.text)
  assert.doesNotMatch(accepted.text, /Warning/)
  assert.equal((JSON.parse(await readFile(file, 'utf8')) as { projects: Record<string, { hasTrustDialogAccepted: boolean }> }).projects[root]?.hasTrustDialogAccepted, true)
})

test('AC6: without a terminal, a detached drove plan warns and asks nothing, for the Claude planner even when workers are Codex', async () => {
  const fake = new FakeHerdr()
  const repo = await makeRepo()
  const deps: Deps = { ...(await makeDeps(fake)), terminal: { stdin: false, stdout: false }, claudeUserConfig: await configFile({ projects: {} }), ask: async () => assert.fail('no question without a terminal') }
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerKind: 'codex' }))
  const planned = await commands.plan(deps, { repo, kind: 'claude', goal: 'Ship it', detached: true })
  assert.equal(planned.ok, true, planned.text)
  assert.match(planned.text, /Warning: Claude Code has not trusted .*so a Claude planner or worker launched there stops at its folder-trust prompt\. Fix: run `drove trust /)
})

test('AC6: a Codex planner with Codex workers gets no trust question or warning', async () => {
  const repo = await makeRepo()
  const deps: Deps = { ...(await makeDeps(new FakeHerdr())), claudeUserConfig: await configFile({ projects: {} }), ask: async () => assert.fail('nothing to ask') }
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerKind: 'codex' }))
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan(deps, { repo, kind: 'codex', goal: 'Ship it' })
  assert.equal(planned.ok, true, planned.text)
  assert.doesNotMatch(planned.text, /Warning/)
})

test('AC6: drove up asks on a terminal before relaunching, and a yes lets the Claude seat resume', async () => {
  const { fake, deps, untrusted } = await downedClaudeSeat()
  fake.agents.clear()
  await commands.roster(deps, { run: RUN, repo: '/x' }, false)
  const questions: string[] = []
  const relaunched = await commands.up({ ...untrusted, ask: async question => { questions.push(question); return true } }, { run: RUN, repo: '/x' }, 'w-a')
  assert.equal(relaunched.ok, true, relaunched.text)
  assert.equal(questions.length, 1)
})

test('AC6: drove up of a whole run without a terminal warns, naming drove trust, and refuses the Claude seats', async () => {
  const { fake, deps, untrusted, repo } = await downedClaudeSeat()
  fake.setStatus('w-a', 'idle')
  assert.equal((await commands.down(deps, { run: RUN, repo })).ok, true)
  process.env.HERDR_PANE_ID = 'w1:p9'
  const upped = await commands.up({ ...untrusted, terminal: { stdin: false, stdout: false } }, { run: RUN, repo }, undefined, { detached: true })
  assert.equal(upped.ok, true, upped.text)
  assert.match(upped.text, /could not resume w-a \(untrusted-repo: see the warning\)/)
  assert.match(upped.text, /Warning: Claude Code has not trusted .*Fix: run `drove trust /)
})

test('AC8: a promote restart whose new agent sits at the folder-trust prompt leaves the seat blocked on trust, not gone, and keeps its pane', async () => {
  const { fake, deps, identity } = await downedClaudeSeat()
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, owes: 'none' as const, lastReport: { id: 'r-1', kind: 'done' as const, expects: 'none' as const, summary: 'ok', at: '2099-01-01T00:00:00.000Z' } })) }))
  fake.setStatus('w-a', 'idle')
  Object.assign(fake, { startFails: 'timeout', startLeavesAgent: true, startStatus: 'blocked', screen: FOLDER_TRUST_SCREEN })
  const promoted = await commands.promote(deps, identity, { seat: 'w-a', model: 'opus', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.match(promoted.text, /stopped on a dialog \(trust\)/)
  const paneId = (promoted.data as { paneId: string }).paneId
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.state, seat?.paneId, seat?.model, seat?.attention.map(item => item.reason)], ['blocked', paneId, 'claude-opus-5-5', ['trust']])
  assert.match(seat?.attention[0]?.detail ?? '', /folder-trust prompt is waiting in pane .*Accept it in the pane/)
  assert.equal(fake.calls.some(call => call[1] === 'pane' && call[2] === 'close' && call[3] === paneId), false)
})

test('AC8: a migrate whose new agent sits at a startup dialog leaves the seat blocked with the attention and keeps its pane', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-old', startStatus: 'idle' })
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo)
  const identity = planner(deps)
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })).ok, true)
  Object.assign(fake, { startSession: undefined, startFails: 'timeout', startLeavesAgent: true, startStatus: 'blocked', screen: FOLDER_TRUST_SCREEN })
  const migrated = await commands.migrate(deps, identity, { seat: 'w-cx', kind: 'claude' })
  assert.equal(migrated.ok, true, migrated.text)
  const paneId = (migrated.data as { paneId: string }).paneId
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.kind, seat?.state, seat?.paneId], ['claude', 'blocked', paneId])
  assert.deepEqual(seat?.attention.map(item => item.reason), ['trust', 'pending-delivery'], 'the handoff brief waits queued behind the prompt')
  assert.match(seat?.attention[0]?.detail ?? '', /once it clears, the queued handoff brief goes in/)
  assert.equal(fake.calls.some(call => call[1] === 'pane' && call[2] === 'close' && call[3] === paneId), false)
})
