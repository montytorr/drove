import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as cli from '../src/cli.ts'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import * as guard from '../src/guard.ts'
import * as hooks from '../src/hooks.ts'
import { codexHomeDir, identityEnv, identityFromEnv, seatDir } from '../src/paths.ts'
import * as prompts from '../src/prompts.ts'
import { loadRoster, rosterLines, updateRoster } from '../src/roster.ts'
import * as tools from '../src/tools.ts'
import type { Deps, DroveConfig, GuardInput, Identity, RunMeta, SeatRole } from '../src/types.ts'
import { FakeHerdr, git, makeDeps, makeRepo, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_OWNS', 'DROVE_SEAT_ROLE', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const planner = (deps: Deps): Identity => ({ home: deps.home, run: RUN, role: 'planner', seat: 'planner' })

const setup = async (fake = new FakeHerdr()) => {
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo, [])
  return { fake, repo, deps, identity: planner(deps) }
}

const brief = 'Build the widget.'

// The env of the pane Drove placed last (a tab create or a pane split carries one --env per variable).
const placedEnv = (fake: FakeHerdr): Record<string, string> => {
  const call = fake.calls.filter(item => (item[1] === 'tab' && item[2] === 'create') || (item[1] === 'pane' && item[2] === 'split')).at(-1) ?? []
  return Object.fromEntries(call.flatMap((arg, i) => (arg === '--env' && call[i + 1] ? [[call[i + 1]?.split('=')[0] ?? '', call[i + 1]?.slice((call[i + 1]?.indexOf('=') ?? 0) + 1) ?? '']] : [])))
}

const seatOf = async (deps: Deps, name: string) => (await loadRoster(deps.home, RUN)).seats.find(seat => seat.name === name)
const roleFile = (deps: Deps, name: string): Promise<string> => readFile(join(seatDir(deps.home, RUN, name), 'role.md'), 'utf8')
const briefOf = (fake: FakeHerdr): string => (fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start').at(-1) ?? []).at(-1) ?? ''

const spawnTarget = async (ctx: Awaited<ReturnType<typeof setup>>, name = 'w-api') => {
  const spawned = await commands.spawn(ctx.deps, ctx.identity, { seat: name, kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  return (await seatOf(ctx.deps, name))?.worktree ?? ''
}

const TEST_GLOBS = ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**']

test('an implementer is the default: no role is stored and the worker env carries no seat role', async () => {
  const ctx = await setup()
  assert.equal((await commands.spawn(ctx.deps, ctx.identity, { seat: 'w-api', kind: 'claude', brief })).ok, true)
  assert.equal((await commands.spawn(ctx.deps, ctx.identity, { seat: 'w-ui', kind: 'claude', brief, role: 'implementer' })).ok, true)
  assert.equal('DROVE_SEAT_ROLE' in placedEnv(ctx.fake), false)
  for (const name of ['w-api', 'w-ui']) {
    const seat = await seatOf(ctx.deps, name)
    assert.deepEqual([seat?.role, seat?.target], [undefined, undefined])
    assert.match(await roleFile(ctx.deps, name), /^# Worker mode\n/)
  }
})

test('the implementer role text is byte-identical to the text before roles', () => {
  const run = { id: 'drove-20261009-1042-a3f1' } as RunMeta
  const config = { humanName: 'Sam' } as DroveConfig
  const before = readFileSync(new URL('./fixtures/worker-role.implementer.txt', import.meta.url), 'utf8')
  assert.equal(prompts.workerRole(run, config), before)
  assert.equal(prompts.workerRole(run, config, 'implementer'), before)
  const footer = prompts.briefFooter('w-api', 'DROVE-5', { branch: 'worktree-w-api', verify: ['npm test'] })
  assert.equal(footer, '\n\n(You are worker `w-api` on branch `worktree-w-api`. Your Cairn task is DROVE-5: claim it first. Verify with `npm test`. Report with the drove report tool when done, blocked, or when you need a decision.)')
})

test('each role has one text, the same for every seat of the run', async () => {
  const ctx = await setup()
  const first = await commands.spawn(ctx.deps, ctx.identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(first.ok, true, first.text)
  for (const name of ['r-one', 'r-two']) assert.equal((await commands.spawn(ctx.deps, ctx.identity, { seat: name, kind: 'claude', brief, role: 'reviewer', target: 'w-api' })).ok, true)
  for (const name of ['t-one', 't-two']) assert.equal((await commands.spawn(ctx.deps, ctx.identity, { seat: name, kind: 'claude', brief, role: 'tester', target: 'w-api' })).ok, true)
  assert.equal(await roleFile(ctx.deps, 'r-one'), await roleFile(ctx.deps, 'r-two'))
  assert.equal(await roleFile(ctx.deps, 't-one'), await roleFile(ctx.deps, 't-two'))
  assert.match(await roleFile(ctx.deps, 'r-one'), /^# Reviewer mode\n/)
  assert.match(await roleFile(ctx.deps, 't-one'), /^# Tester mode\n/)
  assert.notEqual(await roleFile(ctx.deps, 'r-one'), await roleFile(ctx.deps, 'w-api'))
  for (const name of ['r-one', 'r-two', 't-one', 't-two']) assert.doesNotMatch(await roleFile(ctx.deps, name), /w-api|r-one|t-one/, 'the seat and the target go in the brief footer, not the role')
})

test('spawn --role reviewer stores the role and target, tells the guard, and names the target in the brief', async () => {
  const ctx = await setup()
  const targetTree = await spawnTarget(ctx)
  const spawned = await commands.spawn(ctx.deps, ctx.identity, { seat: 'r-api', kind: 'claude', brief: 'Review w-api for security.', role: 'reviewer', target: 'w-api' })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /^Reviewer r-api \(claude [^)]*, reviewing w-api\)/)
  const seat = await seatOf(ctx.deps, 'r-api')
  assert.deepEqual([seat?.role, seat?.target, seat?.owns], ['reviewer', 'w-api', undefined])
  assert.equal(placedEnv(ctx.fake).DROVE_SEAT_ROLE, 'reviewer')
  const text = briefOf(ctx.fake)
  assert.match(text, /^Review w-api for security\. \(You are reviewer `r-api` on branch `worktree-r-api`\./)
  assert.ok(text.includes(`You review seat \`w-api\` (branch \`worktree-w-api\`, worktree \`${targetTree}\`)`))
  assert.ok(text.includes(`Its brief is in \`${join(seatDir(ctx.deps.home, RUN, 'w-api'), 'brief.md')}\``))
  assert.match(text, /git -C \S+ diff main`/)
  assert.ok(text.includes(`git diff main...worktree-w-api`))
})

test("a reviewer's own worktree starts at the run base and it holds no commit of the target's", async () => {
  const ctx = await setup()
  const targetTree = await spawnTarget(ctx)
  await writeFile(join(targetTree, 'widget.ts'), 'export const widget = 1\n')
  await git(targetTree, 'add', 'widget.ts')
  await git(targetTree, 'commit', '-q', '-m', 'widget')
  const spawned = await commands.spawn(ctx.deps, ctx.identity, { seat: 'r-api', kind: 'claude', brief, role: 'reviewer', target: 'w-api' })
  assert.equal(spawned.ok, true, spawned.text)
  const reviewerTree = (await seatOf(ctx.deps, 'r-api'))?.worktree ?? ''
  assert.equal(await git(reviewerTree, 'rev-parse', 'HEAD'), await git(ctx.repo, 'rev-parse', 'main'))
})

test('a reviewer or tester needs a target seat that exists; an implementer takes none; a reviewer takes no owns', async () => {
  const ctx = await setup()
  await spawnTarget(ctx)
  const refused = async (request: Partial<Parameters<typeof commands.spawn>[2]>) => commands.spawn(ctx.deps, ctx.identity, { seat: 'w-x', kind: 'claude', brief, ...request })
  const cases: [Partial<Parameters<typeof commands.spawn>[2]>, RegExp][] = [
    [{ role: 'reviewer' }, /a reviewer needs --target <seat>/],
    [{ role: 'tester' }, /a tester needs --target <seat>/],
    [{ role: 'tester', target: 'w-nobody' }, /no seat of run .* has that name/],
    [{ role: 'reviewer', target: 'w-x' }, /another seat of this run/],
    [{ role: 'reviewer', target: 'planner' }, /another seat of this run/],
    [{ target: 'w-api' }, /--target applies to a reviewer or tester/],
    [{ role: 'reviewer', target: 'w-api', owns: ['src/**'] }, /read-only, so --owns does not apply/],
    [{ role: 'lead' as SeatRole, target: 'w-api' }, /--role must be one of implementer, reviewer, tester/],
  ]
  for (const [request, message] of cases) {
    const result = await refused(request)
    assert.equal(result.ok, false, JSON.stringify(request))
    assert.match(result.text, message)
  }
  assert.deepEqual((await loadRoster(ctx.deps.home, RUN)).seats.map(seat => seat.name), ['w-api'])
})

test('a reviewer cannot be the target of another seat', async () => {
  const ctx = await setup()
  await spawnTarget(ctx)
  assert.equal((await commands.spawn(ctx.deps, ctx.identity, { seat: 'r-api', kind: 'claude', brief, role: 'reviewer', target: 'w-api' })).ok, true)
  const second = await commands.spawn(ctx.deps, ctx.identity, { seat: 't-api', kind: 'claude', brief, role: 'tester', target: 'r-api' })
  assert.equal(second.ok, false)
  assert.match(second.text, /is a reviewer, which changes nothing/)
})

test('a tester owns the usual test globs by default, and the planner can override them', async () => {
  const ctx = await setup()
  await spawnTarget(ctx)
  assert.equal((await commands.spawn(ctx.deps, ctx.identity, { seat: 't-api', kind: 'claude', brief, role: 'tester', target: 'w-api' })).ok, true)
  assert.deepEqual((await seatOf(ctx.deps, 't-api'))?.owns, TEST_GLOBS)
  assert.deepEqual(JSON.parse(placedEnv(ctx.fake).DROVE_OWNS ?? 'null'), TEST_GLOBS)
  assert.equal(placedEnv(ctx.fake).DROVE_SEAT_ROLE, 'tester')
  assert.equal((await commands.spawn(ctx.deps, ctx.identity, { seat: 't-ui', kind: 'claude', brief, role: 'tester', target: 'w-api', owns: ['spec/**'] })).ok, true)
  assert.deepEqual((await seatOf(ctx.deps, 't-ui'))?.owns, ['spec/**'])
  assert.equal((await commands.spawn(ctx.deps, ctx.identity, { seat: 't-empty', kind: 'claude', brief, role: 'tester', target: 'w-api', owns: [] })).ok, true)
  assert.deepEqual((await seatOf(ctx.deps, 't-empty'))?.owns, TEST_GLOBS, 'an empty list is no override')
})

test("a Claude tester's branch starts at the head of the target's branch, and the brief says so", async () => {
  const ctx = await setup()
  const targetTree = await spawnTarget(ctx)
  await writeFile(join(targetTree, 'widget.ts'), 'export const widget = 1\n')
  await git(targetTree, 'add', 'widget.ts')
  await git(targetTree, 'commit', '-q', '-m', 'widget')
  const spawned = await commands.spawn(ctx.deps, ctx.identity, { seat: 't-api', kind: 'claude', brief: 'Test the widget.', role: 'tester', target: 'w-api' })
  assert.equal(spawned.ok, true, spawned.text)
  const testerTree = (await seatOf(ctx.deps, 't-api'))?.worktree ?? ''
  assert.equal(await git(testerTree, 'rev-parse', 'HEAD'), await git(targetTree, 'rev-parse', 'HEAD'))
  assert.notEqual(await git(testerTree, 'rev-parse', 'HEAD'), await git(ctx.repo, 'rev-parse', 'main'))
  assert.match(briefOf(ctx.fake), /^Test the widget\. \(You are tester `t-api` on branch `worktree-t-api`\. You test seat `w-api`, whose branch `worktree-w-api` your branch started from\./)
})

test("a Codex tester's worktree is created from the target's branch", async () => {
  const ctx = await setup()
  const targetTree = await spawnTarget(ctx)
  await writeFile(join(targetTree, 'widget.ts'), 'export const widget = 1\n')
  await git(targetTree, 'add', 'widget.ts')
  await git(targetTree, 'commit', '-q', '-m', 'widget')
  const spawned = await commands.spawn(ctx.deps, ctx.identity, { seat: 't-cx', kind: 'codex', brief, role: 'tester', target: 'w-api', base: 'main' })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /--base main was ignored/)
  const seat = await seatOf(ctx.deps, 't-cx')
  assert.equal(seat?.branch, 'drove/t-cx')
  assert.equal(await git(seat?.worktree ?? '', 'rev-parse', 'HEAD'), await git(targetTree, 'rev-parse', 'HEAD'))
  assert.match(await readFile(join(codexHomeDir(ctx.deps.home, RUN), 'config.toml'), 'utf8'), /developer_instructions = "# Tester mode/)
})

test('a tester warns when its target has not committed yet', async () => {
  const ctx = await setup()
  const targetTree = await spawnTarget(ctx)
  await writeFile(join(targetTree, 'wip.ts'), 'export const wip = 1\n')
  const spawned = await commands.spawn(ctx.deps, ctx.identity, { seat: 't-api', kind: 'claude', brief, role: 'tester', target: 'w-api' })
  assert.equal(spawned.ok, true, spawned.text)
  assert.match(spawned.text, /w-api has uncommitted changes in .*have w-api commit first/)
})

const markIdle = (deps: Deps, name: string, report: 'promote' | 'done' = 'promote') =>
  updateRoster(deps.home, RUN, roster => ({
    ...roster,
    seats: roster.seats.map(seat => (seat.name === name ? { ...seat, state: 'idle' as const, owes: 'answer' as const, lastReport: { id: 'r-1', kind: report, expects: 'answer' as const, summary: 'stuck', at: '2026-10-09T10:30:00.000Z' } } : seat)),
  }))

test('the role survives a promote: the relaunched reviewer gets the same role text and DROVE_SEAT_ROLE', async () => {
  const ctx = await setup()
  await spawnTarget(ctx)
  await commands.spawn(ctx.deps, ctx.identity, { seat: 'r-api', kind: 'claude', brief, role: 'reviewer', target: 'w-api' })
  await markIdle(ctx.deps, 'r-api')
  ctx.fake.setStatus('r-api', 'idle')
  const promoted = await commands.promote(ctx.deps, ctx.identity, { seat: 'r-api', model: 'opus', effort: 'high', reason: 'subtle' })
  assert.equal(promoted.ok, true, promoted.text)
  const seat = await seatOf(ctx.deps, 'r-api')
  assert.deepEqual([seat?.role, seat?.target], ['reviewer', 'w-api'])
  assert.equal(placedEnv(ctx.fake).DROVE_SEAT_ROLE, 'reviewer')
  assert.match(await roleFile(ctx.deps, 'r-api'), /^# Reviewer mode\n/)
})

test('the role survives up --seat: a relaunched tester keeps its text, role and default owns', async () => {
  const ctx = await setup()
  await spawnTarget(ctx)
  await commands.spawn(ctx.deps, ctx.identity, { seat: 't-api', kind: 'claude', brief, role: 'tester', target: 'w-api' })
  ctx.fake.agents.clear()
  await commands.roster(ctx.deps, { run: RUN, repo: '/x' }, false)
  const relaunched = await commands.up(ctx.deps, { run: RUN, repo: '/x' }, 't-api')
  assert.equal(relaunched.ok, true, relaunched.text)
  const env = placedEnv(ctx.fake)
  assert.equal(env.DROVE_SEAT_ROLE, 'tester')
  assert.deepEqual(JSON.parse(env.DROVE_OWNS ?? 'null'), TEST_GLOBS)
  assert.match(await roleFile(ctx.deps, 't-api'), /^# Tester mode\n/)
})

test('the role survives a migrate to the other provider', async () => {
  const ctx = await setup()
  await spawnTarget(ctx)
  await commands.spawn(ctx.deps, ctx.identity, { seat: 'r-api', kind: 'claude', brief, role: 'reviewer', target: 'w-api' })
  const migrated = await commands.migrate(ctx.deps, ctx.identity, { seat: 'r-api', kind: 'codex', reason: 'Claude usage limit' })
  assert.equal(migrated.ok, true, migrated.text)
  const seat = await seatOf(ctx.deps, 'r-api')
  assert.deepEqual([seat?.kind, seat?.role, seat?.target], ['codex', 'reviewer', 'w-api'])
  assert.equal(placedEnv(ctx.fake).DROVE_SEAT_ROLE, 'reviewer')
  assert.match(await readFile(join(codexHomeDir(ctx.deps.home, RUN), 'config.toml'), 'utf8'), /developer_instructions = "# Reviewer mode/)
})

test('a reviewer or tester counts against the pane budget like any seat', async () => {
  const ctx = await setup()
  await seedRun(ctx.deps, ctx.repo, [], { budget: 2 })
  await spawnTarget(ctx)
  assert.equal((await commands.spawn(ctx.deps, ctx.identity, { seat: 'r-api', kind: 'claude', brief, role: 'reviewer', target: 'w-api' })).ok, true)
  const third = await commands.spawn(ctx.deps, ctx.identity, { seat: 't-api', kind: 'claude', brief, role: 'tester', target: 'w-api' })
  assert.equal(third.ok, false)
  assert.match(third.text, /pane budget of 2 is full/)
})

test('the roster line names the role and target', async () => {
  const ctx = await setup()
  await spawnTarget(ctx)
  await commands.spawn(ctx.deps, ctx.identity, { seat: 'r-api', kind: 'claude', brief, role: 'reviewer', target: 'w-api' })
  const lines = rosterLines(await loadRoster(ctx.deps.home, RUN), new Date('2026-10-09T10:45:00.000Z'))
  assert.match(lines.find(line => line.startsWith('- r-api')) ?? '', / · reviewer of w-api · pane /)
  assert.doesNotMatch(lines.find(line => line.startsWith('- w-api')) ?? '', /reviewer|tester/)
})

test('the default test globs own a nested __tests__ folder and the usual test files, and nothing else', () => {
  const owned = (path: string) => guard.isOwned(join('/work/repo', path), commands.TESTER_OWNS, '/work/repo')
  for (const path of ['test/a.ts', 'tests/unit/a.ts', 'src/a.test.ts', 'src/deep/a.spec.tsx', '__tests__/a.ts', 'src/feature/__tests__/a.ts']) assert.equal(owned(path), true, path)
  for (const path of ['src/a.ts', 'package.json', 'README.md', 'src/testing/a.ts']) assert.equal(owned(path), false, path)
})

// ---------- the reviewer guard ----------

const reviewerCall = (tool: string, input: Record<string, unknown>, extra: Partial<GuardInput> = {}) =>
  guard.decide({ agent: 'claude', role: 'worker', seatRole: 'reviewer', tool, input, cwd: '/work/repo', writableRoots: [], openSeats: [], ...extra })

const reviewer = (command: string) => reviewerCall('Bash', { command })

test('reviewer: Edit, Write and the other edit tools are denied outside scratch, with a reason that says why', () => {
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    const decision = reviewerCall(tool, { file_path: '/work/repo/src/a.ts' })
    assert.equal(decision.allow, false, tool)
    assert.match(!decision.allow ? decision.reason : '', /^Drove worker: .*a reviewer seat is read-only/)
  }
  assert.equal(reviewerCall('apply_patch', { patch: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' }).allow, false)
  assert.equal(reviewerCall('Write', {}).allow, false, 'no path to read')
  assert.equal(reviewerCall('Write', { file_path: '/tmp/notes.md' }).allow, true, 'scratch under /tmp is fine')
  assert.equal(reviewerCall('Write', { file_path: '/tmp/../work/repo/a.ts' }).allow, false)
})

test('reviewer: file-changing and package commands are denied, rm and git commit included', () => {
  for (const command of [
    'rm -rf src',
    'rm src/a.ts',
    'git commit -m x',
    'git add -A',
    'git checkout main',
    'git switch -c x',
    'git reset --hard HEAD~1',
    'git merge main',
    'git rebase main',
    'git stash',
    'git branch -D old',
    'git branch newbranch',
    'git tag v1',
    'git push origin HEAD',
    'git log --output=out.txt',
    'git remote add x y',
    'git config user.name x',
    'echo x > src/a.ts',
    'echo x >> README.md',
    'mv a b',
    'cp a.ts src/b.ts',
    'sed -i s/a/b/ src/a.ts',
    'npm install',
    'npm run build',
    'npm run lint:fix',
    'npm test -- -u',
    'npx eslint --fix src',
    'prettier --write src',
    'tsc',
    'node script.js',
    'python3 evil.py',
    './run.sh',
    'bash -c "rm -rf x"',
    'tee out.txt',
    'curl -o x https://example.com',
    'herdr pane split',
    'drove spawn x',
    'drove init /tmp/new-repo',
    'drove close w-api',
    'claude -p hi',
    'gh pr merge 1',
    'gh pr merge 1 --squash',
    'gh pr create --title x --body y',
    'gh pr comment 1 -b x',
    'gh pr review 1 --approve',
    'gh pr checkout 1',
    'gh issue comment 1 -b x',
    'gh issue create -t x',
    'gh issue close 1',
    'gh release create v1',
    'gh workflow run ci.yml',
    'gh run rerun 1',
    'gh run download 1',
    'gh repo clone a/b',
    'gh label create x',
    'gh api -X POST repos/a/b/issues',
    'gh api -XPOST repos/a/b/issues',
    'gh api --method=PATCH repos/a/b/issues/1',
    'gh api repos/a/b/issues -f title=x',
    'gh api repos/a/b/issues --field title=x',
    'gh api repos/a/b/issues --input body.json',
    'gh -R a/b pr merge 1',
  ]) {
    const reason = reviewer(command)
    assert.equal(reason.allow, false, command)
  }
})

test("reviewer: reads, git history and the repo's checks are allowed", () => {
  for (const command of [
    'git diff main',
    'git -C /work/repo/.claude/worktrees/w-api diff main',
    'git diff main...worktree-w-api --stat',
    'git status --short',
    'git log --oneline -5',
    'git show HEAD:src/a.ts',
    'git blame src/a.ts',
    'git grep -n widget',
    'git ls-files',
    'git rev-parse HEAD',
    'git branch',
    'git branch -a',
    'git branch --show-current',
    'git tag',
    'git tag -l',
    'git stash list',
    'git worktree list',
    'git remote -v',
    'git config --get user.name',
    'cat src/a.ts',
    'rg widget src | wc -l',
    'ls -la',
    'sed -n 1,20p src/a.ts',
    'npm test',
    'npm t',
    'npm run test',
    'npm run test:unit',
    'npm run lint',
    'npm run typecheck',
    'npm run type-check',
    'yarn test',
    'yarn lint',
    'pnpm run lint',
    'bun test',
    'make test',
    'make lint',
    'npx tsc --noEmit',
    'tsc --noEmit -p tsconfig.json',
    'eslint src',
    'vitest run',
    'jest',
    'pytest -q',
    'python3 -m pytest',
    'cargo test',
    'go vet ./...',
    'node --test test/a.test.ts',
    'prettier --check src',
    'cd /work/repo/.claude/worktrees/w-api && npm test 2>&1 | tail -20',
    'npm test > /tmp/test-out.txt 2>&1',
    'mkdir -p /tmp/review-scratch',
    'cp src/a.ts /tmp/review-scratch/a.ts',
    'echo notes > /tmp/review-notes.md',
    'cairn note DROVE-91 "x" --kind finding',
    'drove roster',
    'gh pr view 12',
    'gh pr diff 1',
    'gh pr checks 1',
    'gh pr list --state open',
    'gh pr status',
    'gh issue view 1',
    'gh run view 1',
    'gh -R a/b pr diff 1',
    'gh api repos/a/b/pulls/1',
    'gh api -X GET repos/a/b/pulls/1',
    'gh search issues widget',
    'gh --version',
    'cat $(git ls-files | head -1)',
  ]) {
    assert.deepEqual([command, reviewer(command)], [command, { allow: true }])
  }
})

test('reviewer: a seat with no role keeps the old worker rules, and the planner is not affected', () => {
  assert.deepEqual(guard.decide({ agent: 'claude', role: 'worker', tool: 'Edit', input: { file_path: '/work/repo/src/a.ts' }, cwd: '/work/repo', writableRoots: [], openSeats: [] }), { allow: true })
  assert.deepEqual(guard.decide({ agent: 'claude', role: 'worker', seatRole: 'tester', tool: 'Bash', input: { command: 'npm install' }, cwd: '/work/repo', writableRoots: [], openSeats: [] }), { allow: true })
  assert.equal(guard.decide({ agent: 'claude', role: 'planner', tool: 'Bash', input: { command: 'npm test' }, cwd: '/work/repo', writableRoots: ['/tmp'], openSeats: [] }).allow, false, 'the planner still runs no checks')
})

// ---------- the hook reads the role from the env ----------

const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'drove-roles-hook-')))
writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/r-api\n')
mkdirSync(join(worktree, 'src'), { recursive: true })

const hookDeps = (): hooks.HookDeps => ({
  now: () => new Date('2026-10-09T10:00:00.000Z'),
  identity: env => identityFromEnv(env),
  hooksPath: identity => `/h/${identity.seat}/hooks.jsonl`,
  eventsPath: () => '/h/events.jsonl',
  scratchRoot: () => '/h/scratch',
  append: async () => undefined,
  openIds: async () => [],
  seatToken: async () => undefined,
  adoptGoal: async () => undefined,
})

test('the guard hook denies a reviewer seat from DROVE_SEAT_ROLE and leaves a plain worker alone', async () => {
  const worker = { DROVE_HOME: '/h', DROVE_RUN: 'r1', DROVE_ROLE: 'worker', DROVE_SEAT: 'r-api' }
  const pre = (tool: string, toolInput: Record<string, unknown>) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: worktree, tool_name: tool, tool_input: toolInput })
  const edit = pre('Edit', { file_path: join(worktree, 'src/a.ts') })
  const denied = await hooks.runHook('pre-tool-use', edit, { ...worker, DROVE_SEAT_ROLE: 'reviewer' }, hookDeps())
  assert.equal(denied.code, 2)
  assert.match(denied.stderr, /a reviewer seat is read-only/)
  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'rm -rf src' }), { ...worker, DROVE_SEAT_ROLE: 'reviewer' }, hookDeps())).code, 2)
  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'npm test' }), { ...worker, DROVE_SEAT_ROLE: 'reviewer' }, hookDeps())).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', edit, worker, hookDeps())).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', edit, { ...worker, DROVE_SEAT_ROLE: 'nonsense' }, hookDeps())).code, 0)
})

test('the identity carries a reviewer or tester role through the env, and an implementer none', () => {
  const base: Identity = { home: '/h', run: 'r1', role: 'worker', seat: 'r-api' }
  assert.equal(identityEnv({ ...base, seatRole: 'reviewer' }).DROVE_SEAT_ROLE, 'reviewer')
  assert.equal('DROVE_SEAT_ROLE' in identityEnv({ ...base, seatRole: 'implementer' }), false)
  assert.equal('DROVE_SEAT_ROLE' in identityEnv(base), false)
  assert.equal(identityFromEnv({ DROVE_RUN: 'r1', DROVE_ROLE: 'worker', DROVE_SEAT: 'r-api', DROVE_SEAT_ROLE: 'tester' })?.seatRole, 'tester')
})

// ---------- the surfaces ----------

test('drove spawn parses --role and --target', () => {
  const values = { kind: 'claude', brief: 'x', role: 'reviewer', target: 'w-api' }
  assert.deepEqual(
    (({ role, target }) => ({ role, target }))(cli.spawnRequestOf(values, ['r-api'], 'x')),
    { role: 'reviewer', target: 'w-api' },
  )
  assert.equal(cli.spawnRequestOf({ kind: 'claude' }, ['w-api'], 'x').role, undefined)
})

test('the spawn tool passes role and target to the command and lists them in its schema', async () => {
  const seen: unknown[] = []
  const ports: tools.ToolPorts = {
    ...tools.defaultToolPorts,
    commands: { ...tools.defaultToolPorts.commands, spawn: async (_deps, _identity, request) => { seen.push(request); return { ok: true, text: 'ok' } } },
  }
  const identity: Identity = { home: '/h', run: RUN, role: 'planner', seat: 'planner' }
  const spawnTool = tools.plannerTools({ home: '/h' } as Deps, identity, ports).find(tool => tool.name === 'spawn')
  assert.ok(spawnTool)
  const properties = (spawnTool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties
  assert.deepEqual(properties.role?.enum, ['implementer', 'reviewer', 'tester'])
  assert.ok(properties.target)
  await spawnTool.call({ seat: 'r-api', kind: 'claude', brief: 'x', role: 'reviewer', target: 'w-api' })
  assert.deepEqual([(seen[0] as { role: string }).role, (seen[0] as { target: string }).target], ['reviewer', 'w-api'])
})

test('the planner role text has the reviewer and tester paragraph, with the budget', () => {
  const run = { id: 'r1', budget: 4 } as RunMeta
  const text = prompts.plannerRole(run, { humanName: 'Sam', workerModel: { claude: 'claude-sonnet-5-5', codex: '' }, promotedModel: { claude: 'claude-opus-5-5', codex: '' } } as DroveConfig, 'claude')
  assert.match(text, /## Reviewer and tester seats\n.*`role`: `reviewer` or `tester`.*`target`/)
  assert.match(text, /risky|large/)
  assert.match(text, /Each takes one of the 4 panes like any worker/)
})
