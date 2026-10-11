import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  assert.match(spawned.text, /w-cx is a Codex seat: plugins and userMemory apply to Claude seats only\. A Codex seat follows the workerUserMemory and workerUserHooks config keys/)
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

// ---------- skills, agents and the user's settings hooks (DROVE-98) ----------

const writeUserNames = async (deps: Deps): Promise<string> => {
  const claudeUserDir = join(deps.home, 'claude-dir')
  await mkdir(join(claudeUserDir, 'skills', 'cairn'), { recursive: true })
  await mkdir(join(claudeUserDir, 'skills', 'arb'), { recursive: true })
  await mkdir(join(claudeUserDir, 'agents', 'design'), { recursive: true })
  await mkdir(join(claudeUserDir, 'commands'), { recursive: true })
  await writeFile(join(claudeUserDir, 'skills', 'cairn', 'SKILL.md'), '---\nname: cairn\n---\n')
  await writeFile(join(claudeUserDir, 'skills', 'arb', 'SKILL.md'), '---\nname: arb\n---\n')
  await writeFile(join(claudeUserDir, 'commands', 'audit.md'), 'x')
  await writeFile(join(claudeUserDir, 'agents', 'debugger.md'), '---\nname: debugger\n---\n')
  await writeFile(join(claudeUserDir, 'agents', 'design', 'ui.md'), '---\nname: ui-ux-designer\n---\n')
  await writeFile(join(claudeUserDir, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cairn-start' }] }] },
    env: { NOTION_API_KEY: 'k' },
    permissions: { deny: ['Bash(rm -rf *)'] },
    enabledPlugins: { 'context7@claude-plugins-official': true },
  }))
  return claudeUserDir
}

test("a spawn's skills and agents lists make a claude seat lean, [] means none, and the config lists are added to", async () => {
  const { deps, identity } = await setup()
  const claudeUserDir = await writeUserNames(deps)
  const some = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-a', kind: 'claude', brief, skills: ['cairn'], agents: ['debugger'] })
  assert.equal(some.ok, true, some.text)
  const settings = await settingsOf(deps, 'w-a')
  assert.deepEqual(settings.skillOverrides, { arb: 'off', audit: 'off' })
  assert.deepEqual(settings.permissions, { deny: ['Agent(ui-ux-designer)'] })
  const argv = (JSON.parse(await readFile(join(seatDir(deps.home, RUN, 'w-a'), 'launch.json'), 'utf8')) as { argv: string[] }).argv
  assert.ok(!argv.includes('--disable-slash-commands'))
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.skills, seat?.agents], [['cairn'], ['debugger']])

  const none = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-b', kind: 'claude', brief, skills: [], agents: [] })
  assert.equal(none.ok, true, none.text)
  const noneArgv = (JSON.parse(await readFile(join(seatDir(deps.home, RUN, 'w-b'), 'launch.json'), 'utf8')) as { argv: string[] }).argv
  assert.ok(noneArgv.includes('--disable-slash-commands'))
  assert.deepEqual((await settingsOf(deps, 'w-b')).permissions, { deny: ['Agent(debugger)', 'Agent(ui-ux-designer)'] })

  const open = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-c', kind: 'claude', brief })
  assert.equal(open.ok, true, open.text)
  assert.deepEqual(Object.keys(await settingsOf(deps, 'w-c')), ['hooks'], 'no list anywhere keeps every skill and agent')

  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerSkills: ['arb'], workerAgents: ['ui-ux-designer'] }))
  const added = await commands.spawn({ ...deps, claudeUserDir }, identity, { seat: 'w-d', kind: 'claude', brief, skills: ['cairn'] })
  assert.equal(added.ok, true, added.text)
  const merged = await settingsOf(deps, 'w-d')
  assert.deepEqual(merged.skillOverrides, { audit: 'off' }, "the seat's list adds to workerSkills")
  assert.deepEqual(merged.permissions, { deny: ['Agent(debugger)'] }, 'workerAgents alone makes the seat lean')
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-bad', kind: 'claude', brief, skills: ['a b'] })).ok, false)
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-bad', kind: 'claude', brief, agents: ['a,b c'] })).ok, false)
})

test("a seat's userHooks wins over workerUserHooks, and false drops the user source and carries the settings minus hooks", async () => {
  const { deps, identity } = await setup()
  const claudeUserDir = await writeUserNames(deps)
  const claudeUserConfig = join(deps.home, 'claude.json')
  await writeFile(claudeUserConfig, JSON.stringify({ mcpServers: { notion: { command: 'notion-mcp' } } }))
  const argvOf = async (seat: string): Promise<string[]> => (JSON.parse(await readFile(join(seatDir(deps.home, RUN, seat), 'launch.json'), 'utf8')) as { argv: string[] }).argv
  const withDirs = { ...deps, claudeUserDir, claudeUserConfig }

  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerUserHooks: false }))
  const followed = await commands.spawn(withDirs, identity, { seat: 'w-a', kind: 'claude', brief })
  assert.equal(followed.ok, true, followed.text)
  assert.match(followed.text, /w-a runs without the user's own settings hooks, and so without the user's own skills, agents and commands/)
  assert.ok((await argvOf('w-a')).includes('--setting-sources'))
  const settings = await settingsOf(deps, 'w-a')
  assert.deepEqual(settings.env, { NOTION_API_KEY: 'k' })
  assert.deepEqual(settings.permissions, { deny: ['Bash(rm -rf *)'] })
  assert.ok(!JSON.stringify(settings.hooks).includes('cairn-start'))
  const mcp = JSON.parse(await readFile(join(seatDir(deps.home, RUN, 'w-a'), 'mcp.json'), 'utf8')) as { mcpServers: object }
  assert.deepEqual(Object.keys(mcp.mcpServers), ['notion', 'drove'], 'the user-scope servers come through mcp.json')

  const kept = await commands.spawn(withDirs, identity, { seat: 'w-b', kind: 'claude', brief, userHooks: true })
  assert.equal(kept.ok, true, kept.text)
  assert.ok(!(await argvOf('w-b')).includes('--setting-sources'), 'true keeps the hooks although the config says no')
  assert.doesNotMatch(kept.text, /settings hooks/)

  await writeFile(join(deps.home, 'config.json'), JSON.stringify({}))
  const dropped = await commands.spawn(withDirs, identity, { seat: 'w-c', kind: 'claude', brief, userHooks: false })
  assert.equal(dropped.ok, true, dropped.text)
  assert.ok((await argvOf('w-c')).includes('--setting-sources'))
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats.map(seat => seat.userHooks), [undefined, true, false])
  assert.equal((await commands.spawn(withDirs, identity, { seat: 'w-d', kind: 'claude', brief, userHooks: 'no' as unknown as boolean })).ok, false)
})

test('promote keeps the skills, agents and userHooks a seat was spawned with', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-old', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  const claudeUserDir = await writeUserNames(deps)
  const withDir = { ...deps, claudeUserDir }
  const spawned = await commands.spawn(withDir, identity, { seat: 'w-api', kind: 'claude', brief, skills: ['cairn'], agents: [], userHooks: false })
  assert.equal(spawned.ok, true, spawned.text)
  await updateRoster(deps.home, RUN, roster => ({
    ...roster,
    seats: roster.seats.map(seat => ({ ...seat, state: 'idle' as const, owes: 'answer' as const, lastReport: { id: 'r-1', kind: 'promote' as const, expects: 'answer' as const, summary: 'stuck', at: '2026-10-09T10:30:00.000Z' } })),
  }))
  fake.setStatus('w-api', 'idle')
  await rm(join(seatDir(deps.home, RUN, 'w-api'), 'settings.json'))
  const promoted = await commands.promote(withDir, identity, { seat: 'w-api', model: 'opus', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  const settings = await settingsOf(deps, 'w-api')
  assert.deepEqual(settings.env, { NOTION_API_KEY: 'k' }, 'the user settings still come through after a promote')
  assert.ok(!JSON.stringify(settings.hooks).includes('cairn-start'))
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.skills, seat?.agents, seat?.userHooks], [['cairn'], [], false])
})

test("a codex seat follows workerUserHooks for the shared home's hooks, and the spawn says its skills, agents and userHooks are Claude-only", async () => {
  const { deps, identity } = await setup()
  const codexUserHome = join(deps.home, 'user-codex')
  await mkdir(codexUserHome, { recursive: true })
  await writeFile(join(codexUserHome, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'user-start' }] }] } }))
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerUserHooks: false }))
  const spawned = await commands.spawn({ ...deps, codexUserHome }, identity, { seat: 'w-cx', kind: 'codex', brief, skills: [], agents: [], userHooks: true })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /w-cx is a Codex seat: skills, agents and userHooks apply to Claude seats only\. A Codex seat follows the workerUserMemory and workerUserHooks config keys/)
  const hooks = await readFile(join(deps.home, 'runs', RUN, 'codex-home', 'hooks.json'), 'utf8')
  assert.ok(!hooks.includes('user-start'))
})

test('migrate codex to claude carries the seat\'s skills, agents and userHooks into the new claude launch', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-old', startStatus: 'idle' })
  const { deps, identity } = await setup(fake)
  const claudeUserDir = await writeUserNames(deps)
  const withDir = { ...deps, claudeUserDir }
  const spawned = await commands.spawn(withDir, identity, { seat: 'w-cx', kind: 'codex', brief, skills: ['cairn'], agents: ['debugger'] })
  assert.equal(spawned.ok, true, spawned.text)
  fake.startSession = undefined
  const migrated = await commands.migrate(withDir, identity, { seat: 'w-cx', kind: 'claude' })
  assert.equal(migrated.ok, true, migrated.text)
  const settings = await settingsOf(deps, 'w-cx')
  assert.deepEqual(settings.skillOverrides, { arb: 'off', audit: 'off' })
  assert.deepEqual(settings.permissions, { deny: ['Agent(ui-ux-designer)'] })
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.kind, seat?.skills, seat?.agents], ['claude', ['cairn'], ['debugger']])
})

test("launch.json, the spawn result, events and the roster never hold the user's env values; the 0600 settings.json and mcp.json do", async () => {
  const { deps, identity } = await setup()
  const claudeUserDir = join(deps.home, 'claude-dir')
  await mkdir(claudeUserDir, { recursive: true })
  await writeFile(join(claudeUserDir, 'settings.json'), JSON.stringify({ env: { NOTION_API_KEY: 'sk-user-secret' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }))
  const claudeUserConfig = join(deps.home, 'claude.json')
  await writeFile(claudeUserConfig, JSON.stringify({ mcpServers: { notion: { command: 'notion-mcp', env: { TOKEN: 'mcp-secret' }, headers: { Authorization: 'Bearer hdr-secret' } } } }))
  const codexUserHome = join(deps.home, 'user-codex')
  await mkdir(codexUserHome, { recursive: true })
  await writeFile(join(codexUserHome, 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-mcp"\n\n[mcp_servers.docs.env]\nDOCS_TOKEN = "codex-secret"\n\n[mcp_servers.inline]\ncommand = "x"\nenv = { A = "inline-secret" }\n')
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerUserHooks: false, workerEnv: { MY_SECRET: 'worker-secret' } }))
  const secrets = ['sk-user-secret', 'mcp-secret', 'hdr-secret', 'codex-secret', 'inline-secret', 'worker-secret']
  const withDirs = { ...deps, claudeUserDir, claudeUserConfig, codexUserHome }

  const claude = await commands.spawn(withDirs, identity, { seat: 'w-a', kind: 'claude', brief })
  const codex = await commands.spawn(withDirs, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(claude.ok && codex.ok, true, `${claude.text} ${codex.text}`)
  for (const text of [claude.text, codex.text]) for (const secret of secrets) assert.ok(!text.includes(secret), `spawn result holds ${secret}`)

  const launchJson = await readFile(join(seatDir(deps.home, RUN, 'w-a'), 'launch.json'), 'utf8')
  const codexLaunch = await readFile(join(seatDir(deps.home, RUN, 'w-cx'), 'launch.json'), 'utf8')
  for (const secret of secrets) {
    assert.ok(!launchJson.includes(secret), `launch.json holds ${secret}`)
    assert.ok(!codexLaunch.includes(secret), `codex launch.json holds ${secret}`)
  }
  const recorded = JSON.parse(launchJson) as { env: Record<string, string>; files: { path: string; content: string }[] }
  assert.equal(recorded.env.MY_SECRET, '<redacted>')
  assert.ok(recorded.env.DROVE_RUN, "Drove's own variables stay readable")
  const recordedSettings = JSON.parse(recorded.files.find(file => file.path.endsWith('/settings.json'))?.content ?? '{}') as { env: Record<string, string> }
  assert.deepEqual(recordedSettings.env, { NOTION_API_KEY: '<redacted>' }, 'the key stays, so the record shows what was carried')

  const settingsPath = join(seatDir(deps.home, RUN, 'w-a'), 'settings.json')
  assert.match(await readFile(settingsPath, 'utf8'), /sk-user-secret/, 'Claude needs the real value')
  assert.match(await readFile(join(seatDir(deps.home, RUN, 'w-a'), 'mcp.json'), 'utf8'), /mcp-secret/)
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600)
  assert.equal((await stat(join(seatDir(deps.home, RUN, 'w-a'), 'mcp.json'))).mode & 0o777, 0o600)

  for (const name of ['events.jsonl', 'roster.json']) {
    const text = await readFile(join(deps.home, 'runs', RUN, name), 'utf8').catch(() => '')
    for (const secret of secrets) assert.ok(!text.includes(secret), `${name} holds ${secret}`)
  }
  const seatFiles = await readdir(seatDir(deps.home, RUN, 'w-a'))
  assert.ok(seatFiles.includes('launch.json'))
})
