import assert from 'node:assert/strict'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { codexHomeDir, seatDir } from '../src/paths.ts'
import { loadRoster, updateRoster } from '../src/roster.ts'
import { appendJsonl } from '../src/store.ts'
import type { Deps, Identity, Report } from '../src/types.ts'
import { FakeHerdr, git, makeDeps, makeRepo, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const planner = (deps: Deps): Identity => ({ home: deps.home, run: RUN, role: 'planner', seat: 'planner' })

const setup = async (fake = new FakeHerdr()) => {
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo)
  return { fake, repo, deps, identity: planner(deps) }
}

const brief = 'Build the widget.'

const readEvents = async (deps: Deps) =>
  (await readFile(join(deps.home, 'runs', RUN, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; seat?: string; data?: Record<string, unknown> })

const report = (seat: string, index: number): Report => ({
  v: 1, id: `r-${index}`, run: RUN, seat, token: 'secret-token-value', kind: index === 4 ? 'question' : 'progress', expects: index === 4 ? 'answer' : 'none',
  summary: `summary ${index}`, ...(index === 4 ? { details: 'which cache?' } : {}), at: `2026-10-09T10:0${index}:00.000Z`,
})

// Leaves a seat mid-task: one commit on its branch, one uncommitted file, four reports, and idle at a usage limit.
const leaveWork = async (deps: Deps, worktree: string, seat: string) => {
  await writeFile(join(worktree, 'widget.ts'), 'export const widget = 1\n')
  await git(worktree, 'add', 'widget.ts')
  await git(worktree, 'commit', '-qm', 'feat: half a widget')
  await writeFile(join(worktree, 'widget.ts'), 'export const widget = 2\n')
  await writeFile(join(worktree, 'notes.md'), 'todo\n')
  for (const index of [1, 2, 3, 4]) await appendJsonl(join(seatDir(deps.home, RUN, seat), 'outbox.jsonl'), report(seat, index))
  await updateRoster(deps.home, RUN, roster => ({
    ...roster,
    seats: roster.seats.map(entry => ({ ...entry, state: 'blocked' as const, attention: [{ seat, reason: 'usage-limit' as const, detail: 'hit its usage limit', at: '2026-10-09T10:05:00.000Z' }] })),
  }))
}

const startsOf = (fake: FakeHerdr) => fake.calls.filter(call => call[1] === 'agent' && call[2] === 'start')
const agentArgv = (call: string[] | undefined) => (call ?? []).slice((call ?? []).indexOf('--') + 1)

test('migrate claude to codex: same seat, worktree and branch, codex with -C and the run CODEX_HOME, a handoff brief, migratedFrom and seat.migrate', async () => {
  const { fake, deps, identity, repo } = await setup()
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', cairn: 'DROVE-5', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const worktree = join(repo, '.claude', 'worktrees', 'w-api')
  const before = (await loadRoster(deps.home, RUN)).seats[0]
  await leaveWork(deps, worktree, 'w-api')

  const migrated = await commands.migrate(deps, identity, { seat: 'w-api', kind: 'codex', reason: 'Claude usage limit' })
  assert.equal(migrated.ok, true, migrated.text)

  assert.ok(!fake.prompts.some(item => item.text === '/exit' || item.text === '/quit'), 'a claude seat is stopped by closing its pane')
  assert.ok(fake.calls.some(call => call[1] === 'pane' && call[2] === 'close' && call[3] === before?.paneId))
  const start = startsOf(fake)[1]
  assert.equal(start?.[start.indexOf('--kind') + 1], 'codex')
  const argv = agentArgv(start)
  assert.equal(argv[argv.indexOf('-C') + 1], worktree)
  assert.ok(!argv.includes('resume'), 'no resume: the new kind starts fresh')
  const placed = fake.calls.filter(call => call[1] === 'tab' && call[2] === 'create').at(-1) ?? []
  assert.equal(placed[placed.indexOf('--cwd') + 1], worktree)
  assert.ok(placed.includes(`CODEX_HOME=${await realpath(codexHomeDir(deps.home, RUN))}`), placed.join(' '))
  assert.ok(placed.some(arg => arg.endsWith('DROVE_AGENT=codex')))

  const seat = (await loadRoster(deps.home, RUN)).seats.find(entry => entry.name === 'w-api')
  assert.deepEqual([seat?.kind, seat?.worktree, seat?.branch, seat?.cairn, seat?.effort], ['codex', worktree, 'worktree-w-api', 'DROVE-5', before?.effort])
  assert.equal(seat?.codexHome, codexHomeDir(deps.home, RUN))
  assert.notEqual(seat?.sessionId, before?.sessionId)
  assert.deepEqual(seat?.attention, [])
  assert.equal(seat?.restartingSince, undefined)
  assert.deepEqual(seat?.migratedFrom, { kind: 'claude', sessionId: before?.sessionId, model: before?.model, at: seat?.migratedFrom?.at, reason: 'Claude usage limit' })
  assert.equal(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'worktree-w-api')

  const event = (await readEvents(deps)).find(item => item.type === 'seat.migrate')
  assert.deepEqual(event?.data && { from: event.data.from, to: event.data.to, branch: event.data.branch, worktree: event.data.worktree, reason: event.data.reason }, { from: 'claude', to: 'codex', branch: 'worktree-w-api', worktree, reason: 'Claude usage limit' })

  const handoff = fake.prompts.at(-1)?.text ?? ''
  assert.match(handoff, /You replace a claude worker that hit its usage limit \(or was migrated\); its turn in flight is lost\. Reason: Claude usage limit\./)
  assert.ok(!handoff.includes('# Worker mode'), 'the role reaches codex through its home, not the brief')
  assert.match(await readFile(join(codexHomeDir(deps.home, RUN), 'config.toml'), 'utf8'), /developer_instructions = "# Worker mode/)
  assert.match(handoff, /Build the widget\. \(You are worker `w-api` on branch `worktree-w-api`\. Your Cairn task is DROVE-5/)
  assert.match(handoff, /feat: half a widget/)
  assert.match(handoff, /git diff --stat HEAD\)\n widget\.ts \| 2 \+-/)
  assert.match(handoff, /\?\? notes\.md/)
  assert.ok(!handoff.includes('summary 1'), 'only the last three reports')
  assert.match(handoff, /summary 2[\s\S]*summary 3[\s\S]*question \(expects answer\): summary 4\n  which cache\?/)
  assert.ok(!handoff.includes('secret-token-value'))
})

test('migrate codex to claude: claude starts in the Drove worktree with --session-id, no --worktree and no --resume, and keeps drove/<seat>', async () => {
  const fake = new FakeHerdr({ startSession: 'thread-old', startStatus: 'idle' })
  const { deps, identity, repo } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-cx', kind: 'codex', brief })
  assert.equal(spawned.ok, true, spawned.text)
  const worktree = join(repo, '.claude', 'worktrees', 'w-cx')
  await leaveWork(deps, worktree, 'w-cx')
  const saved = join(seatDir(deps.home, RUN, 'w-cx'), 'brief.md')
  await writeFile(saved, `# Worker mode\n\nAn older role.\n\nMessages from the planner arrive as a header and a line that says how to reply.\n\n${await readFile(saved, 'utf8')}`)
  fake.startSession = undefined

  const migrated = await commands.migrate(deps, identity, { seat: 'w-cx', kind: 'claude', model: 'opus', effort: 'high' })
  assert.equal(migrated.ok, true, migrated.text)

  assert.equal(fake.prompts[0]?.text, '/quit')
  const start = startsOf(fake)[1]
  assert.equal(start?.[start.indexOf('--kind') + 1], 'claude')
  const argv = agentArgv(start)
  assert.ok(!argv.includes('--worktree'))
  assert.ok(!argv.includes('--resume'))
  assert.ok(argv.includes('--append-system-prompt-file'))
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-opus-5-5')
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high')
  const placed = fake.calls.filter(call => (call[1] === 'tab' && call[2] === 'create') || (call[1] === 'pane' && call[2] === 'split')).at(-1) ?? []
  assert.equal(placed[placed.indexOf('--cwd') + 1], worktree)
  assert.ok(placed.some(arg => arg.endsWith('DROVE_AGENT=claude')))
  assert.ok(!placed.some(arg => arg.includes('CODEX_HOME=')))

  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.kind, seat?.model, seat?.effort, seat?.branch], ['claude', 'claude-opus-5-5', 'high', 'drove/w-cx'])
  assert.equal(argv[argv.indexOf('--session-id') + 1], seat?.sessionId)
  assert.equal(seat?.codexHome, undefined)
  assert.deepEqual(seat?.migratedFrom && [seat.migratedFrom.kind, seat.migratedFrom.sessionId], ['codex', 'thread-old'])
  assert.equal(await git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'drove/w-cx')

  const handoff = fake.prompts.at(-1)?.text ?? ''
  assert.match(handoff, /You replace a codex worker that hit its usage limit \(or was migrated\)/)
  assert.ok(!handoff.includes('# Worker mode'), 'a role saved in front of an older codex brief is cut')
  assert.match(handoff, /## The brief it was given\nBuild the widget\./)
})

test('migrate releases Cairn as the pre-migration runtime, and skips it without Cairn (DROVE-162)', async () => {
  const previous = process.env.CAIRN_AGENT
  delete process.env.CAIRN_AGENT
  try {
    for (const [from, to, useCairn, expected] of [['codex', 'claude', true, 'codex'], ['claude', 'codex', true, 'claude-code'], ['codex', 'claude', false, undefined]] as const) {
      const { deps, identity } = await setup()
      const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: from, cairn: 'DROVE-5', brief })
      assert.equal(spawned.ok, true, spawned.text)
      if (!useCairn) {
        const path = join(deps.home, 'runs', RUN, 'run.json')
        const run = JSON.parse(await readFile(path, 'utf8'))
        await writeFile(path, JSON.stringify({ ...run, useCairn: false }))
      }
      const base = deps.exec
      const released: { argv: string[]; agent: string | undefined }[] = []
      deps.exec = async (argv, options) => {
        if (argv[0] !== 'cairn') return base(argv, options)
        if (argv[1] === 'release') released.push({ argv: [...argv], agent: options?.env?.CAIRN_AGENT })
        return { code: 0, stdout: '', stderr: '' }
      }
      const migrated = await commands.migrate(deps, identity, { seat: 'w-api', kind: to })
      assert.equal(migrated.ok, true, migrated.text)
      assert.deepEqual(released, expected ? [{ argv: ['cairn', 'release', 'DROVE-5', '--force'], agent: expected }] : [])
      if (useCairn) assert.match(migrated.text, /Released the Cairn claim on DROVE-5/)
    }
  } finally {
    if (previous === undefined) delete process.env.CAIRN_AGENT
    else process.env.CAIRN_AGENT = previous
  }
})

test('migrate refuses the same kind, an unknown seat, a worker caller and a bad kind, and touches nothing', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const calls = fake.calls.length
  const same = await commands.migrate(deps, identity, { seat: 'w-api', kind: 'claude' })
  assert.equal(same.ok, false)
  assert.match(same.text, /already a claude worker; use promote/)
  assert.equal((await commands.migrate(deps, identity, { seat: 'w-none', kind: 'codex' })).ok, false)
  assert.equal((await commands.migrate(deps, identity, { seat: 'w-api', kind: 'gemini' as never })).ok, false)
  assert.equal((await commands.migrate(deps, { ...identity, role: 'worker', seat: 'w-api' }, { seat: 'w-api', kind: 'codex' })).ok, false)
  assert.equal(fake.calls.length, calls)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.kind, 'claude')
})

test('a migrate whose new agent never starts leaves the old kind on the seat, gone, with a hint to resume or retry', async () => {
  const { fake, deps, identity } = await setup()
  await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  const before = (await loadRoster(deps.home, RUN)).seats[0]
  fake.startFails = 'agent_start_failed'
  const migrated = await commands.migrate(deps, identity, { seat: 'w-api', kind: 'codex' })
  assert.equal(migrated.ok, false)
  assert.match(migrated.text, /drove up --seat w-api/)
  const seat = (await loadRoster(deps.home, RUN)).seats[0]
  assert.deepEqual([seat?.kind, seat?.sessionId, seat?.state, seat?.migratedFrom], ['claude', before?.sessionId, 'gone', undefined])
  assert.match(seat?.attention[0]?.detail ?? '', /migrate to codex failed/)
  assert.ok(!(await readEvents(deps)).some(item => item.type === 'seat.migrate'))
})

test('handoffText says what is missing instead of leaving a section empty', () => {
  const text = commands.handoffText({ from: 'codex', base: 'main', log: '', diffStat: '', status: '', reports: [] })
  assert.match(text, /^You replace a codex worker that hit its usage limit \(or was migrated\); its turn in flight is lost\. You keep/)
  assert.match(text, /none saved: this seat was spawned before Drove saved briefs/)
  assert.match(text, /git log --oneline main\.\.HEAD\)\n\(none\)/)
  assert.match(text, /git status --short\n\(clean\)/)
})
