import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import { detectAgents, nodeAgentDeps } from '../src/agents.ts'
import { spawnRequestOf } from '../src/cli.ts'
import * as deliver from '../src/deliver.ts'
import { attach } from '../src/modhost.ts'
import { loadRoster, loadRun, rosterLines, saveRun, updateRoster } from '../src/roster.ts'
import type { AgentKind, Deps, HostAgents, Identity } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
  process.env.HERDR_PANE_ID = 'w1:p0'
})

const agents: HostAgents = { at: '2026-10-12T10:00:00.000Z', claude: { version: '2.1.296' }, codex: { version: '0.162.0', model: 'gpt-6.1-sol', effort: 'high' } }
const brief = 'Build the widget.'
const setup = async (detected: HostAgents | undefined = agents) => {
  const fake = new FakeHerdr({ startSession: 'thread-1' })
  const deps = await makeDeps(fake)
  const repo = await makeRepo()
  const run = await seedRun(deps, repo, [], { agents: detected })
  const identity: Identity = { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }
  return { fake, deps, repo, run, identity }
}
const starts = (fake: FakeHerdr) => fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start')

test('spawn and migrate refuse an absent kind other than the planner before touching panes or worktrees', async () => {
  for (const kind of ['claude', 'codex'] as const) {
    const other = kind === 'claude' ? 'codex' : 'claude'
    const { fake, deps, identity, run } = await setup({ at: agents.at, [other]: agents[other] })
    await saveRun(deps.home, { ...run, planner: { ...run.planner, kind: other } })
    const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind, brief })
    assert.deepEqual(spawned, { ok: false, code: 'agent-unavailable', text: `${kind} is not on this host (drove doctor)` })
    const migrated = await commands.migrate(deps, identity, { seat: 'w-api', kind })
    assert.deepEqual(migrated, spawned)
    assert.deepEqual(fake.calls, [])
    assert.deepEqual((await loadRoster(deps.home, RUN)).seats, [])
  }
})

test('the planner kind remains usable for spawn and migrate when its own probe failed', async () => {
  for (const kind of ['claude', 'codex'] as const) {
    const other = kind === 'claude' ? 'codex' : 'claude'
    const { deps, identity, run } = await setup({ at: agents.at, [other]: agents[other] })
    await saveRun(deps.home, { ...run, planner: { ...run.planner, kind } })
    const spawned = await commands.spawn(deps, identity, { seat: 'w-planner-kind', kind, brief })
    assert.equal(spawned.ok, true, spawned.text)
    const otherSeat = await commands.spawn(deps, identity, { seat: 'w-other-kind', kind: other, brief })
    assert.equal(otherSeat.ok, true, otherSeat.text)
    const migrated = await commands.migrate(deps, identity, { seat: 'w-other-kind', kind })
    assert.equal(migrated.ok, true, migrated.text)
    assert.equal((await loadRoster(deps.home, RUN)).seats.find(seat => seat.name === 'w-other-kind')?.kind, kind)
  }
})

test('no agents are saved when both probes fail at plan, attach, and resume; workers retain legacy availability', async () => {
  const { fake, deps, identity, repo, run } = await setup()
  const failed: Deps = { ...deps, exec: (argv, options) => argv[1] === '--version' && (argv[0] === 'claude' || argv[0] === 'codex')
    ? Promise.resolve({ code: 124, stdout: '', stderr: 'timeout' })
    : fake.exec(argv, options) }
  const planned = await commands.plan(failed, { repo, kind: 'codex', run: RUN })
  assert.equal(planned.ok, true, planned.text)
  assert.equal((await loadRun(deps.home, RUN))?.agents, undefined)
  const attached = await attach(failed, { repo, run: RUN, sessionId: 'planner', paneId: 'w1:p0' })
  assert.equal(attached.ok, true, attached.text)
  assert.equal((await loadRun(deps.home, RUN))?.agents, undefined)
  await saveRun(deps.home, { ...run, status: 'down' })
  const resumed = await commands.up(failed, { run: RUN, repo })
  assert.equal(resumed.ok, true, resumed.text)
  assert.equal((await loadRun(deps.home, RUN))?.agents, undefined)
  for (const kind of ['claude', 'codex'] as const) {
    const spawned = await commands.spawn(failed, identity, { seat: `w-${kind}`, kind, brief })
    assert.equal(spawned.ok, true, spawned.text)
  }
})

test('legacy runs without agents can still spawn either kind', async () => {
  const ctx = await setup()
  await saveRun(ctx.deps.home, { ...ctx.run, agents: undefined })
  for (const kind of ['claude', 'codex'] as const) {
    const spawned = await commands.spawn(ctx.deps, ctx.identity, { seat: `w-${kind}`, kind, brief })
    assert.equal(spawned.ok, true, spawned.text)
  }
})

test('workerKind supplies an omitted kind; an explicit kind wins; auto and invalid config fall back to Claude', async () => {
  assert.equal(spawnRequestOf({}, ['w-api'], brief).kind, undefined)
  for (const workerKind of ['auto', 'claude', 'codex', 'invalid', undefined]) {
    const { deps, identity } = await setup()
    await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerKind }))
    const config = await commands.loadConfig(deps.home)
    assert.equal(config.workerKind, workerKind === 'codex' || workerKind === 'claude' ? workerKind : 'auto')
    const spawned = await commands.spawn(deps, identity, { seat: 'w-auto', brief })
    assert.equal(spawned.ok, true, spawned.text)
    assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.kind, workerKind === 'codex' ? 'codex' : 'claude')
    if (workerKind === 'codex') {
      const explicit = await commands.spawn(deps, identity, { seat: 'w-explicit', kind: 'claude', brief })
      assert.equal(explicit.ok, true, explicit.text)
      assert.equal((await loadRoster(deps.home, RUN)).seats[1]?.kind, 'claude')
    }
  }
})

test('a forced workerKind is still subject to host availability', async () => {
  const { deps, identity } = await setup({ at: agents.at, claude: agents.claude })
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerKind: 'codex' }))
  const result = await commands.spawn(deps, identity, { seat: 'w-auto', brief })
  assert.equal(result.ok, false)
  assert.match(result.text, /codex is not on this host/)
})

test('workerKind auto chooses Codex on a Codex-only host', async () => {
  const { deps, identity, run } = await setup({ at: agents.at, codex: agents.codex })
  await saveRun(deps.home, { ...run, planner: { ...run.planner, kind: 'codex' } })
  const spawned = await commands.spawn(deps, identity, { seat: 'w-auto', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.kind, 'codex')
})

test('auto refuses with a doctor hint if the saved run has no usable kind', async () => {
  const { fake, deps, identity, run } = await setup({ at: agents.at })
  await saveRun(deps.home, { ...run, planner: { ...run.planner, kind: 'unknown' as AgentKind } })
  const spawned = await commands.spawn(deps, identity, { seat: 'w-auto', brief })
  assert.equal(spawned.ok, false)
  assert.match(spawned.text, /neither claude nor codex is on this host \(drove doctor\)/)
  assert.deepEqual(fake.calls, [])
})

test('plan, attach, and resume ignore a Drove-generated or empty CODEX_HOME', async () => {
  const { fake, deps, repo, run } = await setup()
  const generatedHome = join(deps.home, 'runs', 'other-run', 'codex-home')
  await mkdir(generatedHome, { recursive: true })
  await writeFile(join(generatedHome, 'config.toml'), 'model = "generated-model-that-must-not-be-detected"\n')
  const expected = await detectAgents(nodeAgentDeps(fake.exec, join(homedir(), '.codex'), deps.clock.now))
  const withoutInjectedHome: Deps = { ...deps, codexUserHome: undefined }
  const originalHome = process.env.CODEX_HOME
  try {
    for (const codexHome of [generatedHome, '']) {
      process.env.CODEX_HOME = codexHome
      const planned = await commands.plan(withoutInjectedHome, { repo, run: RUN, kind: 'codex' })
      assert.equal(planned.ok, true, planned.text)
      assert.deepEqual((await loadRun(deps.home, RUN))?.agents, expected)
      const attached = await attach(withoutInjectedHome, { repo, run: RUN, sessionId: 'planner', paneId: 'w1:p0' })
      assert.equal(attached.ok, true, attached.text)
      assert.deepEqual((await loadRun(deps.home, RUN))?.agents, expected)
      await saveRun(deps.home, { ...run, status: 'down' })
      const resumed = await commands.up(withoutInjectedHome, { run: RUN, repo })
      assert.equal(resumed.ok, true, resumed.text)
      assert.deepEqual((await loadRun(deps.home, RUN))?.agents, expected)
    }
  } finally {
    if (originalHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalHome
  }
})

test('Codex defaults label results and roster payloads but do not add -m on spawn, promote or resume', async () => {
  const { fake, deps, repo, identity } = await setup()
  await writeFile(join(deps.codexUserHome as string, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n')
  const spawned = await commands.spawn(deps, identity, { seat: 'w-codex', kind: 'codex', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /codex gpt-6\.1-sol/)
  assert.equal(spawned.ok && (spawned.data as { model: string }).model, 'gpt-6.1-sol')
  const saved = await loadRoster(deps.home, RUN)
  assert.equal(saved.seats[0]?.model, '')
  assert.match(rosterLines(saved, deps.clock.now(), agents).join('\n'), /codex gpt-6\.1-sol/)
  const shown = await commands.roster(deps, { run: RUN, repo }, true)
  assert.equal(shown.ok && JSON.parse(shown.text).seats[0].model, 'gpt-6.1-sol')
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'idle', owes: 'none', lastReport: { id: 'r-1', kind: 'done', expects: 'none', summary: 'done', at: deps.clock.now().toISOString() } })) }))
  fake.setStatus('w-codex', 'idle')
  const promoted = await commands.promote(deps, identity, { seat: 'w-codex', model: '', effort: 'high' })
  assert.equal(promoted.ok, true, promoted.text)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.model, '')
  fake.agents.clear()
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'down' })) }))
  const resumed = await commands.up(deps, { run: RUN, repo }, 'w-codex')
  assert.equal(resumed.ok, true, resumed.text)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.model, '')
  assert.equal(starts(fake).length, 3)
  for (const call of starts(fake)) assert.ok(!call.includes('-m'), call.join(' '))
})

test('workerModel.codex overrides the host default and reaches the launch via -m', async () => {
  const { fake, deps, identity } = await setup()
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerModel: { codex: 'override' } }))
  const spawned = await commands.spawn(deps, identity, { seat: 'w-codex', kind: 'codex', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /codex override/)
  const call = starts(fake)[0] ?? []
  assert.equal(call[call.indexOf('-m') + 1], 'override')
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.model, 'override')
})

test('plan, attach, re-attach and resume refresh the agents on the run', async () => {
  const { fake, deps, repo, run } = await setup()
  await writeFile(join(deps.codexUserHome as string, 'config.toml'), 'model = "host-default"\n')
  const expected = { ...agents, at: deps.clock.now().toISOString(), codex: { version: '0.162.0', model: 'host-default' } }
  const planned = await commands.plan(deps, { repo, kind: 'codex', run: RUN })
  assert.equal(planned.ok, true, planned.text)
  assert.deepEqual((await loadRun(deps.home, RUN))?.agents, expected)
  const attached = await attach(deps, { repo, sessionId: 'planner', paneId: 'w1:p0', run: RUN })
  assert.equal(attached.ok, true, attached.text)
  assert.deepEqual((await loadRun(deps.home, RUN))?.agents, expected)
  const noCodex: Deps = { ...deps, exec: (argv, options) => argv[0] === 'codex' && argv[1] === '--version' ? Promise.resolve({ code: 127, stdout: '', stderr: '' }) : fake.exec(argv, options) }
  const reattached = await attach(noCodex, { repo, sessionId: 'planner', paneId: 'w1:p0', run: RUN })
  assert.equal(reattached.ok, true, reattached.text)
  assert.equal((await loadRun(deps.home, RUN))?.agents?.codex, undefined)
  await saveRun(deps.home, { ...run, status: 'down', agents: expected })
  const resumed = await commands.up(noCodex, { run: RUN, repo })
  assert.equal(resumed.ok, true, resumed.text)
  assert.deepEqual((await loadRun(deps.home, RUN))?.agents, { at: deps.clock.now().toISOString(), claude: agents.claude })
})
