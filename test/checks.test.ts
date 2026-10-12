import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { checksOf, ledgerPath, readLedger, renderOutcome, runChecks, tailOf, TAIL_BYTES } from '../src/checks.ts'
import * as commands from '../src/commands.ts'
import { checkState, checkText } from '../mod/hooks/roster.ts'
import { runDir } from '../src/paths.ts'
import { buildReport, renderReport } from '../src/report.ts'
import { loadRoster, loadRun, rosterLines } from '../src/roster.ts'
import { readJsonlFrom } from '../src/store.ts'
import { plannerTools } from '../src/tools.ts'
import type { Deps, DroveEvent, Identity, MergeRequest, RunMeta, Seat } from '../src/types.ts'
import { git, makeClock, makeRepo, makeSeat, RUN, seedRun, tmp } from './p3-helpers.ts'

// Real git against a real temp repo; the checks append to a counter file outside it, so a test can tell a rerun from a reuse.
const world = async (options: { checks?: (counter: string) => string[] } = {}) => {
  const repo = await makeRepo()
  const scratch = await tmp('counter')
  const counter = join(scratch, 'count')
  writeFileSync(counter, '')
  const checks = options.checks ? options.checks(counter) : [`echo run >> ${counter}`, 'test -f feature.txt']
  await writeFile(join(repo, '.drove.json'), JSON.stringify({ checks }))
  await git(repo, 'add', '.drove.json')
  await git(repo, 'commit', '-q', '-m', 'chore: checks')
  const worktree = join(repo, '.claude', 'worktrees', 'w-api')
  await git(repo, 'worktree', 'add', '--no-track', '-q', '-b', 'worktree-w-api', worktree, 'main')
  await writeFile(join(worktree, 'feature.txt'), 'feature\n')
  await git(worktree, 'add', 'feature.txt')
  await git(worktree, 'commit', '-q', '-m', 'feat: add the feature')

  const clock = makeClock()
  const deps: Deps = { exec: commands.nodeExec, clock, home: await tmp('home') }
  const seat = makeSeat('w-api', { worktree, branch: 'worktree-w-api', cairn: 'DROVE-9', state: 'done' })
  const run = await seedRun(deps, repo, [seat], { base: 'main', hasRemote: false })
  const planner: Identity = { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }
  const worker: Identity = { home: deps.home, run: RUN, role: 'worker', seat: 'w-api', token: 'token-w-api' }
  const ref = { run: RUN, repo }
  const runs = (): number => readFileSync(counter, 'utf8').split('\n').filter(Boolean).length
  const merge = (request: Partial<MergeRequest> = {}) => commands.merge(deps, planner, ref, { seat: 'w-api', ...request })
  const verify = (request: { fresh?: boolean } = {}) => commands.checks(deps, planner, ref, { seat: 'w-api', ...request })
  const events = async (): Promise<DroveEvent[]> => (await readJsonlFrom<DroveEvent>(join(runDir(deps.home, RUN), 'events.jsonl'), { offset: 0 })).items
  const seatNow = async (): Promise<Seat> => (await loadRoster(deps.home, RUN)).seats[0] as Seat
  const head = (): Promise<string> => git(worktree, 'rev-parse', 'HEAD')
  return { repo, worktree, deps, run, seat, planner, worker, ref, runs, merge, verify, events, seatNow, head, counter }
}

test('drove checks runs the plan in the worktree and appends one ledger line per command, with HEAD and clean (AC1)', async () => {
  const w = await world()
  const result = await w.verify()
  assert.equal(result.ok, true, result.text)
  assert.match(result.text, /w-api: checks passed at [0-9a-f]{7} \(clean tree\)/)
  assert.equal(w.runs(), 1)
  const sha = await w.head()
  const lines = readFileSync(ledgerPath(w.deps.home, RUN), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map(line => line.command), [`echo run >> ${w.counter}`, 'test -f feature.txt'])
  for (const line of lines) {
    assert.deepEqual(Object.keys(line).sort(), ['at', 'clean', 'command', 'cwd', 'durationMs', 'exit', 'seat', 'sha', 'tail'])
    assert.equal(line.seat, 'w-api')
    assert.equal(line.cwd, w.worktree)
    assert.equal(line.sha, sha)
    assert.equal(line.clean, true)
    assert.equal(line.exit, 0)
    assert.equal(typeof line.durationMs, 'number')
    assert.equal(line.at, w.deps.clock.now().toISOString())
  }
  const [event] = (await w.events()).filter(entry => entry.type === 'checks.ran')
  assert.equal(event?.seat, 'w-api')
  assert.deepEqual({ sha: event?.data?.sha, clean: event?.data?.clean, passed: event?.data?.passed, commands: event?.data?.commands }, { sha, clean: true, passed: true, commands: 2 })
  const seat = await w.seatNow()
  assert.deepEqual({ result: seat.checks?.result, sha: seat.checks?.sha, clean: seat.checks?.clean }, { result: 'passed', sha, clean: true })
  assert.match(rosterLines(await loadRoster(w.deps.home, RUN), w.deps.clock.now()).join('\n'), /checks passed at [0-9a-f]{7}/)
})

test('a merge reuses a passing record at HEAD on a clean tree and says so; --fresh runs the checks again (AC2)', async () => {
  const w = await world()
  await w.verify()
  assert.equal(w.runs(), 1)
  const before = (await readLedger(w.deps.home, RUN)).length
  const merged = await w.merge()
  assert.equal(merged.ok, true, merged.text)
  assert.equal(w.runs(), 1, 'no check ran again')
  assert.equal((await readLedger(w.deps.home, RUN)).length, before)
  assert.match(merged.text, /checks reused: passed at [0-9a-f]{7} 2026-10-09T10:00:00Z/)
  const [passed] = (await w.events()).filter(entry => entry.type === 'merge.passed')
  assert.match(String(passed?.data?.detail), /checks reused: passed at [0-9a-f]{7} /)
  assert.equal(passed?.data?.checksReused, true)
  assert.match((await w.seatNow()).gate?.detail ?? '', /checks reused/)
})

test('--fresh on the merge forces the rerun', async () => {
  const w = await world()
  await w.verify()
  const merged = await w.merge({ fresh: true })
  assert.equal(merged.ok, true, merged.text)
  assert.equal(w.runs(), 2)
  assert.match(merged.text, /checks passed: /)
  assert.doesNotMatch(merged.text, /reused/)
  assert.equal((await readLedger(w.deps.home, RUN)).length, 4)
})

test('a merge with no record runs the checks and records them, so the next one is reusable', async () => {
  const w = await world()
  const merged = await w.merge()
  assert.equal(merged.ok, true, merged.text)
  assert.equal(w.runs(), 1)
  assert.equal((await readLedger(w.deps.home, RUN)).length, 2)
})

test('a new commit after the record means the checks run again (AC3)', async () => {
  const w = await world()
  await w.verify()
  const first = await w.head()
  await writeFile(join(w.worktree, 'more.txt'), 'more\n')
  await git(w.worktree, 'add', 'more.txt')
  await git(w.worktree, 'commit', '-q', '-m', 'feat: more')
  assert.notEqual(await w.head(), first)
  const merged = await w.merge()
  assert.equal(merged.ok, true, merged.text)
  assert.equal(w.runs(), 2)
  assert.match(merged.text, /checks passed: /)
  const records = await readLedger(w.deps.home, RUN)
  assert.deepEqual([...new Set(records.map(record => record.sha))], [first, await w.head()])
})

test('a dirty worktree is never evidence: the checks run, are recorded as not clean, and are not reused (AC4)', async () => {
  const w = await world()
  await w.verify()
  await writeFile(join(w.worktree, 'scratch.txt'), 'uncommitted\n')
  const dirty = await runChecks(w.deps, w.run, w.seat)
  assert.ok(!('error' in dirty))
  assert.equal(dirty.reused, false)
  assert.equal(dirty.clean, false)
  assert.equal(w.runs(), 2)
  const again = await runChecks(w.deps, w.run, w.seat)
  assert.ok(!('error' in again))
  assert.equal(again.reused, false, 'a clean record at this sha exists, but the tree is dirty now')
  assert.equal(w.runs(), 3)
  const records = await readLedger(w.deps.home, RUN)
  assert.deepEqual(records.map(record => record.clean), [true, true, false, false, false, false])
  const text = (await w.verify()).text
  assert.match(text, /uncommitted changes in the worktree/)
  assert.match(text, /not evidence a merge reuses/)
})

test('a record made on a dirty tree is not reused once the tree is clean', async () => {
  const w = await world()
  await writeFile(join(w.worktree, 'scratch.txt'), 'uncommitted\n')
  const dirty = await runChecks(w.deps, w.run, w.seat)
  assert.ok(!('error' in dirty) && dirty.passed && !dirty.clean)
  await git(w.worktree, 'add', 'scratch.txt')
  await git(w.worktree, 'commit', '-q', '-m', 'chore: scratch')
  const merged = await w.merge()
  assert.equal(merged.ok, true, merged.text)
  assert.equal(w.runs(), 2)
})

test('a failing check returns its command, exit code and output tail, stops the rest and is never reused (AC5)', async () => {
  const w = await world({ checks: counter => [`echo run >> ${counter}`, 'echo "type error in a.ts" >&2; exit 3', 'touch ran-third'] })
  const result = await w.verify()
  assert.equal(result.ok, true, 'a failing check is a result, not a tool error')
  assert.match(result.text, /checks FAILED at [0-9a-f]{7}/)
  assert.match(result.text, /FAILED +echo "type error in a\.ts" >&2; exit 3 \(exit 3/)
  assert.match(result.text, /\| type error in a\.ts/)
  assert.match(result.text, /skipped +touch ran-third/)
  assert.equal(result.ok && (result.data as { failed?: { exit?: number } }).failed?.exit, 3)
  assert.equal((await readLedger(w.deps.home, RUN)).length, 2, 'the skipped command has no record')
  const seat = await w.seatNow()
  assert.deepEqual({ result: seat.checks?.result, failed: seat.checks?.failed }, { result: 'failed', failed: 'echo "type error in a.ts" >&2; exit 3' })
  const [event] = (await w.events()).filter(entry => entry.type === 'checks.ran')
  assert.deepEqual({ passed: event?.data?.passed, failed: event?.data?.failed, exit: event?.data?.exit, ran: event?.data?.ran }, { passed: false, failed: 'echo "type error in a.ts" >&2; exit 3', exit: 3, ran: 2 })
  const merged = await w.merge()
  assert.equal(merged.ok, false)
  assert.equal(merged.ok === false && merged.code, 'checks-failed')
  assert.match(merged.text, /type error in a\.ts/)
  assert.equal(w.runs(), 2, 'the passing first command was run again with the plan: a failing record is always a rerun')
})

test('the tool in the CLI planner is drove checks: it needs a seat, passes fresh, and a worker cannot use it', async () => {
  const w = await world()
  const tool = plannerTools(w.deps, w.planner).find(candidate => candidate.name === 'run_checks')
  assert.ok(tool)
  assert.match(tool.description, /never writes to the repo/i)
  assert.deepEqual((tool.inputSchema as { required: string[] }).required, ['seat'])
  const first = await tool.call({ seat: 'w-api' })
  assert.equal(first.isError, undefined, first.text)
  assert.match(first.text, /checks passed at/)
  assert.equal(w.runs(), 1)
  const reused = await tool.call({ seat: 'w-api' })
  assert.match(reused.text, /Reused the evidence recorded 2026-10-09T10:00:00\.000Z/)
  assert.equal(w.runs(), 1)
  const fresh = await tool.call({ seat: 'w-api', fresh: true })
  assert.doesNotMatch(fresh.text, /Reused/)
  assert.equal(w.runs(), 2)
  for (const args of [{}, { seat: 'W Bad' }, { seat: 'w-api', fresh: 'yes' }]) assert.equal((await tool.call(args)).isError, true, JSON.stringify(args))
  const refused = await commands.checks(w.deps, w.worker, w.ref, { seat: 'w-api' })
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false && refused.code, 'forbidden')
  const missing = await commands.checks(w.deps, w.planner, w.ref, { seat: 'w-nope' })
  assert.equal(missing.ok === false && missing.code, 'no-seat')
})

test('running the checks writes nothing into the repo or the worktree', async () => {
  const w = await world()
  await w.verify()
  assert.equal(await git(w.worktree, 'status', '--porcelain'), '')
  assert.equal(await git(w.repo, 'status', '--porcelain', '--', '.', ':!.claude'), '')
})

test('a changed plan is a rerun: evidence is per command', async () => {
  const w = await world()
  await w.verify()
  await writeFile(join(w.repo, '.drove.json'), JSON.stringify({ checks: [`echo run >> ${w.counter}`, 'test -f feature.txt', 'true'] }))
  const result = await runChecks(w.deps, w.run, w.seat)
  assert.ok(!('error' in result))
  assert.equal(result.reused, false)
  assert.equal(w.runs(), 2)
})

test('the tail is at most 2 KiB, and a ledger line that escapes to more than the jsonl cap is cut to fit', async () => {
  const w = await world({ checks: () => ['node -e "process.stdout.write(\'x\'.repeat(20000))"', 'node -e "process.stderr.write(\'\\"\'.repeat(6000)); process.exit(2)"'] })
  const result = await w.verify()
  assert.equal(result.ok, true, result.text)
  const records = await readLedger(w.deps.home, RUN)
  assert.equal(records.length, 2)
  assert.ok(Buffer.byteLength(records[0]?.tail ?? '') <= TAIL_BYTES)
  assert.equal(records[0]?.exit, 0)
  assert.equal(records[1]?.exit, 2)
  assert.ok((records[1]?.tail.length ?? 0) > 0 && (records[1]?.tail.length ?? 0) < 6000)
  assert.equal(tailOf('a\n'.repeat(100)).split('\n').length, 40)
  assert.equal(tailOf('\u001b[31mred\u001b[0m\n'), 'red')
})

test('the run report counts check runs and failures per seat, and the last result reads passed, failed or stale', async () => {
  const w = await world({ checks: counter => [`echo run >> ${counter}`] })
  await w.verify()
  await w.verify({ fresh: true })
  await writeFile(join(w.repo, '.drove.json'), JSON.stringify({ checks: ['exit 1'] }))
  await w.verify()
  const report = await buildReport(w.deps, RUN, await tmp('claude'))
  assert.ok(report)
  const row = report.seats.find(item => item.seat === 'w-api')
  assert.deepEqual(row?.checks, { runs: 3, failures: 1 })
  assert.deepEqual(report.totals.checks, { runs: 3, failures: 1 })
  assert.match(renderReport(report), /chk run\/fail/)
  const seat = await w.seatNow()
  assert.equal(checkState(seat), 'failed')
  assert.equal(checkState({ checks: { ...seat.checks, result: 'passed', stale: true } as NonNullable<Seat['checks']> }), 'stale')
  assert.match(checkText({ checks: { result: 'failed', failed: 'npm test', sha: 'abcdef0123', clean: true, at: 'x' } }), /^failed: npm test at abcdef0$/)
  assert.equal(checkState({}), undefined)
})

test('checksOf is unchanged: .drove.json first, then the repo scripts', async () => {
  const w = await world()
  assert.deepEqual((await checksOf(w.repo)).source, '.drove.json')
  const bare = await makeRepo('bare')
  await writeFile(join(bare, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const plan = await checksOf(bare)
  assert.equal(plan.source, 'package.json scripts or Makefile targets')
  assert.ok(plan.commands.some(command => /test/.test(command)))
  const meta = (await loadRun(w.deps.home, RUN)) as RunMeta
  assert.equal(meta.id, RUN)
  await mkdir(join(bare, '.claude'), { recursive: true })
})

test('the merge merges the exact commit that was checked, and records it (head-moved guard, happy path)', async () => {
  const w = await world()
  await w.verify()
  const checked = await w.head()
  const merged = await w.merge()
  assert.equal(merged.ok, true, merged.text)
  assert.equal(await git(w.repo, 'rev-parse', 'HEAD^2'), checked, 'the second parent is the checked commit')
  const [passed] = (await w.events()).filter(entry => entry.type === 'merge.passed')
  assert.equal(passed?.data?.checkedSha, checked)
})

test('a worker on a detached HEAD is refused: the checks saw a commit that would not be merged (head-moved)', async () => {
  const w = await world()
  const tip = await git(w.repo, 'rev-parse', 'refs/heads/worktree-w-api')
  await git(w.worktree, 'checkout', '-q', '--detach')
  await writeFile(join(w.worktree, 'sneaky.txt'), 'not on the branch\n')
  await git(w.worktree, 'add', 'sneaky.txt')
  await git(w.worktree, 'commit', '-q', '-m', 'feat: on a detached HEAD')
  assert.notEqual(await w.head(), tip)
  const before = await git(w.repo, 'rev-parse', 'HEAD')
  const merged = await w.merge()
  assert.equal(merged.ok, false)
  assert.equal(merged.ok === false && merged.code, 'head-moved')
  assert.match(merged.text, /nobody checked|not a detached HEAD/)
  assert.equal(await git(w.repo, 'rev-parse', 'HEAD'), before, 'the base is untouched')
  const [refused] = (await w.events()).filter(entry => entry.type === 'merge.refused')
  assert.equal(refused?.data?.code, 'head-moved')
  assert.equal(refused?.data?.tip, tip)
})

test('a commit made while the checks run is not merged unchecked', async () => {
  const w = await world({ checks: () => ['echo more > more.txt && git add more.txt && git commit -q -m "feat: during the check"'] })
  const tip = await git(w.repo, 'rev-parse', 'refs/heads/worktree-w-api')
  const merged = await w.merge()
  assert.equal(merged.ok, false)
  assert.equal(merged.ok === false && merged.code, 'head-moved')
  assert.notEqual(await git(w.repo, 'rev-parse', 'refs/heads/worktree-w-api'), tip)
  assert.equal(await git(w.repo, 'log', '-1', '--format=%s'), 'chore: checks', 'nothing was merged')
})

test('--pr pushes the checked commit by sha, not the branch by name', async () => {
  const w = await world()
  const remote = await tmp('origin')
  await git(remote, 'init', '-q', '--bare', '-b', 'main')
  await git(w.repo, 'remote', 'add', 'origin', remote)
  const pushes: string[][] = []
  const exec: Deps['exec'] = async (argv, options) => {
    if (argv[0] === 'git' && argv.includes('push')) {
      pushes.push([...argv])
      return { code: 0, stdout: '', stderr: '' }
    }
    if (argv[0] === 'gh') return { code: 1, stdout: '', stderr: 'no gh in this test' }
    return commands.nodeExec(argv, options)
  }
  const deps: Deps = { ...w.deps, exec }
  const sha = await w.head()
  const merged = await commands.merge(deps, w.planner, w.ref, { seat: 'w-api', pr: true })
  assert.equal(merged.ok, false)
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0]?.at(-1), `${sha}:refs/heads/worktree-w-api`)
})

test('a check that edits tracked files leaves clean false, says so, and its record is never reused', async () => {
  const w = await world({ checks: counter => [`echo run >> ${counter}`, 'echo changed >> feature.txt'] })
  const result = await w.verify()
  assert.equal(result.ok, true, result.text)
  assert.match(result.text, /"echo changed >> feature\.txt" left the worktree changed/)
  assert.match(result.text, /not evidence a merge reuses/)
  assert.equal(result.ok && (result.data as { clean: boolean }).clean, false)
  const records = await readLedger(w.deps.home, RUN)
  assert.deepEqual(records.map(record => record.clean), [true, false], 'the command before the edit stays clean, the editing one does not')
  assert.equal((await w.seatNow()).checks?.clean, false)
  const [event] = (await w.events()).filter(entry => entry.type === 'checks.ran')
  assert.equal(event?.data?.clean, false)
  assert.equal(event?.data?.dirtiedBy, 'echo changed >> feature.txt')
  await git(w.worktree, 'checkout', '--', 'feature.txt')
  const again = await runChecks(w.deps, w.run, w.seat)
  assert.ok(!('error' in again))
  assert.equal(again.reused, false)
  assert.equal(w.runs(), 2)
  await git(w.worktree, 'checkout', '--', 'feature.txt')
  const merged = await w.merge()
  assert.equal(merged.ok, true, merged.text)
  assert.equal(w.runs(), 3, 'the merge ran them again')
  assert.doesNotMatch(merged.text, /reused/)
})

test('a ledger with a line that does not parse is no evidence: the checks run again, and later lines still read', async () => {
  const w = await world()
  await w.verify()
  const sha = await w.head()
  assert.equal(w.runs(), 1)
  appendFileSync(ledgerPath(w.deps.home, RUN), `{"seat":"w-api","command":"test -f feature.txt","cwd":"${w.worktree}","sha":"${sha}","clean":true,"exi`)
  const torn = await w.verify()
  assert.equal(torn.ok, true, torn.text)
  assert.match(torn.text, /does not parse, so no evidence is reused/)
  assert.doesNotMatch(torn.text, /Reused/)
  assert.equal(w.runs(), 2)
  const lines = readFileSync(ledgerPath(w.deps.home, RUN), 'utf8').split('\n').filter(line => line.trim() !== '')
  assert.equal(lines.length, 5, 'two records, the torn line, two new records on their own lines')
  const parses = (line: string): boolean => {
    try {
      JSON.parse(line)
      return true
    } catch {
      return false
    }
  }
  assert.equal(lines.filter(parses).length, 4)
  const again = await w.merge()
  assert.equal(again.ok, true, again.text)
  assert.equal(w.runs(), 3, 'the torn line is still in the file, so the evidence is still not trusted')
})

test('a garbage line in the middle of the ledger also means no reuse', async () => {
  const w = await world()
  await w.verify()
  const before = readFileSync(ledgerPath(w.deps.home, RUN), 'utf8')
  writeFileSync(ledgerPath(w.deps.home, RUN), `not json\n${before}`)
  const result = await runChecks(w.deps, w.run, w.seat)
  assert.ok(!('error' in result))
  assert.equal(result.reused, false)
  assert.equal(w.runs(), 2)
})

test('a timed-out check kills its shell and long-running grandchildren and records timeout (DROVE-140)', async () => {
  const w = await world({ checks: () => [
    "echo $$; sh -c 'sleep 300 & echo $!; sleep 300 & echo $!; wait' & echo $!; wait",
  ] })
  const exec = w.deps.exec
  w.deps.exec = (argv, options) => exec(argv, argv[0] === 'sh' ? { ...options, timeoutMs: 500 } : options)
  const outcome = await runChecks(w.deps, w.run, w.seat)
  assert.ok(!('error' in outcome))
  assert.equal(outcome.passed, false)
  assert.equal(outcome.failed?.exit, 124)
  assert.equal(outcome.failed?.timedOut, true)
  assert.match(renderOutcome(outcome), /exit 124, timedOut: true/)
  const [record] = await readLedger(w.deps.home, RUN)
  assert.equal(record?.exit, 124)
  assert.equal(record?.timedOut, true)
  const pids = record!.tail.split('\n').filter(line => /^\d+$/.test(line)).map(Number)
  assert.equal(pids.length, 4, record!.tail)
  const ps = await commands.nodeExec(['ps', '-eo', 'pid=,pgid=,stat='])
  assert.equal(ps.code, 0)
  for (const line of ps.stdout.trim().split('\n')) {
    const [pid, pgid, state] = line.trim().split(/\s+/)
    // A zombie has exited; only init can reap orphaned zombies on some test hosts.
    if (pids.includes(Number(pid)) || Number(pgid) === pids[0]) {
      assert.match(state!, /^Z/, `process still alive: ${line}`)
    }
  }
})
