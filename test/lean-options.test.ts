import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { seatDir } from '../src/paths.ts'
import { loadRoster, updateRoster } from '../src/roster.ts'
import type { Deps, Identity } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const planner = (deps: Deps): Identity => ({ home: deps.home, run: RUN, role: 'planner', seat: 'planner' })

const setup = async (fake = new FakeHerdr()) => {
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo)
  return { fake, repo, deps, identity: planner(deps) }
}

const brief = 'Build the widget.'

const writeUserClaude = async (deps: Deps, enabledPlugins: Record<string, boolean>): Promise<string> => {
  const claudeUserDir = join(deps.home, 'claude-dir')
  await mkdir(claudeUserDir, { recursive: true })
  await writeFile(join(claudeUserDir, 'settings.json'), JSON.stringify({ enabledPlugins }))
  return claudeUserDir
}

const settingsOf = async (deps: Deps, seat: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(seatDir(deps.home, RUN, seat), 'settings.json'), 'utf8')) as Record<string, unknown>

test("a spawn plugins list makes a claude seat plugin-lean without workerPlugins, [] keeps Drove's mod alone, and an unknown name is noted", async () => {
  const { deps, identity } = await setup()
  const claudeUserDir = await writeUserClaude(deps, { 'context7@claude-plugins-official': true, 'ccc-skills@ccc': true })
  const some = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-a', kind: 'claude', brief, plugins: ['context7', 'nope'] })
  assert.equal(some.ok, true, some.text)
  assert.match(some.text, /Plugin nope is not enabled in the user's Claude settings, so w-a runs without it\./)
  assert.deepEqual((await settingsOf(deps, 'w-a')).enabledPlugins, { 'ccc-skills@ccc': false })
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats[0]?.plugins, ['context7', 'nope'])

  const none = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-b', kind: 'claude', brief, plugins: [] })
  assert.equal(none.ok, true, none.text)
  assert.deepEqual((await settingsOf(deps, 'w-b')).enabledPlugins, { 'context7@claude-plugins-official': false, 'ccc-skills@ccc': false })

  const open = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-c', kind: 'claude', brief })
  assert.equal(open.ok, true, open.text)
  assert.deepEqual(Object.keys(await settingsOf(deps, 'w-c')), ['hooks'], 'no list anywhere keeps every plugin')
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-bad', kind: 'claude', brief, plugins: ['a b'] })).ok, false)
})

test('empty mcp and plugins lists are stored on the seat as [] and make it fully lean', async () => {
  const { deps, identity } = await setup()
  const claudeUserDir = await writeUserClaude(deps, { 'context7@claude-plugins-official': true })
  const claudeUserConfig = join(deps.home, 'claude.json')
  await writeFile(claudeUserConfig, JSON.stringify({ mcpServers: { notion: { command: 'notion-mcp' } } }))
  const spawned = await commands.spawn({ ...deps, claudeUserDir, claudeUserConfig }, identity, { seat: 'w-a', kind: 'claude', brief, mcp: [], plugins: [], userMemory: false })
  assert.equal(spawned.ok, true, spawned.text)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.mcp, seat?.plugins, seat?.userMemory], [[], [], false])
  const mcp = JSON.parse(await readFile(join(seatDir(deps.home, RUN, 'w-a'), 'mcp.json'), 'utf8')) as { mcpServers: object }
  assert.deepEqual(Object.keys(mcp.mcpServers), ['drove'])
  assert.deepEqual((await settingsOf(deps, 'w-a')).enabledPlugins, { 'context7@claude-plugins-official': false })
})

test("a seat's plugins add to workerPlugins", async () => {
  const { deps, identity } = await setup()
  const claudeUserDir = await writeUserClaude(deps, { 'context7@claude-plugins-official': true, 'ccc-skills@ccc': true, 'other@x': true })
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerPlugins: ['ccc-skills'] }))
  const spawned = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-a', kind: 'claude', brief, plugins: ['context7'] })
  assert.equal(spawned.ok, true, spawned.text)
  assert.deepEqual((await settingsOf(deps, 'w-a')).enabledPlugins, { 'other@x': false })
})

test("a seat's userMemory wins over workerUserMemory in both directions", async () => {
  const { deps, identity } = await setup()
  const claudeUserDir = join(deps.home, 'claude-dir')
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerUserMemory: false }))
  const kept = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-a', kind: 'claude', brief, userMemory: true })
  assert.equal(kept.ok, true, kept.text)
  assert.equal((await settingsOf(deps, 'w-a')).claudeMdExcludes, undefined, 'true loads the memory although the config says no')
  const dropped = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-b', kind: 'claude', brief, userMemory: false })
  assert.equal(dropped.ok, true, dropped.text)
  assert.equal(((await settingsOf(deps, 'w-b')).claudeMdExcludes as string[])[0], join(claudeUserDir, 'CLAUDE.md'))
  const followed = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-c', kind: 'claude', brief })
  assert.equal(followed.ok, true, followed.text)
  assert.ok(Array.isArray((await settingsOf(deps, 'w-c')).claudeMdExcludes), 'left out, the config decides')
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats.map(seat => seat.userMemory), [true, false, undefined])

  await writeFile(join(deps.home, 'config.json'), JSON.stringify({}))
  const off = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-d', kind: 'claude', brief, userMemory: false })
  assert.equal(off.ok, true, off.text)
  assert.ok(Array.isArray((await settingsOf(deps, 'w-d')).claudeMdExcludes), 'false trims one seat of a run that loads memory')
})

test('a codex seat keeps the shared AGENTS.md link whatever its userMemory says, and the spawn says so', async () => {
  const { deps, identity } = await setup()
  const codexUserHome = join(deps.home, 'user-codex')
  await mkdir(codexUserHome, { recursive: true })
  await writeFile(join(codexUserHome, 'AGENTS.md'), 'user rules')
  const spawned = await commands.spawn({ ...deps, codexUserHome }, identity, { seat: 'w-cx', kind: 'codex', brief, userMemory: false, plugins: ['context7'] })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /w-cx is a Codex seat: plugins and userMemory apply to Claude seats only\. A Codex seat follows the workerUserMemory config key/)
  assert.ok(existsSync(join(deps.home, 'runs', RUN, 'codex-home', 'AGENTS.md')))
})

test('promote restarts a claude seat with the plugins and userMemory it was spawned with', async () => {
  const { fake, deps, identity } = await setup()
  const claudeUserDir = await writeUserClaude(deps, { 'context7@claude-plugins-official': true, 'ccc-skills@ccc': true })
  const withDir = { ...deps, claudeUserDir }
  await commands.spawn(withDir, identity, { seat: 'w-api', kind: 'claude', brief, plugins: ['context7'], userMemory: false })
  await updateRoster(deps.home, RUN, roster => ({
    ...roster,
    seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, owes: 'answer' as const, lastReport: { id: 'r-1', kind: 'promote' as const, expects: 'answer' as const, summary: 'stuck', at: '2026-10-09T10:30:00.000Z' } })),
  }))
  fake.setStatus('w-api', 'idle')
  await rm(join(seatDir(deps.home, RUN, 'w-api'), 'settings.json'))
  const promoted = await commands.promote(withDir, identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  const settings = await settingsOf(deps, 'w-api')
  assert.deepEqual(settings.enabledPlugins, { 'ccc-skills@ccc': false })
  assert.equal((settings.claudeMdExcludes as string[])[0], join(claudeUserDir, 'CLAUDE.md'))
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.plugins, seat?.userMemory], [['context7'], false])
})

test("the planner's role text names the MCP servers and plugins the user has, read and never written", async () => {
  const repo = await makeRepo()
  const deps = await makeDeps(new FakeHerdr())
  const claudeUserDir = await writeUserClaude(deps, { 'context7@claude-plugins-official': true, 'old@x': false })
  const claudeUserConfig = join(deps.home, 'claude.json')
  await writeFile(claudeUserConfig, JSON.stringify({ mcpServers: { mongodb: { command: 'mongo-mcp' }, drove: { command: 'stale' } } }))
  const codexUserHome = join(deps.home, 'user-codex')
  await mkdir(codexUserHome, { recursive: true })
  await writeFile(join(codexUserHome, 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-mcp"\n')
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan({ ...deps, claudeUserDir, claudeUserConfig, codexUserHome }, { repo, kind: 'claude', goal: 'Ship the thing' })
  assert.equal(planned.ok, true, planned.text)
  const id = (planned.ok ? (planned.data as commands.ProcessPlan).env.DROVE_RUN : '') as string
  const role = await readFile(join(deps.home, 'runs', id, 'planner', 'role.md'), 'utf8')
  assert.match(role, /## Lean spawns/)
  assert.match(role, /Claude servers: mongodb\./)
  assert.match(role, /Codex servers: docs\./)
  assert.match(role, /Plugins: context7\./)
})

test('migrate codex to claude carries the seat\'s plugins and userMemory into the new claude launch', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-old', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  const claudeUserDir = await writeUserClaude(deps, { 'context7@claude-plugins-official': true, 'ccc-skills@ccc': true })
  const withDir = { ...deps, claudeUserDir }
  const spawned = await commands.spawn(withDir, identity, { seat: 'w-cx', kind: 'codex', brief, plugins: ['context7'], userMemory: false })
  assert.equal(spawned.ok, true, spawned.text)
  fake.startSession = undefined
  const migrated = await commands.migrate(withDir, identity, { seat: 'w-cx', kind: 'claude' })
  assert.equal(migrated.ok, true, migrated.text)
  const settings = await settingsOf(deps, 'w-cx')
  assert.deepEqual(settings.enabledPlugins, { 'ccc-skills@ccc': false })
  assert.equal((settings.claudeMdExcludes as string[])[0], join(claudeUserDir, 'CLAUDE.md'))
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.kind, seat?.plugins, seat?.userMemory], ['claude', ['context7'], false])
})
