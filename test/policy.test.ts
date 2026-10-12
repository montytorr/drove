import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyPolicy, mergePolicies, validatePolicy, loadPolicy, policyText, policyChange } from '../src/policy.ts'
import { DEFAULT_CONFIG, spawn, promote, migrate, setOwns, up, timing, readSpawnPolicy, nodeExec } from '../src/commands.ts'
import { plannerRole } from '../src/prompts.ts'
import { runDoctor, type DoctorDeps } from '../src/doctor.ts'
import { loadRoster, updateRoster } from '../src/roster.ts'
import { FakeHerdr, makeDeps, makeRepo, seedRun, RUN, git, makeSeat } from './p3-helpers.ts'
import type { SpawnPolicy, Identity } from '../src/types.ts'

const refused = (result: ReturnType<typeof applyPolicy>, pattern: RegExp) => {
  assert.ok('error' in result)
  assert.equal(result.error.ok, false)
  assert.equal(result.error.code, 'policy')
  assert.match(result.error.text, pattern)
}

test('optional choice, fixed lists, required bounds and numeric caps', () => {
  const policy: SpawnPolicy = { model: { choice: ['sonnet'] }, mcp: { fixed: [] }, bound: { required: true }, maxCost: { max: 5 } }
  refused(applyPolicy(policy, { model: 'opus', maxMinutes: 1 }), /model.*choice/)
  assert.deepEqual(applyPolicy(policy, { model: 'sonnet', maxMinutes: 1 }), { request: { model: 'sonnet', mcp: [], maxMinutes: 1 } })
  assert.deepEqual(applyPolicy(policy, { maxMinutes: 1 }), { request: { mcp: [], maxMinutes: 1 } })
  refused(applyPolicy(policy, { mcp: ['x'], maxMinutes: 1 }), /mcp.*fixed/)
  refused(applyPolicy(policy, {}), /bound.*required/)
  refused(applyPolicy(policy, { maxCost: 10 }), /maxCost.*max is 5/)
  assert.ok('request' in applyPolicy(policy, { model: '', maxMinutes: 1 }))
  refused(applyPolicy({ model: { required: true } }, { model: '' }), /model.*required/)
})

test('both config sources retain intersections, fixed, smaller max and required', async () => {
  const user = { model: { choice: ['sonnet', 'opus'], required: true }, maxCost: { max: 5 }, mcp: { fixed: [] }, owns: { required: true } }
  const repo = { model: { choice: ['sonnet'] }, maxCost: { max: 10 }, mcp: { choice: ['x'] }, owns: { choice: ['src/**'] } }
  const expected = { model: { choice: ['sonnet'], required: true }, maxCost: { max: 5 }, mcp: { fixed: [], choice: ['x'] }, owns: { required: true, choice: ['src/**'] } }
  assert.deepEqual(mergePolicies(user, repo), { policy: expected, errors: [] })
  assert.deepEqual(mergePolicies(repo, user), { policy: expected, errors: [] })
  assert.match(mergePolicies({ model: { fixed: 'opus' } }, { model: { fixed: 'sonnet' } }).errors.join(), /conflicts/)
  assert.match(mergePolicies({ model: { fixed: 'opus' } }, { model: { choice: ['sonnet'] } }).errors.join(), /outside choice/)
  assert.match(mergePolicies({ maxCost: { fixed: 10 } }, { maxCost: { max: 5 } }).errors.join(), /exceeds max/)
  const home = await makeRepo(); const repoPath = await makeRepo()
  await writeFile(join(home, 'config.json'), JSON.stringify({ spawnPolicy: user }))
  await writeFile(join(repoPath, '.drove.json'), JSON.stringify({ spawnPolicy: repo }))
  assert.deepEqual(await loadPolicy(home, repoPath), { policy: expected, errors: [] })
})

test('committed autoChecks without spawnPolicy imposes no policy and is safe to merge', async () => {
  const home = await makeRepo(); const repo = await makeRepo()
  await writeFile(join(repo, '.drove.json'), JSON.stringify({ autoChecks: ['npm run typecheck'] }))
  await git(repo, 'add', '.drove.json'); await git(repo, 'commit', '-qm', 'fast automatic checks')
  const base = await git(repo, 'rev-parse', 'HEAD')
  assert.deepEqual(await loadPolicy(home, repo, { exec: nodeExec, base }), { policy: {}, errors: [] })
  await writeFile(join(repo, '.drove.json'), JSON.stringify({ autoChecks: ['npm run typecheck', 'npm test'] }))
  await git(repo, 'add', '.drove.json'); await git(repo, 'commit', '-qm', 'update automatic checks')
  assert.equal(await policyChange(nodeExec, repo, base, 'HEAD'), undefined)
})

test('malformed policies identify unknown keys, types, inconsistent fixed and nonnumeric max', () => {
  for (const [policy, pattern] of [
    [{ unknown: { required: true } }, /unknown key/],
    [{ mcp: { fixed: 'x' } }, /wrong type/],
    [{ model: { fixed: 'opus', choice: ['sonnet'] } }, /outside choice/],
    [{ model: { max: 5 } }, /numeric setting/],
    [{ model: { choice: 'sonnet' } }, /list/],
    [{ bound: { required: false } }, /must be true/],
  ] as const) assert.match(validatePolicy(policy).join(), pattern)
})

const setup = async (policy: SpawnPolicy) => {
  Object.assign(timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  const fake = new FakeHerdr(); const deps = await makeDeps(fake); const repo = await makeRepo()
  const run = await seedRun(deps, repo, [], { planner: { kind: 'claude', paneId: 'w1:p0', model: 'opus', effort: 'high', viaMod: true } })
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ workerMcp: ['default-server'], spawnPolicy: policy }))
  const identity: Identity = { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }
  return { deps, repo, fake, run, identity }
}

test('spawn enforces policies before launch and applies fixed [] despite run trim defaults', async () => {
  const { deps, identity, fake } = await setup({ model: { choice: ['sonnet'] }, mcp: { fixed: [] }, bound: { required: true }, maxCost: { max: 5 } })
  const request = { seat: 'w-policy-test', kind: 'claude' as const, brief: 'Test policy.', maxMinutes: 1 }
  for (const extra of [{ model: 'opus' }, { mcp: ['x'] }, { maxCost: 10 }, { maxMinutes: undefined }]) {
    const result = await spawn(deps, identity, { ...request, ...extra })
    assert.equal(result.ok, false); assert.equal(result.code, 'policy'); assert.match(result.text, /spawnPolicy/)
  }
  assert.equal(fake.calls.filter(call => call[0] === 'herdr').length, 0)
  const result = await spawn(deps, identity, { ...request, model: 'sonnet' })
  assert.equal(result.ok, true, result.text)
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats[0]?.mcp, [])
  const spec = await readFile(join(deps.home, 'runs', RUN, 'seats', request.seat, 'launch.json'), 'utf8')
  assert.ok(!spec.includes('default-server'))
  assert.equal((await spawn(deps, identity, { ...request, seat: 'w-no-model' })).ok, true)
})

test('promote/demote, migrate and owns refuse attempts to widen policy', async () => {
  const { deps, identity } = await setup({ model: { choice: ['sonnet'] }, kind: { fixed: 'claude' }, effort: { choice: ['medium'] }, owns: { fixed: ['src/**'] } })
  assert.equal((await spawn(deps, identity, { seat: 'w-seat', kind: 'claude', brief: 'Test.' })).ok, true)
  for (const result of [
    await promote(deps, identity, { seat: 'w-seat', model: 'opus', effort: 'medium' }),
    await promote(deps, identity, { seat: 'w-seat', model: 'sonnet', effort: 'high' }),
    await migrate(deps, identity, { seat: 'w-seat', kind: 'codex' }),
    await setOwns(deps, identity, { seat: 'w-seat', add: ['test/**'] }),
    await setOwns(deps, identity, { seat: 'w-seat', set: ['test/**'] }),
  ]) { assert.equal(result.ok, false); assert.equal(result.code, 'policy') }
  const omitted = await promote(deps, identity, { seat: 'w-seat', model: '', effort: 'medium' })
  assert.equal(omitted.ok, true, omitted.text)
})

test('planner role shows policy and doctor rejects malformed repo policy', async () => {
  const { run } = await setup({ model: { choice: ['sonnet'] } })
  assert.match(plannerRole(run, { ...DEFAULT_CONFIG, spawnPolicy: { model: { choice: ['sonnet'] } } }, 'codex'), /Spawn policy.*\n.*sonnet/)
  const mod = await readFile(new URL('../mod/hooks/prompts.ts', import.meta.url), 'utf8')
  assert.match(mod, /spawnPolicyText/)
  const deps: DoctorDeps = { exec: async () => ({ code: 127, stdout: '', stderr: '' }), cwd: '/repo', home: '/home', claudeSettings: '/none', nodeVersion: '22.18.0', isWritable: async () => true, readText: async path => path === '/repo/.drove.json' ? JSON.stringify({ spawnPolicy: { model: { max: 5 } } }) : undefined }
  const check = (await runDoctor(deps)).checks.find(item => item.id === 'spawn-policy')
  assert.equal(check?.status, 'fail'); assert.match(check!.detail, /numeric setting/)
})

test('choices and maxima constrain defaults, while fixed values replace defaults', () => {
  refused(applyPolicy({ model: { choice: ['opus'] } }, {}, undefined, { defaults: { model: 'sonnet' } }), /model.*choice/)
  refused(applyPolicy({ maxTurns: { max: 50 } }, {}, undefined, { defaults: { maxTurns: 200 } }), /maxTurns.*50/)
  assert.deepEqual(applyPolicy({ model: { fixed: 'opus' } }, {}, undefined, { defaults: { model: 'sonnet' } }), { request: { model: 'opus' } })
  assert.match(validatePolicy({ model: { choice: [] } }).join(), /non-empty/)
  assert.match(mergePolicies({ model: { choice: ['opus'] } }, { model: { choice: ['sonnet'] } }).errors.join(), /non-empty/)
  assert.match(policyText({}, ['spawnPolicy.model.choice must be non-empty']), /Spawn policy errors.*\n.*non-empty/)
})

test('list choices allow each entry and owns add keeps an allowed subset', async () => {
  const policy: SpawnPolicy = { mcp: { choice: ['x', 'y'] } }
  assert.ok('request' in applyPolicy(policy, { mcp: ['x'] }))
  assert.ok('request' in applyPolicy(policy, { mcp: ['x', 'y'] }))
  refused(applyPolicy(policy, { mcp: ['z'] }), /mcp.*choice/)
  const { deps, identity } = await setup({ owns: { choice: ['src/**', 'test/**'] } })
  assert.equal((await spawn(deps, identity, { seat: 'w-owns', kind: 'claude', brief: 'Test', owns: ['src/**'] })).ok, true)
  const changed = await setOwns(deps, identity, { seat: 'w-owns', add: ['test/**'] })
  assert.equal(changed.ok, true, changed.text)
  const denied = await setOwns(deps, identity, { seat: 'w-owns', add: ['other/**'] })
  assert.equal(denied.ok, false); assert.equal(!denied.ok && denied.code, 'policy')
})

test('Claude aliases compare both ways and Codex model names stay literal', async () => {
  for (const [allowed, given] of [['sonnet', 'claude-sonnet-5-5'], ['claude-sonnet-5-5', 'sonnet']]) {
    const { deps, identity } = await setup({ model: { choice: [allowed!] } })
    const result = await spawn(deps, identity, { seat: 'w-alias', kind: 'claude', brief: 'Test', model: given })
    assert.equal(result.ok, true, result.text)
  }
  const { deps, repo, identity } = await setup({ model: { choice: ['sonnet'] } })
  await writeFile(join(repo, '.drove.json'), JSON.stringify({ spawnPolicy: { model: { choice: ['claude-sonnet-5-5'] } } }))
  await git(repo, 'add', '.drove.json'); await git(repo, 'commit', '-qm', 'policy')
  assert.equal((await spawn(deps, identity, { seat: 'w-merged', kind: 'claude', brief: 'Test' })).ok, true)
  const denied = await spawn(deps, identity, { seat: 'w-literal', kind: 'codex', brief: 'Test', model: 'claude-sonnet-5-5' })
  assert.equal(denied.ok, false); assert.equal(!denied.ok && denied.code, 'policy')
})

test('spawn and promote reject disallowed effective defaults, fixed replaces them', async () => {
  for (const policy of [{ model: { choice: ['opus'] } }, { maxTurns: { max: 50 } }] satisfies SpawnPolicy[]) {
    const { deps, identity } = await setup(policy)
    await writeFile(join(deps.home, 'config.json'), JSON.stringify({ maxTurns: 200, spawnPolicy: policy }))
    const result = await spawn(deps, identity, { seat: 'w-default', kind: 'claude', brief: 'Test' })
    assert.equal(result.ok, false); assert.equal(!result.ok && result.code, 'policy')
  }
  const { deps, identity } = await setup({ model: { fixed: 'opus' }, effort: { fixed: 'high' }, maxTurns: { fixed: 50 } })
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ maxTurns: 200, spawnPolicy: { model: { fixed: 'opus' }, effort: { fixed: 'high' }, maxTurns: { fixed: 50 } } }))
  const result = await spawn(deps, identity, { seat: 'w-fixed', kind: 'claude', brief: 'Test' })
  assert.equal(result.ok, true, result.text)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]!
  assert.equal(seat.model, DEFAULT_CONFIG.promotedModel.claude); assert.equal(seat.effort, 'high'); assert.equal(seat.maxTurns, 50)
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ spawnPolicy: { model: { choice: ['opus'] } } }))
  const promotion = await promote(deps, identity, { seat: seat.name, model: '', effort: 'medium' })
  assert.equal(promotion.ok, false); assert.equal(!promotion.ok && promotion.code, 'policy')
})

test('repo policy uses committed run base and planner sees policy errors', async () => {
  const { deps, repo, identity } = await setup({})
  await writeFile(join(repo, '.drove.json'), JSON.stringify({ spawnPolicy: { model: { choice: ['sonnet'] } } }))
  await git(repo, 'add', '.drove.json'); await git(repo, 'commit', '-qm', 'restrict policy')
  await writeFile(join(repo, '.drove.json'), JSON.stringify({ spawnPolicy: { model: { choice: ['opus'] } } }))
  const denied = await spawn(deps, identity, { seat: 'w-base', kind: 'claude', brief: 'Test', model: 'opus' })
  assert.equal(denied.ok, false); assert.equal(!denied.ok && denied.code, 'policy')
  const shown = await readSpawnPolicy(deps, { run: RUN, repo })
  assert.equal(shown.ok, true); assert.match(shown.text, /sonnet/); assert.doesNotMatch(shown.text, /choice.*opus/)
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ spawnPolicy: { model: { choice: [] } } }))
  const errors = await readSpawnPolicy(deps, { run: RUN, repo })
  assert.equal(errors.ok, true); assert.match(errors.text, /Spawn policy errors.*\n.*non-empty/)
})

test('up refuses stored seats that no longer meet policy before restarting', async () => {
  const { deps, repo, identity, fake } = await setup({})
  assert.equal((await spawn(deps, identity, { seat: 'w-restart', kind: 'claude', brief: 'Test' })).ok, true)
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'down' as const })) }))
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ spawnPolicy: { model: { choice: ['opus'] } } }))
  const starts = fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').length
  const result = await up(deps, { run: RUN, repo }, 'w-restart')
  assert.equal(result.ok, false); assert.equal(!result.ok && result.code, 'policy'); assert.match(result.text, /cannot relaunch w-restart/)
  assert.equal(fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').length, starts)
})

test('migrate checks destination defaults and inherited effort before restarting', async () => {
  const { deps, identity } = await setup({})
  assert.equal((await spawn(deps, identity, { seat: 'w-move', kind: 'codex', brief: 'Test', effort: 'high' })).ok, true)
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ spawnPolicy: { model: { choice: ['opus'] } } }))
  const model = await migrate(deps, identity, { seat: 'w-move', kind: 'claude' })
  assert.equal(model.ok, false); assert.equal(!model.ok && model.code, 'policy'); assert.match(model.text, /model.*choice/)
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ spawnPolicy: { effort: { choice: ['medium'] } } }))
  const effort = await migrate(deps, identity, { seat: 'w-move', kind: 'claude' })
  assert.equal(effort.ok, false); assert.equal(!effort.ok && effort.code, 'policy'); assert.match(effort.text, /effort.*choice/)
})

test('a policy on owns cannot be bypassed by omitted or empty owns', async () => {
  const { deps, identity } = await setup({ owns: { choice: ['src/**'] } })
  for (const owns of [undefined, []]) {
    const result = await spawn(deps, identity, { seat: 'w-unbounded', kind: 'claude', brief: 'Test', owns })
    assert.equal(result.ok, false); assert.equal(!result.ok && result.code, 'policy')
  }
})


test('policy JSON transport returns the same rendered policy used by planner roles', async () => {
  const { deps, repo } = await setup({ model: { choice: ['sonnet'] } })
  const shown = await readSpawnPolicy(deps, { run: RUN, repo })
  const result = await nodeExec([process.execPath, new URL('../src/cli.ts', import.meta.url).pathname, 'policy', '--run', RUN, '--json'], { cwd: repo, env: { DROVE_HOME: deps.home } })
  assert.equal(result.code, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.text, shown.text)
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.policy, { model: { choice: ['sonnet'] } })
})


test('planner policy errors keep Codex model names literal even when an alias matches Claude', async () => {
  const { deps, repo } = await setup({ kind: { fixed: 'codex' }, model: { fixed: 'sonnet', choice: ['claude-sonnet-5-5'] } })
  const shown = await readSpawnPolicy(deps, { run: RUN, repo })
  assert.equal(shown.ok, true)
  assert.match(shown.text, /Spawn policy errors.*\n.*fixed is outside choice/)
})


test('Codex policy comparison stays literal while launch aliases still resolve', async () => {
  const { deps, identity } = await setup({ model: { choice: ['sonnet'] } })
  const spawned = await spawn(deps, identity, { seat: 'w-codex-literal', kind: 'codex', model: 'sonnet', brief: 'Test' })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.model, DEFAULT_CONFIG.workerModel.codex)
  const denied = await spawn(deps, identity, { seat: 'w-codex-full', kind: 'codex', model: DEFAULT_CONFIG.workerModel.codex, brief: 'Test' })
  assert.equal(denied.ok, false); assert.equal(!denied.ok && denied.code, 'policy')
})

test('owns policies allow reviewer spawn and relaunch without owned globs', async () => {
  const { deps, repo, identity } = await setup({ owns: { choice: ['src/**'] } })
  assert.equal((await spawn(deps, identity, { seat: 'w-target', kind: 'claude', brief: 'Test', owns: ['src/**'] })).ok, true)
  const spawned = await spawn(deps, identity, { seat: 'w-review', kind: 'claude', brief: 'Review', role: 'reviewer', target: 'w-target' })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal((await loadRoster(deps.home, RUN)).seats.find(seat => seat.name === 'w-review')?.owns, undefined)
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => seat.name === 'w-review' ? { ...seat, state: 'down' as const } : seat) }))
  const relaunched = await up(deps, { run: RUN, repo }, 'w-review')
  assert.equal(relaunched.ok, true, relaunched.text)
  assert.equal((await loadRoster(deps.home, RUN)).seats.find(seat => seat.name === 'w-review')?.owns, undefined)
  assert.deepEqual(applyPolicy({ role: { fixed: 'reviewer' }, owns: { fixed: ['src/**'], required: true } }, {}), { request: { role: 'reviewer' } })
})


test('enabled memory and hooks defaults are checked and fixed Codex trims shape its shared home', async () => {
  for (const key of ['userMemory', 'userHooks'] as const) {
    const { deps, identity } = await setup({ [key]: { choice: [false] } })
    const denied = await spawn(deps, identity, { seat: 'w-enabled', kind: 'claude', brief: 'Test' })
    assert.equal(denied.ok, false); assert.equal(!denied.ok && denied.code, 'policy')
  }
  const { deps, identity } = await setup({ userMemory: { fixed: false }, userHooks: { fixed: false }, skills: { fixed: [] } })
  const user = join(deps.home, 'user-codex')
  deps.codexUserHome = user
  await mkdir(join(user, 'skills', 'cairn'), { recursive: true })
  await writeFile(join(user, 'AGENTS.md'), 'User memory marker')
  await writeFile(join(user, 'skills', 'cairn', 'SKILL.md'), 'Skill marker')
  await writeFile(join(user, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook-marker' }] }] } }))
  const spawned = await spawn(deps, identity, { seat: 'w-codex-trims', kind: 'codex', brief: 'Test' })
  assert.equal(spawned.ok, true, spawned.text)
  const home = (await loadRoster(deps.home, RUN)).seats[0]!.codexHome!
  assert.equal(existsSync(join(home, 'AGENTS.md')), false)
  assert.equal(existsSync(join(home, 'skills', 'cairn')), false)
  assert.doesNotMatch(await readFile(join(home, 'hooks.json'), 'utf8'), /user-hook-marker/)
})
