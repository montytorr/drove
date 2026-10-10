import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { main } from '../src/cli.ts'
import * as commands from '../src/commands.ts'
import { plannerDir, seatDir } from '../src/paths.ts'
import type { Deps, Identity, Report } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeSeat, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => {
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_HOME']) delete process.env[key]
})

const planner = (deps: Deps): Identity => ({ home: deps.home, run: RUN, role: 'planner', seat: 'planner' })
const ref = { run: RUN, repo: '/nowhere' }

const report = (seat: string, n: number, overrides: Partial<Report> = {}): Report => ({
  v: 1, id: `r-${seat}-${n}`, run: RUN, seat, token: `token-${seat}`, kind: 'done', expects: 'review',
  summary: `${seat} summary ${n}`, details: `${seat} details ${n}: branch, files, 12 tests pass`, at: `2026-10-09T10:0${n}:00.000Z`, ...overrides,
})

const file = async (deps: Deps, seat: string, ...reports: Report[]) => {
  for (const item of reports) await appendFile(join(seatDir(deps.home, RUN, seat), 'outbox.jsonl'), `${JSON.stringify(item)}\n`)
}

const idsOf = (text: string): string[] => (JSON.parse(text) as { reports: Report[] }).reports.map(item => item.id)

const setup = async () => {
  const deps = await makeDeps(new FakeHerdr())
  await seedRun(deps, '/nowhere', [makeSeat('w-auth'), makeSeat('w-api')])
  return deps
}

test('reports returns the unread reports in full, oldest first, then marks them read', async () => {
  const deps = await setup()
  await file(deps, 'w-auth', report('w-auth', 1), report('w-auth', 3, { kind: 'progress', expects: 'none' }))
  await file(deps, 'w-api', report('w-api', 2))
  const first = await commands.reports(deps, planner(deps), ref, {})
  assert.equal(first.ok, true, first.text)
  assert.match(first.text, /^\[worker w-auth · done · expects review\]\nw-auth summary 1\nw-auth details 1: branch, files, 12 tests pass\n→ Review the work/)
  assert.ok(first.text.indexOf('w-api summary 2') > first.text.indexOf('w-auth summary 1'))
  assert.ok(!first.text.includes('summary 3'), 'progress reports are not listed')
  assert.deepEqual(JSON.parse(await readFile(join(plannerDir(deps.home, RUN), 'reports-read.json'), 'utf8')), ['r-w-auth-1', 'r-w-api-2'])
  assert.equal((await commands.reports(deps, planner(deps), ref, {})).text, 'no unread reports')
  await file(deps, 'w-api', report('w-api', 4, { kind: 'question', expects: 'answer', summary: 'Which port?' }))
  const json = await commands.reports(deps, planner(deps), ref, { asJson: true })
  const parsed = JSON.parse(json.text) as { run: string; reports: Record<string, unknown>[] }
  assert.equal(parsed.run, RUN)
  assert.deepEqual(parsed.reports.map(item => item.id), ['r-w-api-4'])
  assert.equal(parsed.reports[0]?.summary, 'Which port?')
  assert.equal('token' in (parsed.reports[0] ?? {}), false)
})

test('reports for one seat gives its unread reports, else its latest; --all lists every report', async () => {
  const deps = await setup()
  await file(deps, 'w-auth', report('w-auth', 1), report('w-auth', 2))
  await file(deps, 'w-api', report('w-api', 3))
  assert.deepEqual(idsOf((await commands.reports(deps, planner(deps), ref, { seat: 'w-auth', asJson: true })).text), ['r-w-auth-1', 'r-w-auth-2'])
  assert.deepEqual(idsOf((await commands.reports(deps, planner(deps), ref, { seat: 'w-auth', asJson: true })).text), ['r-w-auth-2'])
  assert.deepEqual(idsOf((await commands.reports(deps, planner(deps), ref, { asJson: true })).text), ['r-w-api-3'])
  assert.deepEqual(idsOf((await commands.reports(deps, planner(deps), ref, { all: true, asJson: true })).text), ['r-w-auth-1', 'r-w-auth-2', 'r-w-api-3'])
  assert.deepEqual(JSON.parse(await readFile(join(plannerDir(deps.home, RUN), 'reports-read.json'), 'utf8')), ['r-w-auth-1', 'r-w-auth-2', 'r-w-api-3'])
  const missing = await commands.reports(deps, planner(deps), ref, { seat: 'w-nope' })
  assert.deepEqual([missing.ok, missing.ok ? '' : missing.code], [false, 'no-seat'])
})

test('reports skips a forged report and refuses a worker', async () => {
  const deps = await setup()
  await file(deps, 'w-auth', report('w-auth', 1, { token: 'stolen' }), report('w-api', 2), report('w-auth', 3))
  assert.deepEqual(idsOf((await commands.reports(deps, planner(deps), ref, { asJson: true })).text), ['r-w-auth-3'])
  const worker = await commands.reports(deps, { home: deps.home, run: RUN, role: 'worker', seat: 'w-api', token: 'token-w-api' }, ref, {})
  assert.deepEqual([worker.ok, worker.ok ? '' : worker.code], [false, 'forbidden'])
})

test('drove reports prints the unread reports, as JSON with --json', async () => {
  const deps = await setup()
  await file(deps, 'w-auth', report('w-auth', 1))
  process.env.DROVE_HOME = deps.home
  const out: string[] = []
  const io = { out: (text: string) => out.push(text), err: (text: string) => out.push(text), stdin: async () => '' }
  assert.equal(await main(['reports', '--json', '--run', RUN], io), 0)
  assert.deepEqual((JSON.parse(out[0] ?? '') as { reports: Report[] }).reports.map(item => item.details), ['w-auth details 1: branch, files, 12 tests pass'])
  assert.equal(await main(['reports', 'w-auth', '--run', RUN], io), 0)
  assert.match(out[1] ?? '', /^\[worker w-auth · done · expects review\]/)
})
