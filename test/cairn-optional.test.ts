import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { detectRunCairn, probeCairn, runUsesCairn } from '../src/agents.ts'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { seatDir } from '../src/paths.ts'
import { loadRun, saveRun } from '../src/roster.ts'
import { CLAIM_BEAT_EVERY_MS, defaultToolPorts, plannerTools, type ToolPorts } from '../src/tools.ts'
import type { CommandResult, Deps, ExecResult, Identity } from '../src/types.ts'
import { renderPrompts } from './cairn-prompts.ts'
import { FakeHerdr, makeDeps as baseDeps, makeRepo, RUN, seedRun, tmp } from './p3-helpers.ts'

// DROVE-159: Cairn is optional. Every cairn call here goes to a stand-in; none reaches a real cairn.

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_OWNS', 'DROVE_SEAT_ROLE', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

// A cairn command in a prompt: a backticked cairn call, or one of its verbs after the word.
const CAIRN_COMMAND = /`cairn\b|\bcairn (?:add|check|claim|done|note|update|show|beat|release|next|projects|subject|--instance)\b/i

// A working cairn that answers every call and records it.
const installedCairn = (fake: FakeHerdr) => {
  const calls: string[][] = []
  const base = fake.exec
  fake.exec = async (argv, options) => {
    if (argv[0] !== 'cairn') return base(argv, options)
    calls.push([...argv])
    return { code: 0, stdout: argv[1] === '--version' ? 'cairn 0.22.3\n' : '{}', stderr: '' }
  }
  return calls
}

// The user's own Claude setup stays out: a skill named cairn in it would show in the planner's Lean spawns list.
const makeDeps = async (fake: FakeHerdr) => {
  const deps = await baseDeps(fake)
  return { ...deps, claudeUserDir: await tmp('claude-user'), claudeUserConfig: join(deps.home, 'no-claude.json') }
}
const codeOf = (result: CommandResult): string | undefined => (result.ok ? undefined : result.code)
const cairnCalls = (fake: FakeHerdr): string[][] => fake.calls.filter(call => call[0] === 'cairn')
const setCairn = (deps: Deps, cairn: string) => writeFile(join(deps.home, 'config.json'), JSON.stringify({ cairn }))
const runIdOf = (planned: CommandResult): string => (planned.ok ? (planned.data as commands.ProcessPlan).env.DROVE_RUN : '') as string
const plannerOf = (deps: Deps, run: string): Identity => ({ home: deps.home, run, role: 'planner', seat: 'planner' })
const briefOf = (fake: FakeHerdr): string => (fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').at(-1) ?? []).at(-1) ?? ''
const runsIn = async (deps: Deps): Promise<string[]> => readdir(join(deps.home, 'runs')).catch(() => [])

test('AC4: with Cairn present the planner, worker and mod prompts are byte-identical to the ones before DROVE-159', async () => {
  const before = JSON.parse(readFileSync(new URL('./fixtures/cairn-on-prompts.json', import.meta.url), 'utf8')) as Record<string, string>
  assert.deepEqual(await renderPrompts({ useCairn: true }), before)
  assert.deepEqual(await renderPrompts(), before, 'a run saved before DROVE-159 has no useCairn and keeps Cairn')
})

test('without Cairn no planner, worker or mod prompt names a cairn command, and each still has its report tool', async () => {
  const off = await renderPrompts({ useCairn: false })
  for (const [name, text] of Object.entries(off)) {
    if (name.startsWith('planner.') || name.startsWith('worker.') || name.startsWith('mod.')) assert.doesNotMatch(text, CAIRN_COMMAND, name)
  }
  for (const role of ['implementer', 'reviewer', 'tester']) {
    const text = off[`worker.goal.${role}`] ?? ''
    assert.doesNotMatch(text, /## Cairn|Cairn task/, role)
    assert.match(text, /## Reporting \(the drove report tool, server drove\)/, role)
  }
  assert.match(off['worker.goal.implementer'] ?? '', /## Steps\n1\. Do the work, including each `## Acceptance` criterion\.\n2\. Verify it, then report `done`\.\n\n/)
  assert.match(off['planner.goal.claude'] ?? '', /3\. This run has no task tracker, so track each piece by its seat/)
  assert.match(off['mod.orchestrator.goal'] ?? '', /3\. This run has no task tracker, so track each piece by its worker/)
  assert.doesNotMatch(off['planner.task.claude'] ?? '', /Cairn task DROVE-5/, 'a goal ref saved earlier is not named once the run has no Cairn')
})

test('AC1: no cairn on PATH and no cairn setting: plan saves a run without Cairn, and neither the planner nor a spawned worker gets a cairn command', async () => {
  const fake = new FakeHerdr()
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan(deps, { repo, kind: 'claude', goal: 'Ship the widget' })
  assert.equal(planned.ok, true, planned.text)
  const id = runIdOf(planned)
  assert.equal((await loadRun(deps.home, id))?.useCairn, false)
  const plannerText = await readFile(join(deps.home, 'runs', id, 'planner', 'role.md'), 'utf8')
  assert.match(plannerText, /^# Drove planner mode/)
  assert.doesNotMatch(plannerText, CAIRN_COMMAND)
  assert.doesNotMatch(plannerText, /cairn/i)
  assert.deepEqual(cairnCalls(fake), [['cairn', '--version']], 'auto looks for cairn once, and runs nothing else')

  delete process.env.HERDR_PANE_ID
  const spawned = await commands.spawn(deps, plannerOf(deps, id), { seat: 'w-api', kind: 'claude', brief: 'Build the widget.' })
  assert.equal(spawned.ok, true, spawned.text)
  const role = await readFile(join(seatDir(deps.home, id, 'w-api'), 'role.md'), 'utf8')
  assert.match(role, /^# Worker mode\n/)
  assert.doesNotMatch(role, /cairn/i)
  assert.match(briefOf(fake), /Build the widget\./)
  assert.doesNotMatch(briefOf(fake), /cairn/i)
  assert.deepEqual(cairnCalls(fake), [['cairn', '--version']], 'the spawn ran no cairn')
})

test('without Cairn a spawn given a task ref refuses with code cairn, before it opens a pane', async () => {
  const fake = new FakeHerdr()
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo, [], { useCairn: false })
  const refused = await commands.spawn(deps, plannerOf(deps, RUN), { seat: 'w-api', kind: 'claude', brief: 'Build it.', cairn: 'DROVE-5' })
  assert.equal(refused.ok, false)
  assert.equal(codeOf(refused), 'cairn')
  assert.match(refused.text, /no cairn CLI was found on this host/)
  assert.equal(fake.calls.some(call => call[0] === 'herdr' && (call[1] === 'tab' || call[1] === 'pane')), false)
  assert.deepEqual(cairnCalls(fake), [])
})

test('AC2: no cairn: plan --from-cairn, --next and a LAB subject refuse with code cairn, naming the setting, before creating anything', async () => {
  for (const request of [{ cairn: 'X-1' }, { next: 'DROVE' }, { cairn: 'LAB-3' }]) {
    const fake = new FakeHerdr()
    const repo = await makeRepo()
    const deps = await makeDeps(fake)
    process.env.HERDR_PANE_ID = 'w1:p5'
    const refused = await commands.plan(deps, { repo, kind: 'claude', ...request })
    assert.equal(refused.ok, false, JSON.stringify(request))
    assert.equal(codeOf(refused), 'cairn')
    assert.match(refused.text, /needs Cairn, and this run has none: the cairn setting is auto and no cairn CLI was found/)
    assert.deepEqual(await runsIn(deps), [], 'no run was saved')
    assert.equal(fake.calls.some(call => call[0] === 'herdr' && ['tab', 'pane', 'workspace'].includes(call[1] ?? '') && call[2] !== 'list'), false)
    assert.deepEqual(cairnCalls(fake), [['cairn', '--version']])
  }
})

test('the cairn setting off refuses --from-cairn even with cairn installed, and never runs it', async () => {
  const fake = new FakeHerdr()
  const calls = installedCairn(fake)
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await setCairn(deps, 'off')
  process.env.HERDR_PANE_ID = 'w1:p5'
  const refused = await commands.plan(deps, { repo, kind: 'claude', cairn: 'DROVE-5' })
  assert.equal(codeOf(refused), 'cairn')
  assert.match(refused.text, /the cairn setting is off in ~\/\.drove\/config\.json/)
  assert.deepEqual(await runsIn(deps), [])
  assert.deepEqual(calls, [])
})

test('AC3: cairn off with cairn installed: plan, a spawn with no ref and the planner beat never run cairn', async () => {
  const fake = new FakeHerdr()
  const calls = installedCairn(fake)
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await setCairn(deps, 'off')
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan(deps, { repo, kind: 'claude', goal: 'Ship it' })
  assert.equal(planned.ok, true, planned.text)
  const id = runIdOf(planned)
  assert.equal((await loadRun(deps.home, id))?.useCairn, false)
  delete process.env.HERDR_PANE_ID
  const identity = plannerOf(deps, id)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief: 'Build it.' })
  assert.equal(spawned.ok, true, spawned.text)
  assert.doesNotMatch(await readFile(join(seatDir(deps.home, id, 'w-api'), 'role.md'), 'utf8'), /cairn/i)
  const refused = await commands.spawn(deps, identity, { seat: 'w-two', kind: 'claude', brief: 'Build it.', cairn: 'DROVE-5' })
  assert.equal(codeOf(refused), 'cairn')
  assert.match(refused.text, /the cairn setting is off/)

  const run = await loadRun(deps.home, id)
  await saveRun(deps.home, { ...run!, cairn: 'DROVE-9' })
  const ports: ToolPorts = { ...defaultToolPorts, commands: { ...defaultToolPorts.commands, roster: async () => ({ ok: true, text: 'roster' }) } }
  const roster = plannerTools(deps, identity, ports).find(tool => tool.name === 'roster')!
  await roster.call({})
  deps.clock.advance(CLAIM_BEAT_EVERY_MS)
  await roster.call({})
  assert.deepEqual(calls, [], 'no cairn call, not even the claim beat')
})

test('a run saved before DROVE-159 keeps Cairn, and the off setting wins over it', async () => {
  const fake = new FakeHerdr()
  const calls = installedCairn(fake)
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo, [])
  await setCairn(deps, 'off')
  const spawned = await commands.spawn(deps, plannerOf(deps, RUN), { seat: 'w-api', kind: 'claude', brief: 'Build it.' })
  assert.equal(spawned.ok, true, spawned.text)
  assert.doesNotMatch(await readFile(join(seatDir(deps.home, RUN, 'w-api'), 'role.md'), 'utf8'), /cairn/i)
  assert.equal((codeOf(await commands.spawn(deps, plannerOf(deps, RUN), { seat: 'w-two', kind: 'claude', brief: 'Build it.', cairn: 'DROVE-5' }))), 'cairn')
  assert.deepEqual(calls, [])
  assert.equal(runUsesCairn({}), true)
  assert.equal(runUsesCairn({}, { cairn: 'off' }), false)
  assert.equal(runUsesCairn({ useCairn: false }, { cairn: 'on' }), true, 'on requires Cairn whatever the run saved')
})

test('detection: auto needs the CLI; a failed read keeps Cairn with a warning; on, off and a saved value never run cairn', async () => {
  const calls: string[][] = []
  const execWith = (answers: Record<string, ExecResult>) => async (argv: readonly string[]): Promise<ExecResult> => {
    calls.push([...argv])
    return answers[argv.join(' ')] ?? { code: 127, stdout: '', stderr: 'not found' }
  }
  const version = { 'cairn --version': { code: 0, stdout: 'cairn 0.22.3', stderr: '' } }
  const working = execWith({ ...version, 'cairn projects': { code: 0, stdout: 'DROVE', stderr: '' } })
  assert.deepEqual(await probeCairn(working), { useCairn: true })
  const blip = await probeCairn(execWith({ ...version, 'cairn projects': { code: 1, stdout: '', stderr: 'CAIRN_API_KEY is not set\n' } }))
  assert.equal(blip.useCairn, true)
  assert.match(blip.warning ?? '', /^Warning: cairn is installed but a read failed \(CAIRN_API_KEY is not set; set CAIRN_AGENT=claude-code or codex .*\); the run keeps Cairn\.$/)
  assert.equal((await probeCairn(execWith({ ...version }))).useCairn, true, 'a read that cannot run at all is still a blip')
  assert.deepEqual(await probeCairn(execWith({})), { useCairn: false })
  assert.deepEqual(await probeCairn(async () => { throw new Error('spawn ENOENT') }), { useCairn: false })
  calls.length = 0
  assert.deepEqual(await detectRunCairn({ exec: working }, 'on'), { useCairn: true })
  assert.deepEqual(await detectRunCairn({ exec: working }, 'off'), { useCairn: false })
  assert.deepEqual(await detectRunCairn({ exec: working }, 'auto', 'claude', false), { useCairn: false })
  assert.deepEqual(await detectRunCairn({ exec: execWith({}) }, 'auto', 'claude', true), { useCairn: true })
  assert.deepEqual(calls, [])
  assert.deepEqual(await detectRunCairn({ exec: working }), { useCairn: true })
})

test('a Cairn blip at plan keeps Cairn: the run saves useCairn true, the planner keeps its Cairn steps, and the result warns', async () => {
  const fake = new FakeHerdr()
  const base = fake.exec
  fake.exec = async (argv, options) => argv[0] !== 'cairn' ? base(argv, options) : argv[1] === '--version' ? { code: 0, stdout: 'cairn 0.22.3\n', stderr: '' } : { code: 1, stdout: '', stderr: 'CAIRN_API_KEY is not set (~/.cairn/instances/croft/env).\n' }
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan(deps, { repo, kind: 'claude', goal: 'Ship it' })
  assert.equal(planned.ok, true, planned.text)
  assert.match(planned.text, /Warning: cairn is installed but a read failed \(CAIRN_API_KEY is not set .*set CAIRN_AGENT=claude-code or codex.*\); the run keeps Cairn\./)
  const id = runIdOf(planned)
  assert.equal((await loadRun(deps.home, id))?.useCairn, true)
  assert.match(await readFile(join(deps.home, 'runs', id, 'planner', 'role.md'), 'utf8'), /Run `cairn check` as usual\./)
})

test('drove up keeps the run\'s saved useCairn whatever cairn does now; a run saved before DROVE-159 is detected once and saved', async () => {
  for (const [saved, cairnNow, expected] of [[false, 'installed', false], [true, 'missing', true], [undefined, 'missing', false], [undefined, 'installed', true]] as const) {
    const fake = new FakeHerdr()
    const calls = cairnNow === 'installed' ? installedCairn(fake) : undefined
    const repo = await makeRepo()
    const deps = await makeDeps(fake)
    await seedRun(deps, repo, [], { status: 'down', ...(saved === undefined ? {} : { useCairn: saved }) })
    const upped = await commands.up(deps, { run: RUN, repo }, undefined, { detached: true, json: true })
    assert.equal(upped.ok, true, upped.text)
    assert.equal((await loadRun(deps.home, RUN))?.useCairn, expected, `saved ${saved}, cairn ${cairnNow}`)
    const probes = (calls ?? cairnCalls(fake)).length
    assert.equal(probes > 0, saved === undefined, `saved ${saved}: ${saved === undefined ? 'detected once' : 'never re-detected'}`)
  }
})

test('the cairn setting is read as auto, on or off, and anything else is auto', async () => {
  const deps = await makeDeps(new FakeHerdr())
  assert.equal((await commands.loadConfig(deps.home)).cairn, 'auto')
  for (const value of ['on', 'off', 'auto']) {
    await setCairn(deps, value)
    assert.equal((await commands.loadConfig(deps.home)).cairn, value)
  }
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ cairn: true }))
  assert.equal((await commands.loadConfig(deps.home)).cairn, 'auto')
})

test('set_goal refuses a task ref on a run without Cairn', async () => {
  const repo = await makeRepo()
  const deps = await makeDeps(new FakeHerdr())
  await seedRun(deps, repo, [], { useCairn: false })
  const refused = await commands.setGoal(deps, { run: RUN, repo }, { goal: 'Ship it', cairn: 'DROVE-5' })
  assert.equal(codeOf(refused), 'cairn')
  assert.equal((await commands.setGoal(deps, { run: RUN, repo }, { goal: 'Ship it' })).ok, true)
})
