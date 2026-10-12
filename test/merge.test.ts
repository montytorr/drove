import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import * as commands from '../src/commands.ts'
import { runDir } from '../src/paths.ts'
import { loadRoster, updateRoster } from '../src/roster.ts'
import { readJsonlFrom } from '../src/store.ts'
import type { Deps, DroveEvent, Exec, ExecResult, Identity, MergeRequest, RunMeta } from '../src/types.ts'
import { git, makeClock, makeRepo, makeSeat, RUN, seedRun, tmp } from './p3-helpers.ts'

type FakeCheck = { name: string; bucket: string; link: string }
type FakeGh = {
  calls: string[][]
  pr?: { number: number; url: string; state: string; createdAt: string; mergeable: string; reviewDecision: string; headRefOid?: string }
  checks: FakeCheck[] | 'none'
  mergeFails?: string
  // `gh pr view <branch>` finds nothing while `gh pr view <number>` and `gh pr list` do.
  branchViewHidden?: boolean
  // The next n views after gh pr merge fail like a 502.
  viewFailures?: number
  checksError?: string
  // gh pr checks printed nothing at all, exit 0.
  checksEmpty?: boolean
  pushes: string[][]
}

const PR_URL = 'https://github.com/acme/widget/pull/7'

// Real git against real temp repos, with a bare repo as origin; only `gh` is faked, and it merges into that origin for real.
const world = async (options: { remote?: boolean; checks?: string[] | null; workflows?: boolean; base?: string } = {}) => {
  const repo = await makeRepo()
  if (options.checks !== null) await writeFile(join(repo, '.drove.json'), JSON.stringify({ checks: options.checks ?? ['test -f feature.txt'] }))
  if (options.workflows) {
    await mkdir(join(repo, '.github', 'workflows'), { recursive: true })
    await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci\n')
  }
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: checks')
  const remote = await tmp('origin')
  if (options.remote) {
    await git(remote, 'init', '-q', '--bare', '-b', 'main')
    await git(repo, 'remote', 'add', 'origin', remote)
    await git(repo, 'push', '-q', 'origin', 'main')
    await git(repo, 'fetch', '-q', 'origin')
  }
  const worktree = join(repo, '.claude', 'worktrees', 'w-api')
  await git(repo, 'worktree', 'add', '--no-track', '-q', '-b', 'worktree-w-api', worktree, 'main')
  await writeFile(join(worktree, 'feature.txt'), 'feature\n')
  await git(worktree, 'add', 'feature.txt')
  await git(worktree, 'commit', '-q', '-m', 'feat: add the feature')

  const clock = makeClock()
  const fake: FakeGh = { calls: [], checks: [], pushes: [] }
  const ghExec = async (argv: readonly string[]): Promise<ExecResult> => {
    fake.calls.push([...argv])
    const [, group, action] = argv
    if (group === 'pr' && action === 'list') {
      return { code: 0, stdout: JSON.stringify(fake.pr?.state === 'OPEN' ? [{ number: fake.pr.number, url: fake.pr.url }] : []), stderr: '' }
    }
    if (group === 'pr' && action === 'view') {
      if (fake.branchViewHidden && argv[3] === 'worktree-w-api') return { code: 1, stdout: '', stderr: 'no pull requests found for branch "worktree-w-api"' }
      if (fake.viewFailures && fake.pr?.state === 'MERGED') {
        fake.viewFailures -= 1
        return { code: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)' }
      }
      return fake.pr ? { code: 0, stdout: JSON.stringify(fake.pr), stderr: '' } : { code: 1, stdout: '', stderr: 'no pull requests found for branch "worktree-w-api"' }
    }
    if (group === 'pr' && action === 'create') {
      fake.pr = { number: 7, url: PR_URL, state: 'OPEN', createdAt: clock.now().toISOString(), mergeable: 'MERGEABLE', reviewDecision: '', headRefOid: await git(remote, 'rev-parse', 'refs/heads/worktree-w-api') }
      return { code: 0, stdout: `${PR_URL}\n`, stderr: '' }
    }
    if (group === 'pr' && action === 'checks') {
      if (fake.checksEmpty) return { code: 0, stdout: '', stderr: '' }
      if (fake.checksError) return { code: 1, stdout: '', stderr: fake.checksError }
      if (fake.checks === 'none') return { code: 1, stdout: '', stderr: "no checks reported on the 'worktree-w-api' branch" }
      const code = fake.checks.some(entry => entry.bucket === 'fail') ? 1 : fake.checks.some(entry => entry.bucket === 'pending') ? 8 : 0
      return { code, stdout: JSON.stringify(fake.checks), stderr: '' }
    }
    if (group === 'pr' && action === 'merge') {
      if (fake.mergeFails) return { code: 1, stdout: '', stderr: fake.mergeFails }
      const clone = await tmp('clone')
      await git(clone, 'clone', '-q', remote, '.')
      await git(clone, 'merge', '--no-ff', '-q', '-m', argv[argv.indexOf('--subject') + 1] ?? 'merge', 'origin/worktree-w-api')
      await git(clone, 'push', '-q', 'origin', 'HEAD:main')
      if (fake.pr) fake.pr.state = 'MERGED'
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: `unexpected gh ${argv.join(' ')}` }
  }
  const exec: Exec = async (argv, execOptions) => {
    if (argv[0] === 'gh') return ghExec(argv)
    if (argv[0] === 'git' && argv.includes('push')) fake.pushes.push([...argv])
    return commands.nodeExec(argv, execOptions)
  }
  const deps: Deps = { exec, clock, home: await tmp('home'), sleep: async () => {} }
  const seat = makeSeat('w-api', { worktree, branch: 'worktree-w-api', cairn: 'DROVE-9', state: 'done' })
  const overrides: Partial<RunMeta> = { base: options.base ?? (options.remote ? 'origin/main' : 'main'), hasRemote: options.remote === true }
  await seedRun(deps, repo, [seat], overrides)
  const planner: Identity = { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }
  const human: Identity = { home: deps.home, run: '', role: 'planner', seat: 'planner' }
  const merge = (request: Partial<MergeRequest> = {}, identity: Identity = planner) =>
    commands.merge(deps, identity, { run: identity.run ? undefined : RUN, repo }, { seat: 'w-api', ...request })
  const events = async (): Promise<DroveEvent[]> => (await readJsonlFrom<DroveEvent>(join(runDir(deps.home, RUN), 'events.jsonl'), { offset: 0 })).items
  const gateOf = async () => (await loadRoster(deps.home, RUN)).seats[0]?.gate
  return { repo, remote, worktree, deps, fake, clock, merge, planner, human, events, gateOf }
}

test('a local merge runs the checks in the seat worktree, then merges --no-ff with "merge: <last subject>"', async () => {
  const w = await world()
  const before = await git(w.repo, 'rev-parse', 'HEAD')
  const merged = await w.merge()
  assert.equal(merged.ok, true, merged.text)
  assert.match(merged.text, /Merged worktree-w-api into main at [0-9a-f]+ .*checks passed: test -f feature\.txt/)
  assert.equal(await git(w.repo, 'log', '-1', '--format=%s'), 'merge: feat: add the feature')
  assert.equal((await git(w.repo, 'log', '-1', '--format=%P')).split(' ').length, 2, 'a merge commit with two parents')
  assert.notEqual(await git(w.repo, 'rev-parse', 'HEAD'), before)
  assert.ok(existsSync(join(w.repo, 'feature.txt')))
  const [event] = (await w.events()).filter(entry => entry.type === 'merge.passed')
  assert.equal(event?.seat, 'w-api')
  assert.deepEqual(event?.data?.checks, ['test -f feature.txt'])
  assert.equal((await w.gateOf())?.result, 'passed')
})

test('-m overrides the merge message', async () => {
  const w = await world()
  const merged = await w.merge({ message: 'feat: widget, reviewed (DROVE-9)' })
  assert.equal(merged.ok, true, merged.text)
  assert.equal(await git(w.repo, 'log', '-1', '--format=%s'), 'feat: widget, reviewed (DROVE-9)')
})

test('a failing check refuses the merge with the output tail and leaves the base untouched', async () => {
  const w = await world({ checks: ['echo "type error in a.ts" >&2; exit 3'] })
  const before = await git(w.repo, 'rev-parse', 'HEAD')
  const merged = await w.merge()
  assert.equal(merged.ok, false)
  assert.equal(merged.ok === false && merged.code, 'checks-failed')
  assert.match(merged.text, /"echo .*" failed \(exit 3\)/)
  assert.match(merged.text, /type error in a\.ts/)
  assert.equal(await git(w.repo, 'rev-parse', 'HEAD'), before)
  const [event] = (await w.events()).filter(entry => entry.type === 'merge.refused')
  assert.equal(event?.data?.code, 'checks-failed')
  assert.equal(event?.data?.exitCode, 3)
  assert.equal((await w.gateOf())?.result, 'refused')
  assert.equal((await w.events()).some(entry => entry.type === 'merge.passed'), false)
})

test('the checks run in order and the first failure stops the rest', async () => {
  const w = await world({ checks: ['true', 'echo second >&2; exit 1', 'touch ran-third'] })
  const merged = await w.merge()
  assert.equal(merged.ok, false)
  assert.match(merged.text, /second/)
  assert.equal(existsSync(join(w.worktree, 'ran-third')), false)
})

test('checks are detected from package.json scripts when no .drove.json says otherwise', async () => {
  const w = await world({ checks: null })
  await writeFile(join(w.repo, 'package.json'), JSON.stringify({ scripts: { test: 'true', typecheck: 'true' } }))
  await git(w.repo, 'add', 'package.json')
  await git(w.repo, 'commit', '-q', '-m', 'chore: scripts')
  const merged = await w.merge()
  assert.equal(merged.ok, true, merged.text)
  assert.match(merged.text, /checks passed: npm run typecheck, npm test/)
})

test('a repo that defines no checks refuses; an empty checks list declares there are none', async () => {
  const bare = await world({ checks: null })
  const refused = await bare.merge()
  assert.equal(refused.ok === false && refused.code, 'no-checks')
  assert.match(refused.text, /\.drove\.json/)
  const declared = await world({ checks: [] })
  const merged = await declared.merge()
  assert.equal(merged.ok, true, merged.text)
  assert.match(merged.text, /no local checks/)
})

test('the base defines the checks: a branch that rewrites .drove.json does not loosen its own gate', async () => {
  const w = await world({ checks: ['test -f required.txt'] })
  await writeFile(join(w.worktree, '.drove.json'), JSON.stringify({ checks: [] }))
  await git(w.worktree, 'add', '.drove.json')
  await git(w.worktree, 'commit', '-q', '-m', 'chore: loosen')
  const merged = await w.merge()
  assert.equal(merged.ok === false && merged.code, 'checks-failed')
})

test('a main checkout with uncommitted changes, or on another branch, refuses', async () => {
  const dirty = await world()
  await writeFile(join(dirty.repo, 'README.md'), 'changed\n')
  const refused = await dirty.merge()
  assert.equal(refused.ok === false && refused.code, 'dirty-checkout')
  assert.match(refused.text, /README\.md/)
  assert.equal((await dirty.gateOf())?.result, 'refused')

  const elsewhere = await world()
  await git(elsewhere.repo, 'switch', '-q', '-c', 'scratch', '--no-track')
  const wrong = await elsewhere.merge()
  assert.equal(wrong.ok === false && wrong.code, 'wrong-branch')
  assert.match(wrong.text, /is on scratch, not main/)
})

test('untracked files under .claude/ (the worktrees themselves) do not make the checkout dirty', async () => {
  const w = await world()
  assert.ok(existsSync(join(w.repo, '.claude', 'worktrees', 'w-api')))
  const merged = await w.merge()
  assert.equal(merged.ok, true, merged.text)
})

test('a seat worktree with uncommitted changes refuses, so the checks never run on what will not be merged', async () => {
  const w = await world()
  await writeFile(join(w.worktree, 'forgotten.ts'), 'export {}\n')
  const refused = await w.merge()
  assert.equal(refused.ok === false && refused.code, 'dirty-worktree')
  assert.match(refused.text, /forgotten\.ts/)
})

test('a conflicting merge is aborted and leaves the base clean', async () => {
  const w = await world()
  await writeFile(join(w.worktree, 'README.md'), 'from the worker\n')
  await git(w.worktree, 'commit', '-q', '-am', 'feat: readme')
  await writeFile(join(w.repo, 'README.md'), 'from main\n')
  await git(w.repo, 'commit', '-q', '-am', 'docs: readme')
  const before = await git(w.repo, 'rev-parse', 'HEAD')
  const refused = await w.merge()
  assert.equal(refused.ok === false && refused.code, 'merge-conflict')
  assert.equal(await git(w.repo, 'rev-parse', 'HEAD'), before)
  assert.equal(await git(w.repo, 'status', '--porcelain', '--untracked-files=no'), '')
})

test('a merged branch is reported as done with nothing to do', async () => {
  const w = await world()
  assert.equal((await w.merge()).ok, true)
  const again = await w.merge()
  assert.equal(again.ok, true)
  assert.match(again.text, /already merged/)
})

test('--no-checks is refused inside a Drove session and honoured for the human, who merges despite a failing check', async () => {
  const w = await world({ checks: ['exit 1'] })
  const refused = await w.merge({ noChecks: true })
  assert.equal(refused.ok === false && refused.code, 'forbidden')
  assert.match(refused.text, /--no-checks is for the human/)
  assert.equal(await w.gateOf(), undefined)
  const merged = await w.merge({ noChecks: true }, w.human)
  assert.equal(merged.ok, true, merged.text)
  assert.match(merged.text, /no local checks \(--no-checks\)/)
})

test('a worker cannot merge, and --squash means --pr', async () => {
  const w = await world()
  const worker = await commands.merge(w.deps, { ...w.planner, role: 'worker', seat: 'w-api' }, { repo: w.repo }, { seat: 'w-api' })
  assert.equal(worker.ok === false && worker.code, 'forbidden')
  const squash = await w.merge({ squash: true })
  assert.equal(squash.ok === false && squash.code, 'usage')
})

test('the checks do not see the planner’s Drove identity', async () => {
  const w = await world({ checks: ['test -z "$DROVE_RUN" && test -z "$DROVE_ROLE"'] })
  process.env.DROVE_RUN = 'planner-run'
  process.env.DROVE_ROLE = 'planner'
  try {
    const merged = await w.merge()
    assert.equal(merged.ok, true, merged.text)
  } finally {
    delete process.env.DROVE_RUN
    delete process.env.DROVE_ROLE
  }
})

test('--pr pushes, opens a PR from the commits and the Cairn ref, and returns pending with the URL while checks run', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.checks = [{ name: 'build', bucket: 'pass', link: 'https://ci/1' }, { name: 'test', bucket: 'pending', link: 'https://ci/2' }]
  const pending = await w.merge({ pr: true })
  assert.equal(pending.ok, true, pending.text)
  assert.match(pending.text, /^pending: 1 check is still running \(test\) on https:\/\/github\.com\/acme\/widget\/pull\/7\. Run drove merge w-api --pr again later\./)
  assert.deepEqual(pending.ok && pending.data, { status: 'pending', mode: 'pr', url: PR_URL, pr: 7 })
  assert.equal(await git(w.remote, 'rev-parse', '--verify', 'refs/heads/worktree-w-api'), await git(w.worktree, 'rev-parse', 'HEAD'))
  assert.equal(w.fake.pushes[0]?.at(-1), `${await git(w.worktree, 'rev-parse', 'HEAD')}:refs/heads/worktree-w-api`, 'the exact commit is pushed, by sha (DROVE-122)')
  const create = w.fake.calls.find(call => call[1] === 'pr' && call[2] === 'create') ?? []
  assert.equal(create[create.indexOf('--head') + 1], 'worktree-w-api')
  assert.equal(create[create.indexOf('--base') + 1], 'main')
  assert.equal(create[create.indexOf('--title') + 1], 'feat: add the feature (DROVE-9)')
  assert.match(create[create.indexOf('--body') + 1] ?? '', /- feat: add the feature\n\nCairn: DROVE-9\nDrove run /)
  assert.equal(w.fake.calls.some(call => call[2] === 'merge'), false)
  assert.equal((await w.events()).filter(entry => entry.type === 'merge.pending').length, 1)
  assert.equal((await w.gateOf())?.result, 'pending')
})

test('--pr again after the checks finish merges; a second call does not open a second PR', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.checks = [{ name: 'test', bucket: 'pending', link: '' }]
  assert.match((await w.merge({ pr: true })).text, /^pending/)
  w.fake.checks = [{ name: 'test', bucket: 'pass', link: '' }]
  const merged = await w.merge({ pr: true })
  assert.equal(merged.ok, true, merged.text)
  assert.equal(w.fake.calls.filter(call => call[2] === 'create').length, 1)
  assert.match(merged.text, /^Merged https:\/\/github\.com\/acme\/widget\/pull\/7 \(merge commit\); GitHub checks green\./)
})

test('--pr reuses the open PR of the branch instead of creating one', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.pr = { number: 2, url: 'https://github.com/acme/widget/pull/2', state: 'OPEN', createdAt: w.clock.now().toISOString(), mergeable: 'MERGEABLE', reviewDecision: '' }
  w.fake.branchViewHidden = true
  w.fake.checks = [{ name: 'test', bucket: 'pending', link: '' }]
  const pending = await w.merge({ pr: true })
  assert.match(pending.text, /^pending: 1 check is still running \(test\) on https:\/\/github\.com\/acme\/widget\/pull\/2\./)
  assert.equal(w.fake.calls.some(call => call[2] === 'create'), false)
  assert.ok(w.fake.calls.some(call => call[2] === 'list' && call.includes('--head') && call.includes('--state')))
  assert.ok(w.fake.calls.some(call => call[2] === 'checks' && call[3] === '2'))
})

test('--pr settles as merged when the state read after gh pr merge fails at first', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.checks = [{ name: 'test', bucket: 'pass', link: '' }]
  w.fake.viewFailures = 2
  const merged = await w.merge({ pr: true })
  assert.equal(merged.ok, true, merged.text)
  assert.equal(w.fake.viewFailures, 0)
  assert.equal((await w.gateOf())?.result, 'passed')
  assert.ok(existsSync(join(w.repo, 'feature.txt')))
  assert.equal(await git(w.remote, 'branch', '--list', 'worktree-w-api'), '')
})

test('--pr answers pending, with the URL, when gh gives a 5xx on the checks read', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.checksError = 'HTTP 502: Bad Gateway (https://api.github.com/graphql)'
  const pending = await w.merge({ pr: true })
  assert.equal(pending.ok, true, pending.text)
  assert.match(pending.text, /^pending: .*502.* on https:\/\/github\.com\/acme\/widget\/pull\/7\./)
  assert.equal((await w.gateOf())?.result, 'pending')
  for (const flaky of ['unexpected end of JSON input', '']) {
    w.fake.checksError = flaky
    w.fake.checksEmpty = flaky === ''
    assert.match((await w.merge({ pr: true })).text, /^pending: GitHub did not answer the read of the checks/)
  }
  w.fake.checksEmpty = false
  w.fake.checksError = 'unknown flag'
  assert.equal((await w.merge({ pr: true })).ok, false)
})

test('--pr for a PR already MERGED on GitHub settles it: fast-forward, event, branch deleted', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.checks = [{ name: 'test', bucket: 'pass', link: '' }]
  await w.merge({ pr: true })
  // Undo the local settle, as if the answer was lost: local main back before the merge, remote branch back.
  await git(w.repo, 'reset', '-q', '--hard', 'HEAD^1')
  await git(w.repo, 'push', '-q', 'origin', 'worktree-w-api')
  assert.equal(w.fake.pr?.state, 'MERGED')
  const calls = w.fake.calls.length
  const again = await w.merge({ pr: true })
  assert.equal(again.ok, true, again.text)
  assert.equal(w.fake.calls.slice(calls).some(call => call[2] === 'merge' || call[2] === 'create'), false)
  assert.ok(existsSync(join(w.repo, 'feature.txt')))
  assert.equal(await git(w.remote, 'branch', '--list', 'worktree-w-api'), '')
})

test('--pr does not settle on an old MERGED PR of the same branch name: it pushes and opens a new PR', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.pr = { number: 2, url: 'https://github.com/acme/widget/pull/2', state: 'MERGED', createdAt: w.clock.now().toISOString(), mergeable: 'UNKNOWN', reviewDecision: '', headRefOid: '0'.repeat(40) }
  w.fake.checks = [{ name: 'test', bucket: 'pending', link: '' }]
  const pending = await w.merge({ pr: true })
  assert.match(pending.text, /^pending: 1 check is still running \(test\) on https:\/\/github\.com\/acme\/widget\/pull\/7\./)
  assert.equal(w.fake.pushes.length > 0, true)
  assert.equal(w.fake.calls.filter(call => call[2] === 'create').length, 1)
})

test('--pr with a failing check refuses and names the failing checks', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.checks = [{ name: 'build', bucket: 'pass', link: '' }, { name: 'test', bucket: 'fail', link: 'https://ci/2' }, { name: 'lint', bucket: 'cancel', link: '' }]
  const refused = await w.merge({ pr: true })
  assert.equal(refused.ok === false && refused.code, 'checks-failed')
  assert.match(refused.text, /2 checks failed on https:\/\/github\.com\/acme\/widget\/pull\/7:\n- test https:\/\/ci\/2\n- lint/)
  assert.equal(w.fake.calls.some(call => call[2] === 'merge'), false)
  assert.equal((await w.events()).filter(entry => entry.type === 'merge.refused').length, 1)
})

test('--pr with green checks squash-merges through gh, deletes the remote branch and fast-forwards the local base', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.checks = [{ name: 'test', bucket: 'pass', link: '' }, { name: 'docs', bucket: 'skipping', link: '' }]
  const merged = await w.merge({ pr: true, squash: true, message: 'feat: the feature (DROVE-9)' })
  assert.equal(merged.ok, true, merged.text)
  const call = w.fake.calls.find(entry => entry[2] === 'merge') ?? []
  assert.deepEqual(call.slice(1), ['pr', 'merge', '7', '--squash', '--subject', 'feat: the feature (DROVE-9)'])
  assert.equal(call.includes('--delete-branch'), false)
  assert.ok(w.fake.pushes.some(push => push.includes('--delete') && push.includes('worktree-w-api')))
  assert.notEqual((await git(w.remote, 'branch', '--list', 'worktree-w-api')).trim(), 'worktree-w-api')
  assert.equal(await git(w.repo, 'rev-parse', 'HEAD'), await git(w.remote, 'rev-parse', 'main'))
  assert.equal(await git(w.repo, 'log', '-1', '--format=%s'), 'feat: the feature (DROVE-9)')
  const [event] = (await w.events()).filter(entry => entry.type === 'merge.passed')
  assert.equal(event?.data?.squash, true)
  assert.equal(event?.data?.url, PR_URL)
  assert.equal((await w.gateOf())?.result, 'passed')
})

test('--pr without --squash uses a merge commit', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.checks = [{ name: 'test', bucket: 'pass', link: '' }]
  const merged = await w.merge({ pr: true })
  assert.equal(merged.ok, true, merged.text)
  const call = w.fake.calls.find(entry => entry[2] === 'merge') ?? []
  assert.deepEqual(call.slice(1, 5), ['pr', 'merge', '7', '--merge'])
  assert.equal(await git(w.repo, 'log', '-1', '--format=%s'), 'merge: feat: add the feature')
})

test('--pr in a repo with no workflows runs the local checks before anything is pushed', async () => {
  const w = await world({ remote: true, checks: ['echo red >&2; exit 1'] })
  const refused = await w.merge({ pr: true })
  assert.equal(refused.ok === false && refused.code, 'checks-failed')
  assert.equal(w.fake.pushes.length, 0)
  assert.equal(w.fake.calls.every(call => call[2] === 'view'), true, 'only the PR state is read before the checks')
})

test('--pr in a repo with no CI counts as green once the local checks pass', async () => {
  const w = await world({ remote: true })
  w.fake.checks = 'none'
  const merged = await w.merge({ pr: true })
  assert.equal(merged.ok, true, merged.text)
  assert.match(merged.text, /checks passed: test -f feature\.txt/)
  assert.ok(w.fake.calls.some(call => call[2] === 'merge'))
})

test('--pr where workflows exist but no check has reported is pending until the grace period passes, then needs the local checks', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.checks = 'none'
  const early = await w.merge({ pr: true })
  assert.match(early.text, /^pending: no checks have reported yet/)
  w.clock.advance(commands.CI_GRACE_MS + 1_000)
  const late = await w.merge({ pr: true })
  assert.equal(late.ok, true, late.text)
  assert.match(late.text, /checks passed: test -f feature\.txt/)
})

test('--pr refuses conflicts, requested changes and a rejected gh merge, and waits for a required review', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.checks = [{ name: 'test', bucket: 'pass', link: '' }]
  w.fake.pr = { number: 7, url: PR_URL, state: 'OPEN', createdAt: w.clock.now().toISOString(), mergeable: 'CONFLICTING', reviewDecision: '' }
  const conflicting = await w.merge({ pr: true })
  assert.equal(conflicting.ok === false && conflicting.code, 'pr-conflicts')
  assert.match(conflicting.text, /has conflicts with main/)
  w.fake.pr.mergeable = 'MERGEABLE'
  w.fake.pr.reviewDecision = 'CHANGES_REQUESTED'
  const changes = await w.merge({ pr: true })
  assert.equal(changes.ok === false && changes.code, 'pr-changes-requested')
  w.fake.pr.reviewDecision = 'REVIEW_REQUIRED'
  assert.match((await w.merge({ pr: true })).text, /^pending: a review is required on GitHub/)
  w.fake.pr.reviewDecision = ''
  w.fake.mergeFails = 'Pull request is not mergeable: the base branch policy prohibits the merge'
  const rejected = await w.merge({ pr: true })
  assert.equal(rejected.ok === false && rejected.code, 'pr-merge-failed')
  assert.match(rejected.text, /base branch policy/)
  assert.equal((await loadRoster(w.deps.home, RUN)).seats[0]?.gate?.result, 'refused')
})

test('--pr never pushes a production branch, and needs a remote', async () => {
  const w = await world({ remote: true, workflows: true })
  await git(w.repo, 'branch', 'production', 'worktree-w-api')
  await updateRoster(w.deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, branch: 'production' })) }))
  const refused = await w.merge({ pr: true })
  assert.equal(refused.ok === false && refused.code, 'bad-branch')
  assert.equal(w.fake.pushes.length, 0)
  const noRemote = await world({ workflows: true })
  const missing = await noRemote.merge({ pr: true })
  assert.equal(missing.ok === false && missing.code, 'no-remote')
})

test('--pr leaves the local base alone, with a note, when the main checkout is not on it', async () => {
  const w = await world({ remote: true, workflows: true })
  w.fake.checks = [{ name: 'test', bucket: 'pass', link: '' }]
  const before = await git(w.repo, 'rev-parse', 'main')
  await git(w.repo, 'switch', '-q', '-c', 'scratch', '--no-track')
  const merged = await w.merge({ pr: true })
  assert.equal(merged.ok, true, merged.text)
  assert.match(merged.text, /not main, so local main was not updated/)
  assert.equal(await git(w.repo, 'rev-parse', 'main'), before)
})

test('a merge for a seat that is not in the roster is refused without touching anything', async () => {
  const w = await world()
  const refused = await w.merge({ seat: 'w-nope' })
  assert.equal(refused.ok === false && refused.code, 'no-seat')
})
