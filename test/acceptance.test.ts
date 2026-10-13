import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { beforeEach, test } from 'node:test'
import { COMMANDS, spawnRequestOf } from '../src/cli.ts'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { seatDir } from '../src/paths.ts'
import * as prompts from '../src/prompts.ts'
import * as protocol from '../src/protocol.ts'
import { loadRoster } from '../src/roster.ts'
import { readJsonlFrom } from '../src/store.ts'
import { plannerTools, workerTools } from '../src/tools.ts'
import type { Deps, DroveConfig, Identity, Report, RunMeta } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, makeSeat, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_OWNS', 'DROVE_SEAT_ROLE', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const EMPTY_ACCEPTANCE = '--acceptance takes non-empty statements, one per criterion'
const GWT = ['Given a spec with two items, when a seat is spawned, then its brief lists both', 'Given a done report with criteria, then the planner sees each one']

const setup = async () => {
  const fake = new FakeHerdr()
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo, [])
  const identity: Identity = { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }
  return { fake, repo, deps, identity }
}

const savedBrief = (deps: Deps, seat: string): Promise<string> => readFile(join(seatDir(deps.home, RUN, seat), 'brief.md'), 'utf8')
const seatOf = async (deps: Deps, name: string) => (await loadRoster(deps.home, RUN)).seats.find(seat => seat.name === name)

test('AC1: acceptance is numbered AC1…ACn into the brief, kept on the seat, and shown to a reviewer and a tester of it', async () => {
  const { deps, identity } = await setup()
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief: 'Build the widget.', acceptance: GWT })
  assert.equal(spawned.ok, true, spawned.text)
  const text = await savedBrief(deps, 'w-api')
  assert.match(text, /^Build the widget\.\n\n## Acceptance\n- AC1: Given a spec with two items.*\n- AC2: Given a done report with criteria.*\n/)
  assert.ok(text.indexOf('## Acceptance') < text.indexOf('You are worker `w-api`'), 'the criteria come before the footer')
  assert.deepEqual((await seatOf(deps, 'w-api'))?.acceptance, GWT)

  const reviewed = await commands.spawn(deps, identity, { seat: 'r-api', kind: 'claude', brief: 'Review it.', role: 'reviewer', target: 'w-api' })
  assert.equal(reviewed.ok, true, reviewed.text)
  const reviewerBrief = await savedBrief(deps, 'r-api')
  assert.match(reviewerBrief, /## Acceptance\nThe acceptance criteria of seat `w-api`, which you review:\n- AC1: .*\n- AC2: /)
  assert.deepEqual((await seatOf(deps, 'r-api'))?.acceptance, GWT)

  const tested = await commands.spawn(deps, identity, { seat: 't-api', kind: 'claude', brief: 'Test it.', role: 'tester', target: 'w-api' })
  assert.equal(tested.ok, true, tested.text)
  assert.match(await savedBrief(deps, 't-api'), /## Acceptance\nThe acceptance criteria of seat `w-api`, which you test:\n- AC1: /)
})

test('a reviewer given its own acceptance keeps it, and a seat without any has no section', async () => {
  const { deps, identity } = await setup()
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief: 'Build.' })).ok, true)
  assert.doesNotMatch(await savedBrief(deps, 'w-api'), /## Acceptance/)
  assert.equal((await seatOf(deps, 'w-api'))?.acceptance, undefined)
  const own = await commands.spawn(deps, identity, { seat: 'r-api', kind: 'claude', brief: 'Review.', role: 'reviewer', target: 'w-api', acceptance: ['The diff touches only src/'] })
  assert.equal(own.ok, true, own.text)
  assert.match(await savedBrief(deps, 'r-api'), /## Acceptance\n- AC1: The diff touches only src\/\n/)
})

test('empty acceptance statements are refused before anything is created', async () => {
  const { deps, identity } = await setup()
  const result = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief: 'Build.', acceptance: ['fine', '  '] })
  assert.equal(result.ok, false)
  assert.equal(result.text, EMPTY_ACCEPTANCE)
  assert.equal(await seatOf(deps, 'w-api'), undefined)
})

test('acceptance survives a migrate: the handoff brief carries it and the seat keeps it', async () => {
  const { fake, deps, identity } = await setup()
  assert.equal((await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief: 'Build the widget.', acceptance: GWT })).ok, true)
  const before = await seatOf(deps, 'w-api')
  const migrated = await commands.migrate(deps, identity, { seat: 'w-api', kind: 'codex', reason: 'usage limit' })
  assert.equal(migrated.ok, true, migrated.text)
  assert.deepEqual((await seatOf(deps, 'w-api'))?.acceptance, before?.acceptance)
  const handoff = fake.prompts.at(-1)?.text ?? ''
  assert.match(handoff, /## The brief it was given\nBuild the widget\.\n\n## Acceptance\n- AC1: /)
})

test('--acceptance is repeatable on the CLI and keeps the commas inside a statement', () => {
  assert.match(COMMANDS.spawn?.usage ?? '', /--acceptance TEXT/)
  const { values, positionals } = parseArgs({
    args: ['w-api', '--kind', 'claude', '--brief', 'x', '--acceptance', 'Given a, when b, then c', '--acceptance=AC two'],
    options: COMMANDS.spawn?.options ?? {},
    allowPositionals: true,
    strict: true,
  })
  const request = spawnRequestOf(values as Parameters<typeof spawnRequestOf>[0], positionals, 'x')
  assert.deepEqual(request.acceptance, ['Given a, when b, then c', 'AC two'])
  assert.equal('acceptance' in spawnRequestOf({ kind: 'claude' } as never, ['w-api'], 'x'), false)
})

test('the spawn tool passes acceptance through', async () => {
  const calls: unknown[] = []
  const fake = { spawn: async (_deps: unknown, _identity: unknown, request: unknown) => (calls.push(request), { ok: true, text: 'ok' }) }
  const { deps } = await setup()
  const tools = plannerTools(deps, { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }, {
    ...(await import('../src/tools.ts')).defaultToolPorts,
    commands: { ...commands, ...fake } as never,
  })
  const spawn = tools.find(tool => tool.name === 'spawn')
  await spawn?.call({ seat: 'w-ui', kind: 'claude', brief: 'x', acceptance: ['Given a, when b, then c'] })
  assert.deepEqual((calls[0] as { acceptance: string[] }).acceptance, ['Given a, when b, then c'])
  assert.equal((await spawn?.call({ seat: 'w-db', kind: 'claude', brief: 'x', acceptance: 'one' }))?.isError, true)
  const empty = await spawn?.call({ seat: 'w-db', kind: 'claude', brief: 'x', acceptance: ['fine', ' '] })
  assert.equal(empty?.isError, true)
  assert.equal(empty?.text, EMPTY_ACCEPTANCE, 'the same message as drove spawn')
  assert.equal(calls.length, 1)
})

// ---------- criteria in reports ----------

const base = { v: 1 as const, id: 'r-1', run: RUN, seat: 'w-api', token: 't', summary: 'all green', at: '2026-10-09T10:20:53.000Z' }

test('AC2: a done report with criteria shows each as met or unmet with its evidence', () => {
  const text = protocol.renderReport(
    { ...base, kind: 'done', expects: 'review', acceptance: 2, criteria: [{ id: 'AC1', met: true, evidence: 'npm test: 12 pass' }, { id: 'AC2', met: false, evidence: 'no test for the empty case' }] },
    'Sam',
  )
  assert.match(text, /\nCriteria: 1 of 2 met\n- AC1 met: npm test: 12 pass\n- AC2 UNMET: no test for the empty case\n→ Review the work/)
  assert.doesNotMatch(text, /Drove: /)
})

test('AC3: a seat with criteria and a done report without them gets the reminder line', () => {
  const none = protocol.renderReport({ ...base, kind: 'done', expects: 'review', acceptance: 2 }, 'Sam')
  assert.match(none, /Drove: this seat has 2 acceptance criteria \(AC1…AC2\) and its done report has no criteria\. Ask for them/)
  const partial = protocol.renderReport({ ...base, kind: 'done', expects: 'review', acceptance: 3, criteria: [{ id: 'AC1', met: true, evidence: 'e' }] }, 'Sam')
  assert.match(partial, /Drove: the report leaves AC2, AC3 unanswered\./)
  // The confirmation after an approval, a question and a seat without criteria say nothing.
  assert.doesNotMatch(protocol.renderReport({ ...base, kind: 'done', expects: 'none', acceptance: 2 }, 'Sam'), /Drove: /)
  assert.doesNotMatch(protocol.renderReport({ ...base, kind: 'question', expects: 'answer', acceptance: 2 }, 'Sam'), /Drove: /)
  assert.doesNotMatch(protocol.renderReport({ ...base, kind: 'done', expects: 'review' }, 'Sam'), /Drove: |Criteria/)
})

test('validateReport takes criteria on done only, and checks their shape', () => {
  const ok = protocol.validateReport({ kind: 'done', summary: 's', criteria: [{ id: 'AC1', met: true, evidence: ' e ' }] })
  assert.deepEqual(ok.ok && ok.value.criteria, [{ id: 'AC1', met: true, evidence: 'e' }])
  for (const criteria of ['AC1', [{ id: 'one', met: true, evidence: 'e' }], [{ id: 'AC1', met: 'yes', evidence: 'e' }], [{ id: 'AC1', met: true, evidence: ' ' }], [{ id: 'AC1', met: true, evidence: 'x'.repeat(protocol.EVIDENCE_MAX + 1) }]]) {
    assert.equal(protocol.validateReport({ kind: 'done', summary: 's', criteria }).ok, false, JSON.stringify(criteria))
  }
  const twice = protocol.validateReport({ kind: 'done', summary: 's', criteria: [{ id: 'AC1', met: true, evidence: 'a' }, { id: 'AC1', met: false, evidence: 'b' }] })
  assert.deepEqual(twice, { ok: false, error: 'criterion AC1 appears twice' })
  assert.equal(protocol.validateReport({ kind: 'question', summary: 's', criteria: [] }).ok, true)
  assert.equal(protocol.validateReport({ kind: 'question', summary: 's', criteria: [{ id: 'AC1', met: true, evidence: 'e' }] }).ok, false)
  assert.equal(protocol.validateReport({ kind: 'done', summary: 's' }).ok && 'criteria' in (protocol.validateReport({ kind: 'done', summary: 's' }) as { value: object }).value, false)
})

test('the worker report tool takes criteria and stamps the number of criteria its seat has; the planner reads both', async () => {
  const { deps } = await setupSeatWithAcceptance()
  const identity: Identity = { home: deps.home, run: RUN, role: 'worker', seat: 'w-api', token: 'token-w-api' }
  const [report] = workerTools(deps, identity)
  const schema = report?.inputSchema as { properties: Record<string, { type: string }> }
  assert.equal(schema.properties.criteria?.type, 'array')
  const asked = await report?.call({ kind: 'done', summary: 'built' })
  assert.equal(asked?.isError, undefined)
  const answered = await report?.call({ kind: 'done', summary: 'built', criteria: [{ id: 'AC1', met: true, evidence: 'npm test' }, { id: 'AC2', met: false, evidence: 'not yet' }] })
  assert.equal(answered?.isError, undefined)
  const outbox = (await readJsonlFrom<Report>(join(seatDir(deps.home, RUN, 'w-api'), 'outbox.jsonl'), { offset: 0 })).items
  assert.deepEqual(outbox.map(item => item.acceptance), [2, 2])
  assert.equal(outbox[0]?.criteria, undefined)

  const planner: Identity = { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }
  const read = await commands.reports(deps, planner, { run: RUN, repo: '/nowhere' }, {})
  assert.match(read.text, /Drove: this seat has 2 acceptance criteria/)
  assert.match(read.text, /Criteria: 1 of 2 met\n- AC1 met: npm test\n- AC2 UNMET: not yet/)
})

const setupSeatWithAcceptance = async () => {
  const deps = await makeDeps(new FakeHerdr())
  await seedRun(deps, '/nowhere', [makeSeat('w-api', { acceptance: GWT })])
  return { deps }
}

// ---------- the role texts ----------

const run = { id: 'drove-20261009-1042-a3f1' } as RunMeta
const config = { humanName: 'Sam', workerModel: { claude: 'claude-sonnet-5-5', codex: 'gpt-5' }, promotedModel: { claude: 'claude-opus-5-5', codex: 'gpt-5' }, budget: 5 } as DroveConfig

test('AC4: each worker role is an SOP with Overview, Steps and MUST / MUST NOT / SHOULD / MAY constraints', () => {
  for (const role of ['implementer', 'reviewer', 'tester'] as const) {
    const text = prompts.workerRole(run, config, role)
    for (const heading of ['## Overview', '## Steps', '## Constraints', '### MUST', '### MUST NOT', '### SHOULD', '### MAY']) assert.ok(text.includes(`\n${heading}\n`), `${role} has ${heading}`)
    assert.match(text, /### MUST\n(?:- [^\n]*\n)*- Address every acceptance criterion[^.\n]*done report/, `${role} answers every criterion under MUST`)
  }
  for (const role of ['implementer', 'tester'] as const) {
    assert.match(prompts.workerRole(run, config, role), /### MUST NOT\n(?:- [^\n]*\n)*- Report `done` while the repo's checks fail[^.]*; report `blocked` or a `question` instead, naming what fails\./)
  }
  assert.match(prompts.workerRole(run, config, 'reviewer'), /- Report `done` on a review whose checks you could not run; report `blocked` or a `question` instead, naming what fails\./)
})

// The mod's prompts file cannot be imported by node (extensionless imports), so both planner texts are compared as source:
// the worker roles are one text in src/prompts.ts that the mod reuses, and the planner section is a copy in mod/hooks/prompts.ts.
test('AC4: the planner texts in src and in the mod say the same rules about acceptance and criteria', () => {
  const src = readFileSync(new URL('../src/prompts.ts', import.meta.url), 'utf8')
  const mod = readFileSync(new URL('../mod/hooks/prompts.ts', import.meta.url), 'utf8')
  const rules = [
    'write them as Given-When-Then statements${cairn ? \' in the task body\' : \'\'} and pass them as \\`acceptance\\`: Drove numbers them AC1…ACn, writes them into the brief, and the worker answers each in its done report; a reviewer or tester spawned with its own \\`acceptance\\` sees only those, so leave it out to give it the target\'s',
    'check it against the brief and each acceptance criterion (the done report lists them as \\`criteria\\`, met or unmet with evidence; a criterion it leaves unmet or unanswered is \\`changes\\`)',
  ]
  for (const rule of rules) {
    assert.ok(src.includes(rule), `src: ${rule}`)
    assert.ok(mod.includes(rule), `mod: ${rule}`)
  }
  assert.match(prompts.plannerRole(run, config, 'claude'), /pass them as `acceptance`/)
  assert.equal((mod.match(/\bworkerRole\b/g) ?? []).length, 0, 'the mod does not carry a worker role text of its own')
})
