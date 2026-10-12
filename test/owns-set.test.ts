import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import * as hooks from '../src/hooks.ts'
import { loadRoster } from '../src/roster.ts'
import type { Deps, Identity } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, RUN, seedRun } from './p3-helpers.ts'

// drove owns / set_owns: the planner widens or replaces an open seat's owns mid-run (DROVE-119).

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_OWNS', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const planner = (deps: Deps): Identity => ({ home: deps.home, run: RUN, role: 'planner', seat: 'planner' })

const setup = async () => {
  const fake = new FakeHerdr()
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo, [])
  return { fake, deps, identity: planner(deps) }
}

const brief = 'Build the widget.'
const MIRROR = 'mod/types/index.d.ts'

const placedEnv = (fake: FakeHerdr): Record<string, string> => {
  const call = fake.calls.filter(item => (item[1] === 'tab' && item[2] === 'create') || (item[1] === 'pane' && item[2] === 'split')).at(-1) ?? []
  return Object.fromEntries(call.flatMap((arg, i) => (arg === '--env' && call[i + 1] ? [[call[i + 1]?.split('=')[0] ?? '', call[i + 1]?.slice((call[i + 1]?.indexOf('=') ?? 0) + 1) ?? '']] : [])))
}

const readEvents = async (deps: Deps) =>
  (await readFile(join(deps.home, 'runs', RUN, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; seat?: string; data?: Record<string, unknown> })

test('owns --add widens an open seat: roster, a seat.owns event and a message to the worker', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, owns: ['src/guard.ts'] })
  const before = fake.calls.length
  const widened = await commands.setOwns(deps, identity, { seat: 'w-api', add: [` ./${MIRROR} `, 'src/guard.ts'] })
  assert.equal(widened.ok, true, widened.text)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats[0]?.owns, ['src/guard.ts', MIRROR])
  const events = (await readEvents(deps)).filter(item => item.type === 'seat.owns')
  assert.deepEqual(events.map(item => [item.seat, item.data]), [['w-api', { owns: ['src/guard.ts', MIRROR], previous: ['src/guard.ts'], mode: 'add' }]])
  const sent = fake.calls.slice(before).map(call => call.join(' ')).join('\n')
  assert.match(sent, /You may now also edit mod\/types\/index\.d\.ts/)
})

test('owns --set replaces the list; an empty list, a bad glob, a reviewer, a seat with no limit, a missing seat and a worker are refused', async () => {
  const { deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, owns: ['src/guard.ts'] })
  await commands.spawn(deps, identity, { seat: 'w-free', kind: 'claude', brief })
  await commands.spawn(deps, identity, { seat: 'w-rev', kind: 'claude', brief, role: 'reviewer', target: 'w-api' })
  const set = await commands.setOwns(deps, identity, { seat: 'w-api', set: ['docs/**'] })
  assert.equal(set.ok, true, set.text)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats[0]?.owns, ['docs/**'])
  const refused = async (request: Parameters<typeof commands.setOwns>[2], who: Identity = identity) => {
    const result = await commands.setOwns(deps, who, request)
    assert.equal(result.ok, false, JSON.stringify(request))
    return result.text
  }
  assert.match(await refused({ seat: 'w-api', set: [] }), /at least one glob/)
  assert.match(await refused({ seat: 'w-api', add: [' ', ''] }), /at least one glob/)
  assert.match(await refused({ seat: 'w-api' }), /--add .* or --set/)
  assert.match(await refused({ seat: 'w-api', add: ['a'], set: ['b'] }), /--add .* or --set/)
  assert.match(await refused({ seat: 'w-api', add: ['../x'] }), /relative to the worktree/)
  assert.match(await refused({ seat: 'w-rev', add: ['src/**'] }), /reviewer/)
  assert.match(await refused({ seat: 'w-free', add: ['src/**'] }), /no owns/)
  assert.match(await refused({ seat: 'w-nope', add: ['src/**'] }), /no open seat/)
  assert.match(await refused({ seat: 'w-api', add: ['src/**'] }, { ...identity, role: 'worker', seat: 'w-api' }), /only the planner/)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats[0]?.owns, ['docs/**'])
})

test('widened owns survive up and a migrate, and reach the relaunched worker env', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, owns: ['src/guard.ts'] })
  assert.equal((await commands.setOwns(deps, identity, { seat: 'w-api', add: [MIRROR] })).ok, true)
  const wide = ['src/guard.ts', MIRROR]
  fake.agents.clear()
  await commands.roster(deps, { run: RUN, repo: '/x' }, false)
  const up = await commands.up(deps, { run: RUN, repo: '/x' }, 'w-api')
  assert.equal(up.ok, true, up.text)
  assert.deepEqual(JSON.parse(placedEnv(fake).DROVE_OWNS ?? 'null'), wide)
  const migrated = await commands.migrate(deps, identity, { seat: 'w-api', kind: 'codex', reason: 'limit' })
  assert.equal(migrated.ok, true, migrated.text)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats[0]?.owns, wide)
  assert.deepEqual(JSON.parse(placedEnv(fake).DROVE_OWNS ?? 'null'), wide)
})

test('the guard reads the roster: an edit refused before set_owns is allowed after it, with no restart', async () => {
  const { deps, identity } = await setup()
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'drove-setowns-')))
  writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/w-api\n')
  mkdirSync(join(worktree, 'mod/types'), { recursive: true })
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief, owns: ['src/**'] })
  // The launch env holds only the owns the seat started with.
  const env = { DROVE_HOME: deps.home, DROVE_RUN: RUN, DROVE_ROLE: 'worker', DROVE_SEAT: 'w-api', DROVE_OWNS: JSON.stringify(['src/**']) }
  const edit = (file: string) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: worktree, tool_name: 'Edit', tool_input: { file_path: join(worktree, file) } })
  const refused = await hooks.runHook('pre-tool-use', edit(MIRROR), env)
  assert.equal(refused.code, 2)
  assert.match(refused.stderr, /set_owns/)
  assert.equal((await commands.setOwns(deps, identity, { seat: 'w-api', add: [MIRROR] })).ok, true)
  assert.equal((await hooks.runHook('pre-tool-use', edit(MIRROR), env)).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', edit('package.json'), env)).code, 2)
})
