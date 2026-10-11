import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import * as iso from '../src/isolation.ts'
import { briefFooter } from '../src/prompts.ts'
import { loadRoster } from '../src/roster.ts'
import type { Deps, Identity } from '../src/types.ts'
import { FakeHerdr, git, makeDeps, makeRepo, RUN, seedRun, tmp } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const planner = (deps: Deps): Identity => ({ home: deps.home, run: RUN, role: 'planner', seat: 'planner' })

const setup = async (config: Record<string, unknown>) => {
  const fake = new FakeHerdr()
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo, [], {})
  await writeFile(join(deps.home, 'config.json'), JSON.stringify(config))
  return { fake, repo, deps, identity: planner(deps) }
}

const launchEnv = (fake: FakeHerdr, name: string): string[] => {
  const calls = fake.calls.filter(call => call[1] === 'tab' || call[1] === 'pane')
  return calls.flatMap(call => call.filter(arg => /^[A-Z_]+=/.test(arg))).filter(arg => name === '' || arg.startsWith(`${name}=`))
}

test('freeSlot takes the lowest index no open seat holds, so a closed seat\'s slot is reused', () => {
  assert.equal(iso.freeSlot([]), 0)
  assert.equal(iso.freeSlot([0, 1, undefined]), 2)
  assert.equal(iso.freeSlot([1, 2]), 0)
  assert.equal(iso.freeSlot([0, 2]), 1)
})

test('portEnv gives PORT, DROVE_PORT_BASE and DROVE_PORT_COUNT from base, slot and stride', () => {
  assert.deepEqual(iso.portEnv({ base: 4100, stride: 10 }, 2), { PORT: '4120', DROVE_PORT_BASE: '4120', DROVE_PORT_COUNT: '10' })
  assert.deepEqual(iso.portEnv(undefined, 2), {})
  assert.deepEqual(iso.portEnv({ base: 65530, stride: 10 }, 0), {})
})

test('workerEnv placeholders are substituted per seat and unknown ones are left and reported', () => {
  const { env, unknown } = iso.seatEnv(
    { DATABASE_URL: 'postgres://localhost/app_{seat}', URL: 'http://localhost:{port}', TAG: '{run}-{slot}', ODD: '{nope} {seat}' },
    { base: 4100, stride: 10 },
    { run: 'r1', seat: 'w-api', slot: 3 },
  )
  assert.equal(env.DATABASE_URL, 'postgres://localhost/app_w-api')
  assert.equal(env.URL, 'http://localhost:4130')
  assert.equal(env.TAG, 'r1-3')
  assert.equal(env.ODD, '{nope} w-api')
  assert.equal(env.PORT, '4130')
  assert.deepEqual(unknown, ['{nope}'])
  assert.equal(iso.seatEnv({ A: '{port}' }, undefined, { run: 'r', seat: 's', slot: 0 }).env.A, '{port}')
  assert.equal(iso.seatEnv({ PORT: '9999' }, { base: 4100, stride: 10 }, { run: 'r', seat: 's', slot: 0 }).env.PORT, '9999')
})

test('planCopy lists ignored untracked matches and refuses ones git does not ignore; applyCopy never overwrites', async () => {
  const { repo } = await setup({})
  await appendFile(join(repo, '.git', 'info', 'exclude'), '.env\n.env.local\nsecrets/\n')
  await writeFile(join(repo, '.env'), 'A=1\n')
  await writeFile(join(repo, '.env.local'), 'B=2\n')
  await writeFile(join(repo, '.env.example'), 'C=3\n')
  await mkdir(join(repo, 'secrets'))
  await writeFile(join(repo, 'secrets', 'key.json'), '{}')
  const plan = await iso.planCopy(commands.nodeExec, repo, ['.env', '.env.*', 'secrets/*.json', '../outside', 'README.md', 'missing'])
  assert.deepEqual(plan.files, ['.env', '.env.local', 'secrets/key.json'])
  assert.deepEqual(plan.refused, ['../outside', '.env.example'])

  const worktree = await tmp('wt')
  await writeFile(join(worktree, '.env'), 'OWN=1\n')
  const result = await iso.applyCopy(repo, worktree, plan.files)
  assert.deepEqual(result.copied, ['.env.local', 'secrets/key.json'])
  assert.deepEqual(result.kept, ['.env'])
  assert.equal(await readFile(join(worktree, '.env'), 'utf8'), 'OWN=1\n')
  assert.equal(await readFile(join(worktree, 'secrets', 'key.json'), 'utf8'), '{}')
})

test('the brief footer says the seat\'s ports and copied files in one line, only when set', () => {
  const plain = briefFooter('w-api', 'DROVE-7', { branch: 'b' })
  assert.doesNotMatch(plain, /ports|copied/i)
  const footer = briefFooter('w-api', 'DROVE-7', { branch: 'b', ports: { port: 4110, count: 10 }, copied: ['.env', '.env.local'] })
  assert.match(footer, /Your ports are 4110-4119 \(PORT=4110\); use only those\. Untracked files copied from the main checkout: \.env, \.env\.local\. Report with/)
  assert.ok(!footer.trimStart().includes('\n'))
})

test('loadConfig keeps a valid workerPorts and workerCopy and drops bad ones', async () => {
  const { deps } = await setup({ workerPorts: { base: 4100, stride: 10 }, workerCopy: ['.env', 3, ' '] })
  const config = await commands.loadConfig(deps.home)
  assert.deepEqual(config.workerPorts, { base: 4100, stride: 10 })
  assert.deepEqual(config.workerCopy, ['.env'])
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerPorts: { base: 'x', stride: 0 } }))
  assert.equal((await commands.loadConfig(deps.home)).workerPorts, undefined)
})

test('spawn gives each seat a slot and PORT, templates workerEnv, tells the brief, and reuses a closed seat\'s slot', async () => {
  const { fake, deps, identity } = await setup({ workerPorts: { base: 4100, stride: 10 }, workerEnv: { DATABASE_URL: 'postgres://localhost/app_{seat}', ODD: '{nope}' } })
  const first = await commands.spawn(deps, identity, { seat: 'w-a', kind: 'codex', brief: 'Build a.' })
  assert.equal(first.ok, true, first.text)
  assert.match(first.text, /Note: workerEnv has placeholders Drove does not know, left as written: \{nope\}/)
  const second = await commands.spawn(deps, identity, { seat: 'w-b', kind: 'codex', brief: 'Build b.' })
  assert.equal(second.ok, true, second.text)
  let roster = await loadRoster(deps.home, RUN)
  assert.deepEqual(roster.seats.map(seat => [seat.name, seat.slot]), [['w-a', 0], ['w-b', 1]])

  const env = launchEnv(fake, '')
  assert.ok(env.includes('PORT=4100'))
  assert.ok(env.includes('PORT=4110'))
  assert.ok(env.includes('DROVE_PORT_COUNT=10'))
  assert.ok(env.includes('DATABASE_URL=postgres://localhost/app_w-a'))
  assert.ok(env.includes('DATABASE_URL=postgres://localhost/app_w-b'))
  const brief = await readFile(join(deps.home, 'runs', RUN, 'seats', 'w-b', 'brief.md'), 'utf8')
  assert.match(brief, /Your ports are 4110-4119 \(PORT=4110\)/)

  const closed = await commands.close(deps, identity, 'w-a', false)
  assert.equal(closed.ok, true, closed.text)
  const third = await commands.spawn(deps, identity, { seat: 'w-c', kind: 'codex', brief: 'Build c.' })
  assert.equal(third.ok, true, third.text)
  roster = await loadRoster(deps.home, RUN)
  assert.equal(roster.seats.find(seat => seat.name === 'w-c')?.slot, 0)
  assert.equal(roster.seats.find(seat => seat.name === 'w-b')?.slot, 1)
})

test('spawn copies ignored workerCopy files into a codex worktree, refuses unignored ones, and tells the brief', async () => {
  const { deps, identity, repo } = await setup({ workerCopy: ['.env', '.env.example'] })
  await appendFile(join(repo, '.git', 'info', 'exclude'), '.env\n')
  await writeFile(join(repo, '.env'), 'SECRET=1\n')
  await writeFile(join(repo, '.env.example'), 'X=1\n')
  const spawned = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief: 'Build.' })
  assert.equal(spawned.ok, true, spawned.text)
  const worktree = join(repo, '.claude', 'worktrees', 'w-cx')
  assert.equal(await readFile(join(worktree, '.env'), 'utf8'), 'SECRET=1\n')
  assert.equal(existsSync(join(worktree, '.env.example')), false)
  assert.match(spawned.text, /Copied \.env from the main checkout/)
  assert.match(spawned.text, /workerCopy left out \.env\.example/)
  assert.equal(await git(worktree, 'status', '--porcelain'), '')
  const brief = await readFile(join(deps.home, 'runs', RUN, 'seats', 'w-cx', 'brief.md'), 'utf8')
  assert.match(brief, /Untracked files copied from the main checkout: \.env\./)
})

test('spawn copies workerCopy files into a claude worktree once it appears', async () => {
  const { deps, identity, repo } = await setup({ workerCopy: ['.env'] })
  await appendFile(join(repo, '.git', 'info', 'exclude'), '.env\n')
  await writeFile(join(repo, '.env'), 'SECRET=1\n')
  const spawned = await commands.spawn(deps, identity, { seat: 'w-cl', kind: 'claude', brief: 'Build.' })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal(await readFile(join(repo, '.claude', 'worktrees', 'w-cl', '.env'), 'utf8'), 'SECRET=1\n')
  assert.match(spawned.text, /Copied \.env/)
})
