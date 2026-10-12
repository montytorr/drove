import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { main } from '../src/cli.ts'
import * as commands from '../src/commands.ts'
import { diagnoseRun, renderDiagnosis, type Finding } from '../src/diagnose.ts'
import { runDir, seatDir } from '../src/paths.ts'
import type { Deps, DroveEvent, Seat } from '../src/types.ts'
import { FakeHerdr, git, makeDeps, makeRepo, makeSeat, RUN, seedRun } from './p3-helpers.ts'

const at = (minute: number): string => `2026-10-09T10:${String(minute).padStart(2, '0')}:00.000Z`
const ev = (minute: number, type: string, seat: string | undefined, data?: Record<string, unknown>): DroveEvent => ({ at: at(minute), type: type as DroveEvent['type'], ...(seat ? { seat } : {}), ...(data ? { data } : {}) })
const jsonl = (items: unknown[]): string => `${items.map(item => JSON.stringify(item)).join('\n')}\n`

const savedHome = process.env.DROVE_HOME
afterEach(() => {
  if (savedHome === undefined) delete process.env.DROVE_HOME
  else process.env.DROVE_HOME = savedHome
})

// A run on disk: roster, events, and optionally a seat's brief and the check ledger. Git is real; nothing else is.
const world = async (seats: Seat[], events: DroveEvent[], options: { repo?: string; briefs?: Record<string, string>; ledger?: unknown[] } = {}) => {
  const deps: Deps = { ...(await makeDeps(new FakeHerdr())), exec: commands.nodeExec }
  const repo = options.repo ?? (await makeRepo())
  const run = await seedRun(deps, repo, seats)
  await writeFile(join(runDir(deps.home, run.id), 'events.jsonl'), jsonl(events))
  if (options.ledger) await writeFile(join(runDir(deps.home, run.id), 'checks.jsonl'), jsonl(options.ledger))
  for (const [name, brief] of Object.entries(options.briefs ?? {})) {
    await mkdir(seatDir(deps.home, run.id, name), { recursive: true })
    await writeFile(join(seatDir(deps.home, run.id, name), 'brief.md'), brief)
  }
  return { deps, run, repo }
}

const find = (findings: Finding[], category: string, seat?: string): Finding | undefined => findings.find(item => item.category === category && (seat === undefined || item.seat === seat))
const diagnose = async (deps: Deps): Promise<Finding[]> => ((await diagnoseRun(deps, RUN)) as { findings: Finding[] }).findings
const cli = async (argv: string[]) => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, { out: text => out.push(text), err: text => err.push(text), stdin: async () => '' })
  return { code, out, err }
}

test('AC1: three owns denials then a widening is scope-too-narrow with a brief fix', async () => {
  const { deps } = await world(
    [makeSeat('w-a', { owns: ['src/types.ts', 'mod/types/index.d.ts'], acceptance: ['AC'] })],
    [
      ev(1, 'seat.spawn', 'w-a'),
      ...[2, 3, 4].map(minute => ev(minute, 'guard.denied', 'w-a', { tool: 'Edit', rule: 'owns', path: 'mod/types/index.d.ts' })),
      ev(5, 'seat.owns', 'w-a', { owns: ['src/types.ts', 'mod/types/index.d.ts'], previous: ['src/types.ts'], mode: 'set' }),
    ],
  )
  const finding = find(await diagnose(deps), 'scope-too-narrow', 'w-a')
  assert.ok(finding)
  assert.equal(finding.fix.where, 'brief')
  assert.equal(finding.confidence, 'high')
  assert.match(finding.evidence, /3 owns denials/)
  assert.match(finding.evidence, /mod\/types\/index\.d\.ts/)
  assert.match(finding.evidence, /then owns widened/)
})

test('a denial with no widening, or a widening with no denial, is medium', async () => {
  const { deps } = await world(
    [makeSeat('w-a'), makeSeat('w-b')],
    [ev(1, 'guard.denied', 'w-a', { rule: 'owns', path: 'x.ts' }), ev(2, 'seat.owns', 'w-b', { owns: ['y.ts'], mode: 'add' }), ev(3, 'seat.owns', 'w-a', { owns: ['x.ts'], mode: 'set' }), ev(4, 'guard.denied', 'w-b', { rule: 'read-only' })],
  )
  const findings = await diagnose(deps)
  assert.equal(find(findings, 'scope-too-narrow', 'w-a')?.confidence, 'medium')
  assert.equal(find(findings, 'scope-too-narrow', 'w-b')?.confidence, 'medium')
  assert.equal(findings.filter(item => item.seat === 'w-b').length, 1)
})

test('AC2: two changes verdicts on a seat with no acceptance give review-loop and no-acceptance', async () => {
  const { deps } = await world(
    [makeSeat('w-a')],
    [
      ev(1, 'seat.spawn', 'w-a'),
      ev(2, 'control.sent', 'w-a', { kind: 'verdict', verdict: 'changes', notes: 'The merge helper drops the base.' }),
      ev(3, 'control.sent', 'w-a', { kind: 'verdict', verdict: 'changes' }),
    ],
  )
  const findings = await diagnose(deps)
  const loop = find(findings, 'review-loop', 'w-a')
  assert.ok(loop)
  assert.match(loop.evidence, /2 changes verdicts/)
  assert.match(loop.evidence, /«The merge helper drops the base\.»/)
  assert.match(loop.evidence, /notes not recorded/)
  assert.equal(loop.fix.where, 'brief')
  assert.equal(find(findings, 'no-acceptance', 'w-a')?.fix.where, 'brief')
})

test('a seat with acceptance (roster or brief) is not no-acceptance, and one changes is not a loop', async () => {
  const { deps } = await world(
    [makeSeat('w-a', { acceptance: ['AC1: works'] }), makeSeat('w-b')],
    [ev(1, 'control.sent', 'w-a', { kind: 'verdict', verdict: 'changes' }), ev(2, 'control.sent', 'w-a', { kind: 'verdict', verdict: 'changes' }), ev(3, 'control.sent', 'w-b', { kind: 'verdict', verdict: 'changes' })],
    { briefs: { 'w-b': 'Do the thing.\n\n## Acceptance\n\n- AC1: x\n' } },
  )
  const findings = await diagnose(deps)
  assert.equal(find(findings, 'no-acceptance'), undefined)
  assert.match(find(findings, 'review-loop', 'w-a')?.fix.text ?? '', /too vague/)
  assert.equal(find(findings, 'review-loop', 'w-b'), undefined)
})

test('checks-failed-at-done: a done report then a failing check run', async () => {
  const { deps } = await world(
    [makeSeat('w-a')],
    [
      ev(1, 'checks.ran', 'w-a', { sha: 'a'.repeat(40), passed: false, failed: 'npm test' }),
      ev(2, 'report', 'w-a', { kind: 'done', expects: 'review' }),
      ev(3, 'checks.ran', 'w-a', { sha: 'b'.repeat(40), passed: false, failed: 'npm run typecheck' }),
    ],
  )
  const findings = await diagnose(deps)
  const finding = find(findings, 'checks-failed-at-done', 'w-a')
  assert.ok(finding)
  assert.equal(finding.confidence, 'high')
  assert.equal(finding.fix.where, 'config')
  assert.match(finding.evidence, /1 failing check run after a done report \(npm run typecheck\)/)
  assert.equal(find(findings, 'ci-only-failure'), undefined)
})

test('checks failing before any done report is not checks-failed-at-done', async () => {
  const { deps } = await world([makeSeat('w-a')], [ev(1, 'checks.ran', 'w-a', { passed: false, failed: 'npm test' })])
  assert.deepEqual(await diagnose(deps), [])
})

test('ci-only-failure: PR checks failed while the local check passed', async () => {
  const url = 'https://github.com/acme/widget/pull/7'
  const { deps } = await world(
    [makeSeat('w-a'), makeSeat('w-b')],
    [
      ev(1, 'report', 'w-a', { kind: 'done', expects: 'review' }),
      ev(2, 'checks.ran', 'w-a', { sha: 'c'.repeat(40), passed: true }),
      ev(3, 'merge.refused', 'w-a', { code: 'checks-failed', url, failing: ['test (ubuntu)'] }),
      // w-b has no passing local run: a plain failure after done
      ev(4, 'report', 'w-b', { kind: 'done', expects: 'review' }),
      ev(5, 'merge.refused', 'w-b', { code: 'checks-failed', url, failing: ['test'] }),
    ],
  )
  const findings = await diagnose(deps)
  const ci = find(findings, 'ci-only-failure', 'w-a')
  assert.ok(ci)
  assert.equal(ci.fix.where, 'repo')
  assert.equal(ci.confidence, 'medium')
  assert.match(ci.evidence, /test \(ubuntu\)/)
  assert.equal(find(findings, 'checks-failed-at-done', 'w-a'), undefined)
  assert.equal(find(findings, 'ci-only-failure', 'w-b'), undefined)
  assert.equal(find(findings, 'checks-failed-at-done', 'w-b')?.confidence, 'medium')
})

test('ci-only-failure falls back to the check ledger', async () => {
  const { deps } = await world(
    [makeSeat('w-a')],
    [ev(3, 'merge.refused', 'w-a', { code: 'checks-failed', url: 'https://github.com/a/b/pull/1', failing: ['t'] })],
    { ledger: [{ seat: 'w-a', command: 'npm test', sha: 'd'.repeat(40), exit: 0, at: at(1), clean: true }] },
  )
  assert.ok(find(await diagnose(deps), 'ci-only-failure', 'w-a'))
})

test('AC3: a merge conflict names both seats whose branches touched the same file', async () => {
  const repo = await makeRepo()
  const branch = async (name: string, files: Record<string, string>) => {
    await git(repo, 'checkout', '-q', '-b', name, 'main')
    for (const [file, body] of Object.entries(files)) await writeFile(join(repo, file), body)
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', name)
    await git(repo, 'checkout', '-q', 'main')
  }
  await branch('drove/w-a', { 'shared.ts': 'a\n', 'a-only.ts': 'a\n' })
  await branch('drove/w-b', { 'shared.ts': 'b\n' })
  await branch('drove/w-c', { 'c-only.ts': 'c\n' })
  const { deps } = await world(
    [makeSeat('w-a'), makeSeat('w-b'), makeSeat('w-c')],
    [ev(1, 'merge.refused', 'w-b', { code: 'merge-conflict', branch: 'drove/w-b', base: 'main' })],
    { repo },
  )
  const conflict = find(await diagnose(deps), 'merge-conflict')
  assert.ok(conflict)
  assert.equal(conflict.seat, 'w-b')
  assert.deepEqual(conflict.with, ['w-a'])
  assert.equal(conflict.confidence, 'high')
  assert.equal(conflict.fix.where, 'planning')
  assert.match(conflict.evidence, /w-b and w-a both touched shared\.ts/)
  assert.doesNotMatch(conflict.evidence, /w-c/)
})

test('a conflict with a merged counterpart is read from its merge commit; a lone conflict is medium', async () => {
  const repo = await makeRepo()
  await git(repo, 'checkout', '-q', '-b', 'drove/w-a', 'main')
  await writeFile(join(repo, 'shared.ts'), 'a\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', 'a')
  await git(repo, 'checkout', '-q', '-b', 'drove/w-b', 'main')
  await writeFile(join(repo, 'shared.ts'), 'b\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', 'b')
  await git(repo, 'checkout', '-q', 'main')
  await git(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'drove/w-a')
  const { deps } = await world([makeSeat('w-a'), makeSeat('w-b')], [ev(1, 'merge.refused', 'w-b', { code: 'pr-conflicts', url: 'u' })], { repo })
  assert.deepEqual(find(await diagnose(deps), 'merge-conflict', 'w-b')?.with, ['w-a'])

  const lone = await world([makeSeat('w-x', { branch: 'drove/gone' })], [ev(1, 'merge.refused', 'w-x', { code: 'merge-conflict' })])
  const finding = find(await diagnose(lone.deps), 'merge-conflict', 'w-x')
  assert.equal(finding?.confidence, 'medium')
  assert.equal(finding?.with, undefined)
})

test('brief-not-delivered: a stalled prompt, a failed control, an unconfirmed brief', async () => {
  const { deps } = await world(
    [makeSeat('w-a'), makeSeat('w-b'), makeSeat('w-c')],
    [
      ev(1, 'attention', 'w-a', { reason: 'stalled', detail: 'agent_prompt_stalled: herdr typed the text' }),
      ev(2, 'control.failed', 'w-b', { kind: 'brief', reason: 'pane gone' }),
      ev(3, 'control.sent', 'w-c', { kind: 'brief', via: 'prompt', unconfirmed: true }),
      ev(4, 'control.sent', 'w-c', { kind: 'nudge', via: 'prompt' }),
    ],
  )
  const findings = await diagnose(deps)
  assert.equal(find(findings, 'brief-not-delivered', 'w-a')?.confidence, 'high')
  assert.equal(find(findings, 'brief-not-delivered', 'w-b')?.fix.where, 'Drove')
  assert.equal(find(findings, 'brief-not-delivered', 'w-c')?.confidence, 'medium')
})

test('budget-hit, usage-limit, guard-thrash and steering are reported from their records', async () => {
  const { deps } = await world(
    [makeSeat('w-a')],
    [
      ev(1, 'attention', 'w-a', { reason: 'budget', detail: 'reached 30 turns' }),
      ev(2, 'attention', 'w-a', { reason: 'usage-limit' }),
      ev(3, 'attention', 'w-a', { reason: 'guard-thrash', rule: 'owns', count: 3 }),
      ev(4, 'steer.nudged', 'w-a', { seat: 'w-a', rule: 'R1', detail: 'npm test failed 3 times' }),
      ev(4, 'steer.nudged', 'w-a', { seat: 'w-a', rule: 'R2', detail: 'done without a check' }),
      ev(5, 'attention', undefined, { reason: 'run-budget', detail: 'run cost passed $20' }),
    ],
  )
  const findings = await diagnose(deps)
  for (const category of ['budget-hit', 'usage-limit', 'guard-thrash', 'steering']) assert.ok(find(findings, category, 'w-a'), category)
  assert.match(find(findings, 'guard-thrash', 'w-a')?.evidence ?? '', /rule owns/)
  const steering = findings.filter(item => item.category === 'steering')
  assert.equal(steering.length, 2)
  assert.match(steering[0]?.evidence ?? '', /R1 repeated failure: npm test failed 3 times/)
  assert.equal(steering[0]?.fix.where, 'role text')
  assert.match(steering[1]?.evidence ?? '', /R2 done without a check/)
  assert.match(steering[1]?.fix.text ?? '', /autoChecks/)
  assert.equal(steering[1]?.fix.where, 'config')
  assert.equal(find(findings, 'budget-hit', 'planner')?.fix.where, 'config')
})

test('AC4: a clean run prints no findings on stdout, the summary on stderr, and exits 0', async () => {
  const { deps, run } = await world([makeSeat('w-a', { acceptance: ['AC1'] })], [ev(1, 'seat.spawn', 'w-a'), ev(2, 'report', 'w-a', { kind: 'done', expects: 'review' }), ev(3, 'control.sent', 'w-a', { kind: 'verdict', verdict: 'approve' })])
  process.env.DROVE_HOME = deps.home
  const { code, out, err } = await cli(['diagnose', run.id])
  assert.equal(code, 0)
  assert.deepEqual(out, ['no findings'])
  assert.equal(err.length, 1)
  assert.match(err[0] as string, /^drove diagnose: no findings in run /)
})

test('findings print one line each, end with the summary, and the summary is on stderr too', async () => {
  const { deps, run } = await world([makeSeat('w-a')], [ev(1, 'guard.denied', 'w-a', { rule: 'owns', path: 'src/a.ts' }), ev(2, 'attention', 'w-a', { reason: 'budget' })])
  process.env.DROVE_HOME = deps.home
  const { code, out, err } = await cli(['diagnose', run.id])
  assert.equal(code, 0)
  const lines = (out[0] as string).split('\n')
  assert.match(lines[0] as string, /^scope-too-narrow · w-a · medium · 1 owns denial \(src\/a\.ts\) · .* \(where: brief\)$/)
  assert.match(lines[1] as string, /^budget-hit · w-a · high · /)
  assert.equal(lines.at(-1), err[0])
  assert.match(err[0] as string, /2 findings on 1 seat in run .*: 1 scope-too-narrow, 1 budget-hit/)
})

test('AC5: --json prints the findings as an array', async () => {
  const { deps, run } = await world([makeSeat('w-a')], [ev(1, 'guard.denied', 'w-a', { rule: 'owns', path: 'src/a.ts' })])
  process.env.DROVE_HOME = deps.home
  const found = await cli(['diagnose', run.id, '--json'])
  assert.equal(found.code, 0)
  const parsed = JSON.parse(found.out[0] as string) as Finding[]
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed[0]?.category, 'scope-too-narrow')
  const clean = await world([makeSeat('w-a')], [])
  process.env.DROVE_HOME = clean.deps.home
  assert.deepEqual(JSON.parse((await cli(['diagnose', clean.run.id, '--json'])).out[0] as string), [])
})

test('a missing run is an error; drove report points to diagnose only when there are findings', async () => {
  const { deps, run } = await world([makeSeat('w-a')], [ev(1, 'guard.denied', 'w-a', { rule: 'owns', path: 'src/a.ts' })])
  assert.equal(await diagnoseRun(deps, 'nope'), undefined)
  assert.equal((await commands.diagnose(deps, { run: 'nope', repo: '/' }, false)).ok, false)
  const withFindings = await commands.runReport(deps, { run: run.id, repo: '/' }, false)
  assert.ok(withFindings.ok && withFindings.text.endsWith(`1 finding on why this run needed rework: drove diagnose ${run.id}`))
  const clean = await world([makeSeat('w-a')], [])
  const quiet = await commands.runReport(clean.deps, { run: clean.run.id, repo: '/' }, false)
  assert.ok(quiet.ok && !quiet.text.includes('drove diagnose'))
  assert.equal(renderDiagnosis({ run: 'r', findings: [], summary: 's' }), 'no findings')
})
