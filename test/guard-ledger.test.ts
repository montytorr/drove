import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decide } from '../src/guard.ts'
import * as hooks from '../src/hooks.ts'
import { runDir, seatDir } from '../src/paths.ts'
import { updateRoster } from '../src/roster.ts'
import { buildReport, renderReport } from '../src/report.ts'
import { thrashLimits, thrashOf } from '../src/thrash.ts'
import { createWatcher, BATCH_MS } from '../src/watch.ts'
import * as board from '../src/board.ts'
import * as web from '../src/web.ts'
import type { DroveEvent, GuardInput, GuardRule, Identity, RunMeta, Seat } from '../src/types.ts'
import { isForHuman } from '../mod/hooks/roster.ts'
import { feedOf } from '../mod/hooks/bridge.ts'
import { eventsOf, fakePorts, fileReport, rosterOf, setup } from './p4-helpers.ts'
import type { Ctx } from './p4-helpers.ts'
import { makeDeps, makeSeat, RUN, seedRun, FakeHerdr, tmp } from './p3-helpers.ts'

const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'drove-ledger-')))
writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/w-api\n')
mkdirSync(join(worktree, 'src'), { recursive: true })

const base = { agent: 'claude' as const, cwd: worktree, writableRoots: ['/tmp'], openSeats: ['w-ui'] }
const input = (overrides: Partial<GuardInput>): GuardInput => ({ ...base, role: 'planner', tool: 'Bash', input: {}, ...overrides })
const bash = (role: GuardInput['role'], command: string, extra: Partial<GuardInput> = {}) => input({ role, tool: 'Bash', input: { command }, ...extra })

// ---------- rules and next steps (AC3) ----------

const CASES: { name: string; rule: GuardRule; call: GuardInput }[] = [
  { name: 'a worker edit outside its owns', rule: 'owns', call: input({ role: 'worker', tool: 'Edit', input: { file_path: join(worktree, 'docs/a.md') }, owns: ['src/**'] }) },
  { name: 'a worker redirect outside its owns', rule: 'owns', call: bash('worker', 'echo x > docs/a.md', { owns: ['src/**'] }) },
  { name: 'a reviewer edit', rule: 'reviewer-readonly', call: input({ role: 'worker', seatRole: 'reviewer', tool: 'Edit', input: { file_path: join(worktree, 'src/a.ts') } }) },
  { name: 'a reviewer git commit', rule: 'reviewer-readonly', call: bash('worker', 'git commit -m x', { seatRole: 'reviewer' }) },
  { name: 'a reviewer rm', rule: 'reviewer-readonly', call: bash('worker', 'rm src/a.ts', { seatRole: 'reviewer' }) },
  { name: 'a planner edit', rule: 'planner-edit', call: input({ tool: 'Edit', input: { file_path: '/work/repo/src/a.ts' } }) },
  { name: 'a planner apply_patch', rule: 'planner-edit', call: input({ tool: 'apply_patch', input: { patch: '*** Begin Patch\n*** Update File: /work/repo/src/a.ts\n*** End Patch' } }) },
  { name: 'a planner rm', rule: 'planner-shell', call: bash('planner', 'rm -rf src') },
  { name: 'a planner npm install', rule: 'planner-shell', call: bash('planner', 'npm install left-pad') },
  { name: 'a planner redirect', rule: 'planner-shell', call: bash('planner', 'echo x > /work/repo/src/a.ts') },
  { name: 'a worker push', rule: 'push', call: bash('worker', 'git push origin HEAD') },
  { name: 'a planner push --all', rule: 'production', call: bash('planner', 'git push --all') },
  { name: 'a planner gh pr create on production', rule: 'production', call: bash('planner', 'gh pr create --base production --title t --body b') },
  { name: 'a worker herdr write', rule: 'herdr', call: bash('worker', 'herdr pane split') },
  { name: 'a planner herdr write', rule: 'herdr', call: bash('planner', 'herdr pane close p1') },
  { name: 'a planner merge of a seat branch', rule: 'merge-gate', call: bash('planner', 'git merge worktree-w-api') },
  { name: 'a planner merge --no-checks', rule: 'merge-gate', call: bash('planner', 'drove merge w-api --no-checks') },
  { name: 'a planner gh pr merge', rule: 'merge-gate', call: bash('planner', 'gh pr merge 3') },
  { name: 'a worker claude session', rule: 'agent-launch', call: bash('worker', 'claude -p hi') },
  { name: 'a planner codex exec', rule: 'agent-launch', call: bash('planner', 'codex exec hi') },
  { name: 'a worker drove plan', rule: 'drove-cli', call: bash('worker', 'drove plan') },
  { name: 'a planner drove budget', rule: 'drove-cli', call: bash('planner', 'drove budget 6') },
  { name: 'a planner gh issue delete', rule: 'github', call: bash('planner', 'gh issue delete 3') },
  { name: 'a planner shell call with no command', rule: 'unreadable', call: input({ tool: 'Bash', input: {} }) },
  { name: 'a planner command named by a variable', rule: 'unreadable', call: bash('planner', '$CMD --flag') },
  { name: 'an edit with no path', rule: 'unreadable', call: input({ tool: 'Edit', input: {} }) },
]

test('every denial carries a stable rule and its text ends with one concrete next step', () => {
  for (const { name, rule, call } of CASES) {
    const decision = decide(call)
    assert.equal(decision.allow, false, `${name} is denied`)
    if (decision.allow) continue
    assert.equal(decision.rule, rule, `${name}: rule`)
    if (rule === 'owns') assert.match(decision.reason, /ask the planner with the drove report tool\.$/, name)
    else assert.match(decision.reason, /Next step: [^.]+\.$/, `${name}: ends with a next step`)
  }
})

test('the steps fit the rule: push says the planner merges and pushes, a reviewer reports, the merge gate names drove merge', () => {
  const text = (call: GuardInput) => {
    const decision = decide(call)
    return decision.allow ? '' : decision.reason
  }
  assert.match(text(bash('worker', 'git push')), /Next step: commit your work on your branch and report done; the planner merges and pushes\.$/)
  assert.match(text(bash('worker', 'rm x', { seatRole: 'reviewer' })), /Next step: put what you found in your report/)
  assert.match(text(bash('planner', 'git merge drove/w-api')), /Next step: merge it with the drove merge tool .*drove merge w-api\.$/)
  assert.match(text(bash('planner', 'rm -rf x')), /^Drove planner: rm changes files or processes\. You plan, delegate and review.* Next step: delegate it to a worker with the drove spawn or send tools\.$/)
})

test('no rule is loosened: what the guard allowed before it still allows', () => {
  const allowed = [
    bash('planner', 'git status'),
    bash('planner', 'echo hi > /tmp/note.md'),
    bash('planner', 'git push origin main'),
    bash('worker', 'echo hi > src/a.ts', { owns: ['src/**'] }),
    bash('worker', 'npm test', { seatRole: 'reviewer' }),
    bash('worker', 'git diff main...', { seatRole: 'reviewer' }),
    input({ role: 'worker', tool: 'Edit', input: { file_path: join(worktree, 'src/a.ts') }, owns: ['src/**'] }),
  ]
  for (const call of allowed) assert.equal(decide(call).allow, true, JSON.stringify(call.input))
})

// ---------- ledger and thrash (AC1, AC2) ----------

const edit = (path: string) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: worktree, tool_name: 'Edit', tool_input: { file_path: path } })
const shell = (command: string) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: worktree, tool_name: 'Bash', tool_input: { command } })
const workerEnv = (ctx: Ctx, extra: Record<string, string> = {}) => ({
  DROVE_HOME: ctx.home,
  DROVE_RUN: ctx.run.id,
  DROVE_ROLE: 'worker',
  DROVE_SEAT: 'w-api',
  DROVE_OWNS: JSON.stringify(['src/**']),
  ...extra,
})
const depsOf = (ctx: Ctx): hooks.HookDeps => ({ ...hooks.defaultHookDeps, now: ctx.clock.now })
const thrashItems = async (ctx: Ctx) => (await rosterOf(ctx)).seats.find(seat => seat.name === 'w-api')?.attention.filter(item => item.reason === 'guard-thrash') ?? []

test('AC1: three denials of one rule in ten minutes are three guard.denied events and one guard-thrash item for the planner', async () => {
  const ctx = await setup()
  const env = workerEnv(ctx)
  for (const file of ['docs/a.md', 'docs/b.md', 'docs/c.md']) {
    const result = await hooks.runHook('pre-tool-use', edit(join(worktree, file)), env, depsOf(ctx))
    assert.equal(result.code, 2)
    ctx.clock.advance(60_000)
  }
  assert.equal((await hooks.runHook('pre-tool-use', edit(join(worktree, 'src/ok.ts')), env, depsOf(ctx))).code, 0)
  const events = await eventsOf(ctx)
  const denied = events.filter(event => event.type === 'guard.denied')
  assert.equal(denied.length, 3, 'allows are not recorded')
  assert.deepEqual(denied.map(event => [event.seat, event.data?.rule, event.data?.tool]), [['w-api', 'owns', 'Edit'], ['w-api', 'owns', 'Edit'], ['w-api', 'owns', 'Edit']])
  assert.equal(denied[0]?.data?.path, join(worktree, 'docs/a.md'))
  assert.match(String(denied[0]?.data?.reason), /outside the paths your brief gives you/)
  const raised = events.filter(event => event.type === 'attention' && event.data?.reason === 'guard-thrash')
  assert.equal(raised.length, 1)
  assert.equal(raised[0]?.data?.rule, 'owns')
  assert.equal(raised[0]?.seat, 'w-api')
  const items = await thrashItems(ctx)
  assert.equal(items.length, 1)
  assert.match(items[0]?.detail ?? '', /w-api hit the guard's owns rule 3 times in 10 minutes/)
  assert.match(items[0]?.detail ?? '', /last refusal: \S*docs\/c\.md: this file is outside the paths/)
  assert.equal(isForHuman(items[0] as { reason: string }), false, 'addressed to the planner, not the human')
})

test('the item is raised once per seat and rule: a fourth denial adds an event but no second item', async () => {
  const ctx = await setup()
  const env = workerEnv(ctx)
  for (let i = 0; i < 5; i += 1) {
    await hooks.runHook('pre-tool-use', edit(join(worktree, `docs/${i}.md`)), env, depsOf(ctx))
    ctx.clock.advance(1000)
  }
  const events = await eventsOf(ctx)
  assert.equal(events.filter(event => event.type === 'guard.denied').length, 5)
  assert.equal(events.filter(event => event.type === 'attention').length, 1)
  assert.equal((await thrashItems(ctx)).length, 1)
})

test('another rule raises its own item, and denials of different rules do not add up', async () => {
  const ctx = await setup()
  const env = workerEnv(ctx)
  await hooks.runHook('pre-tool-use', edit(join(worktree, 'docs/a.md')), env, depsOf(ctx))
  await hooks.runHook('pre-tool-use', shell('git push'), env, depsOf(ctx))
  await hooks.runHook('pre-tool-use', edit(join(worktree, 'docs/b.md')), env, depsOf(ctx))
  assert.equal((await thrashItems(ctx)).length, 0, 'two owns and one push is not thrash')
  await hooks.runHook('pre-tool-use', shell('git push origin x'), env, depsOf(ctx))
  await hooks.runHook('pre-tool-use', shell('git push -f'), env, depsOf(ctx))
  const items = await thrashItems(ctx)
  assert.equal(items.length, 1)
  assert.match(items[0]?.detail ?? '', /push rule 3 times/)
  await hooks.runHook('pre-tool-use', edit(join(worktree, 'docs/c.md')), env, depsOf(ctx))
  assert.equal((await thrashItems(ctx)).length, 2)
})

test('denials spread over more than the window never trip it, and guardThrash in config.json changes the limits', async () => {
  const ctx = await setup()
  const env = workerEnv(ctx)
  for (let i = 0; i < 4; i += 1) {
    await hooks.runHook('pre-tool-use', edit(join(worktree, `docs/${i}.md`)), env, depsOf(ctx))
    ctx.clock.advance(6 * 60_000)
  }
  assert.equal((await thrashItems(ctx)).length, 0, 'at most two fall inside any ten minutes')

  await writeFile(join(ctx.home, 'config.json'), JSON.stringify({ guardThrash: { count: 2, minutes: 7 } }))
  await hooks.runHook('pre-tool-use', edit(join(worktree, 'docs/x.md')), env, depsOf(ctx))
  const items = await thrashItems(ctx)
  assert.equal(items.length, 1)
  assert.match(items[0]?.detail ?? '', /2 times in 7 minutes/)
})

test('thrashLimits keeps the default for a part that is not a whole number of at least 1', () => {
  assert.deepEqual(thrashLimits(undefined), { count: 3, minutes: 10 })
  assert.deepEqual(thrashLimits({ count: 5 }), { count: 5, minutes: 10 })
  assert.deepEqual(thrashLimits({ count: 0, minutes: 'ten' }), { count: 3, minutes: 10 })
  assert.deepEqual(thrashLimits({ count: 2.5, minutes: 30 }), { count: 3, minutes: 30 })
})

test('thrashOf counts only denials since the seat last reported, and only once', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 10, minute)).toISOString()
  const denied = (minute: number): DroveEvent => ({ at: at(minute), type: 'guard.denied', seat: 'w-a', data: { rule: 'push', reason: `r${minute}` } })
  const now = Date.parse(at(5))
  const limits = { count: 3, minutes: 10 }
  assert.equal(thrashOf([denied(1), denied(2)], 'w-a', 'push', now, limits), undefined)
  assert.deepEqual(thrashOf([denied(1), denied(2), denied(3)], 'w-a', 'push', now, limits), { seat: 'w-a', rule: 'push', count: 3, minutes: 10, last: 'r3' })
  const report: DroveEvent = { at: at(2), type: 'report', seat: 'w-a', data: { kind: 'progress' } }
  assert.equal(thrashOf([denied(1), report, denied(3), denied(4)], 'w-a', 'push', now, limits), undefined, 'the report starts a new count')
  const raised: DroveEvent = { at: at(4), type: 'attention', seat: 'w-a', data: { reason: 'guard-thrash', rule: 'push' } }
  assert.equal(thrashOf([denied(1), denied(2), denied(3), raised, denied(4)], 'w-a', 'push', now, limits), undefined)
  assert.equal(thrashOf([{ ...denied(1), seat: 'w-b' }, denied(2), denied(3)], 'w-a', 'push', now, limits), undefined, 'another seat does not count')
})

test('AC2: the item survives the watcher polling and clears when the seat next reports', async () => {
  const ctx = await setup()
  const env = workerEnv(ctx)
  for (const file of ['a', 'b', 'c']) {
    await hooks.runHook('pre-tool-use', edit(join(worktree, `docs/${file}.md`)), env, depsOf(ctx))
    ctx.clock.advance(1000)
  }
  assert.equal((await thrashItems(ctx)).length, 1)
  const { ports } = fakePorts()
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  assert.equal((await thrashItems(ctx)).length, 1, 'a poll keeps it')

  await fileReport(ctx, 'w-api', 'progress', 'working around the guard')
  ctx.clock.advance(1000)
  await watcher.tick()
  assert.equal((await thrashItems(ctx)).length, 0, 'any report clears it, a progress one too')
  watcher.stop()

  // a new stretch needs its own three denials
  ctx.clock.advance(1000)
  await hooks.runHook('pre-tool-use', edit(join(worktree, 'docs/d.md')), env, depsOf(ctx))
  assert.equal((await thrashItems(ctx)).length, 0)
})

test('thrashOf also reads the roster: an item the seat still holds is raised, and a report it ingested ends the count', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 12, 10, minute)).toISOString()
  const denied = (minute: number): DroveEvent => ({ at: at(minute), type: 'guard.denied', seat: 'w-a', data: { rule: 'push', reason: `r${minute}` } })
  const now = Date.parse(at(5))
  const limits = { count: 3, minutes: 10 }
  const three = [denied(1), denied(2), denied(3)]
  const held = { seat: 'w-a', reason: 'guard-thrash' as const, detail: "w-a hit the guard's push rule 3 times", at: at(3) }
  assert.equal(thrashOf(three, 'w-a', 'push', now, limits, { attention: [held] }), undefined, 'held in the roster, though the ledger tail has no event for it')
  assert.ok(thrashOf(three, 'w-a', 'push', now, limits, { attention: [{ ...held, detail: "w-a hit the guard's owns rule 3 times" }] }), 'an item of another rule does not count')
  assert.equal(thrashOf(three, 'w-a', 'push', now, limits, { lastReportAt: at(4) }), undefined, 'the roster has a newer report than the denials')
  assert.ok(thrashOf(three, 'w-a', 'push', now, limits, { lastReportAt: at(0) }))
})

test('a busy lock skips the escalation instead of making the denial wait, and the next denial raises it', async () => {
  const ctx = await setup()
  const env = workerEnv(ctx)
  const lock = join(seatDir(ctx.home, ctx.run.id, 'w-api'), 'guard.lock')
  await mkdir(lock, { recursive: true })
  const started = Date.now()
  for (const file of ['a', 'b', 'c']) {
    const result = await hooks.runHook('pre-tool-use', edit(join(worktree, `docs/${file}.md`)), env, depsOf(ctx))
    assert.equal(result.code, 2)
    ctx.clock.advance(1000)
  }
  assert.ok(Date.now() - started < 1500, 'three denials against a held lock took well under the 2 s steal time')
  assert.equal((await eventsOf(ctx)).filter(event => event.type === 'guard.denied').length, 3, 'the denials are still recorded')
  assert.equal((await thrashItems(ctx)).length, 0, 'the escalation was skipped')
  await rm(lock, { recursive: true })
  await hooks.runHook('pre-tool-use', edit(join(worktree, 'docs/d.md')), env, depsOf(ctx))
  assert.equal((await thrashItems(ctx)).length, 1)
})

test('a report already ingested into the roster stops the count even before its event is in the ledger', async () => {
  const ctx = await setup()
  const env = workerEnv(ctx)
  const later = new Date(ctx.clock.now().getTime() + 60_000).toISOString()
  await updateRoster(ctx.home, ctx.run.id, roster => ({
    ...roster,
    seats: roster.seats.map(seat => ({ ...seat, lastReport: { id: 'r1', kind: 'progress' as const, expects: 'none' as const, summary: 's', at: later } })),
  }))
  for (const file of ['a', 'b', 'c']) {
    await hooks.runHook('pre-tool-use', edit(join(worktree, `docs/${file}.md`)), env, depsOf(ctx))
    ctx.clock.advance(1000)
  }
  assert.equal((await thrashItems(ctx)).length, 0)
})

test('a watcher started after the item was raised does not announce it again', async () => {
  const ctx = await setup()
  const env = workerEnv(ctx)
  for (const file of ['a', 'b', 'c']) await hooks.runHook('pre-tool-use', edit(join(worktree, `docs/${file}.md`)), env, depsOf(ctx))
  ctx.clock.advance(60_000)
  const { ports } = fakePorts()
  const restarted = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await restarted.tick()
  assert.equal((await thrashItems(ctx)).length, 1, 'the item is still there')
  ctx.clock.advance(1000)
  await fileReport(ctx, 'w-api', 'done', 'finished anyway')
  await restarted.tick()
  ctx.clock.advance(BATCH_MS)
  await restarted.tick()
  restarted.stop()
  const wake = ctx.calls.find(argv => argv[0] === 'codex')?.at(-1) ?? ''
  assert.match(wake, /finished anyway/)
  assert.doesNotMatch(wake, /guard-thrash/)
})

test('the next wake carries the item as one the planner acts on, not the human', async () => {
  const ctx = await setup()
  const env = workerEnv(ctx)
  for (const file of ['a', 'b', 'c']) await hooks.runHook('pre-tool-use', edit(join(worktree, `docs/${file}.md`)), env, depsOf(ctx))
  const { ports } = fakePorts()
  const watcher = createWatcher(ctx.deps, ctx.run, { ports, loop: false })
  await watcher.tick()
  ctx.clock.advance(1000)
  await fileReport(ctx, 'w-api', 'done', 'finished anyway')
  await watcher.tick()
  ctx.clock.advance(BATCH_MS)
  await watcher.tick()
  watcher.stop()
  const wake = ctx.calls.find(argv => argv[0] === 'codex')?.at(-1) ?? ''
  assert.match(wake, /finished anyway/)
  assert.match(wake, /For you to act on:\n.*w-api: guard-thrash: w-api hit the guard's owns rule 3 times/)
  assert.doesNotMatch(wake, /Needs the human/)
})

test('a ledger line stays under the 8 KiB cap however long the command is', async () => {
  const ctx = await setup()
  const env = workerEnv(ctx)
  const long = 'a'.repeat(30_000)
  const result = await hooks.runHook('pre-tool-use', shell(`echo x > docs/${long}.md`), env, depsOf(ctx))
  assert.equal(result.code, 2)
  const lines = readFileSync(join(runDir(ctx.home, ctx.run.id), 'events.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.ok(Buffer.byteLength(lines[0] ?? '') < 8192)
  const data = (JSON.parse(lines[0] ?? '{}') as DroveEvent).data ?? {}
  assert.equal(data.rule, 'owns')
  assert.ok(String(data.command).length <= 200 && String(data.reason).length <= 200)
})

test('an unwritable ledger never turns a denial into an allow', async () => {
  const ctx = await setup()
  const result = await hooks.runHook('pre-tool-use', edit(join(worktree, 'docs/a.md')), workerEnv(ctx), { ...depsOf(ctx), append: async () => { throw new Error('disk full') } })
  assert.equal(result.code, 2)
})

// ---------- fail mode ----------

const closedIdentity = (overrides: Partial<Identity>): Identity => ({ home: '/h', run: 'r1', role: 'worker', seat: 'w-x', ...overrides })

test('failsClosed names the roles: the planner and a reviewer seat, nobody else', () => {
  assert.equal(hooks.failsClosed(closedIdentity({ role: 'planner', seat: 'planner' })), true)
  assert.equal(hooks.failsClosed(closedIdentity({ seatRole: 'reviewer' })), true)
  assert.equal(hooks.failsClosed(closedIdentity({})), false)
  assert.equal(hooks.failsClosed(closedIdentity({ seatRole: 'tester' })), false)
  assert.equal(hooks.failsClosed(closedIdentity({ owns: ['src/**'] })), false)
})

const brokenDeps = () => {
  const written: Record<string, unknown>[] = []
  const deps: hooks.HookDeps = {
    now: () => new Date('2026-10-12T10:00:00.000Z'),
    identity: env => (env.DROVE_ROLE ? { home: '/h', run: 'r1', role: env.DROVE_ROLE as Identity['role'], seat: env.DROVE_SEAT ?? 'planner', ...(env.DROVE_SEAT_ROLE === 'reviewer' ? { seatRole: 'reviewer' as const } : {}) } : undefined),
    hooksPath: () => '/h/hooks.jsonl',
    eventsPath: () => '/h/events.jsonl',
    scratchRoot: () => '/h/scratch',
    append: async (_path, value) => void written.push(value as Record<string, unknown>),
    openIds: async () => {
      throw new Error('roster unreadable')
    },
    seatToken: async () => undefined,
    adoptGoal: async () => undefined,
  }
  return { deps, written }
}

test('fail mode: when the guard throws, a planner is refused', async () => {
  const { deps, written } = brokenDeps()
  const call = JSON.stringify({ tool_name: 'Bash', cwd: '/work', tool_input: { command: 'herdr agent prompt w-x go' } })
  const result = await hooks.runHook('pre-tool-use', call, { DROVE_ROLE: 'planner', DROVE_SEAT: 'planner' }, deps)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /^Drove planner: the guard could not check this call \(roster unreadable\), so it is refused\..*Next step: try the call again/)
  assert.equal(written.at(-1)?.type, 'guard.denied')
  assert.equal((written.at(-1)?.data as Record<string, unknown>).rule, 'guard-error')
})

test('fail mode: unreadable hook input refuses a planner and a reviewer seat, and lets an implementer through as before', async () => {
  const planner = brokenDeps()
  const reviewer = brokenDeps()
  const worker = brokenDeps()
  const refusedPlanner = await hooks.runHook('pre-tool-use', 'not json', { DROVE_ROLE: 'planner', DROVE_SEAT: 'planner' }, planner.deps)
  const refusedReviewer = await hooks.runHook('pre-tool-use', '[1,2]', { DROVE_ROLE: 'worker', DROVE_SEAT: 'w-rev', DROVE_SEAT_ROLE: 'reviewer' }, reviewer.deps)
  const letThrough = await hooks.runHook('pre-tool-use', 'not json', { DROVE_ROLE: 'worker', DROVE_SEAT: 'w-impl' }, worker.deps)
  assert.equal(refusedPlanner.code, 2)
  assert.equal(refusedReviewer.code, 2)
  assert.match(refusedReviewer.stderr, /^Drove worker: the guard could not check this call/)
  assert.match(refusedReviewer.stderr, /Next step: try the call again/)
  assert.deepEqual(letThrough, { stdout: '', stderr: '', code: 0 })
  assert.equal(worker.written.length, 0, 'an allow writes nothing')
  assert.equal((reviewer.written.at(-1)?.data as Record<string, unknown>).rule, 'guard-error')
})

test('fail mode: a state hook that fails never blocks, whoever the seat is', async () => {
  const { deps } = brokenDeps()
  assert.deepEqual(await hooks.runHook('stop', 'not json', { DROVE_ROLE: 'planner', DROVE_SEAT: 'planner' }, deps), { stdout: '', stderr: '', code: 0 })
  assert.deepEqual(await hooks.runHook('stop', 'not json', { DROVE_ROLE: 'worker', DROVE_SEAT: 'w-rev', DROVE_SEAT_ROLE: 'reviewer' }, deps), { stdout: '', stderr: '', code: 0 })
})

test('a process with no Drove identity is not guarded at all', async () => {
  const { deps } = brokenDeps()
  assert.deepEqual(await hooks.runHook('pre-tool-use', 'not json', {}, deps), { stdout: '', stderr: '', code: 0 })
})

// ---------- the run report (AC4) and the boards ----------

const at = (time: string): string => `2026-10-09T${time}:00.000Z`

test('AC4: the run report counts guard denials per seat, by rule, and in the totals', async () => {
  const fake = new FakeHerdr()
  const deps = { ...(await makeDeps(fake)), claudeUserDir: await tmp('claude-user') }
  await seedRun(deps, '/repo', [makeSeat('w-a', { state: 'closed' }), makeSeat('w-b', { state: 'working' })])
  const denied = (time: string, seat: string, rule?: string): DroveEvent => ({ at: at(time), type: 'guard.denied', seat, data: { tool: 'Bash', ...(rule ? { rule } : {}), reason: 'no' } })
  const events: DroveEvent[] = [
    { at: at('09:10'), type: 'seat.spawn', seat: 'w-a', data: { kind: 'claude', model: 'claude-sonnet-5-5' } },
    { at: at('09:11'), type: 'seat.spawn', seat: 'w-b', data: { kind: 'claude', model: 'claude-sonnet-5-5' } },
    denied('09:12', 'w-a', 'owns'),
    denied('09:13', 'w-a', 'owns'),
    denied('09:14', 'w-a', 'push'),
    denied('09:15', 'w-b', 'herdr'),
    { ...denied('09:16', 'w-b'), type: 'guard.deny' as DroveEvent['type'] },
  ]
  await mkdir(runDir(deps.home, RUN), { recursive: true })
  await writeFile(join(runDir(deps.home, RUN), 'events.jsonl'), `${events.map(item => JSON.stringify(item)).join('\n')}\n`)
  const report = await buildReport(deps, RUN, deps.claudeUserDir)
  assert.ok(report)
  const a = report.seats.find(row => row.seat === 'w-a')
  const b = report.seats.find(row => row.seat === 'w-b')
  assert.deepEqual([a?.denials, a?.denialsByRule], [3, { owns: 2, push: 1 }])
  assert.deepEqual([b?.denials, b?.denialsByRule], [2, { herdr: 1, unknown: 1 }])
  assert.equal(report.totals.denials, 5)
  assert.deepEqual(report.totals.denialsByRule, { owns: 2, push: 1, herdr: 1, unknown: 1 })
  const text = renderReport(report)
  assert.match(text, /deny\s+chg\/pro\/dem\/mig\/rst/)
  assert.match(text, /w-a\s+claude.*\s3\s+0\/0\/0\/0\/0/)
  assert.match(text, /by rule: owns 2, herdr 1, push 1, unknown 1/)
})

const THRASH = { seat: 'w-api', reason: 'guard-thrash' as const, detail: "w-api hit the guard's owns rule 3 times in 10 minutes and has not reported since; last refusal: docs/c.md", at: '2026-10-12T10:05:00.000Z' }
const RUN_META: RunMeta = { v: 1, id: 'drove-test', repo: '/repo', base: 'main', hasRemote: false, createdAt: '2026-10-12T09:00:00.000Z', status: 'up', goal: 'g', budget: 5, planner: { kind: 'claude', model: 'claude-opus-5-5', effort: 'high', viaMod: false } }
const seatWith = (attention: Seat['attention']): Seat => ({
  name: 'w-api', kind: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', worktree: '/w', branch: 'drove/w-api', state: 'working',
  stateAt: '2026-10-12T10:00:00.000Z', spawnedAt: '2026-10-12T09:00:00.000Z', owes: 'none', attention,
})
const boardData = (attention: Seat['attention'], events: DroveEvent[]): board.BoardData => ({
  run: RUN_META,
  roster: { v: 1, run: RUN_META.id, updatedAt: '2026-10-12T10:06:00.000Z', seats: [seatWith(attention)] },
  status: {},
  feed: board.feedFrom(events),
  bridgeHeld: false,
})
const NOW = Date.parse('2026-10-12T10:06:00.000Z')
const THRASH_EVENT: DroveEvent = { at: THRASH.at, type: 'attention', seat: 'w-api', data: { reason: 'guard-thrash', rule: 'owns', detail: THRASH.detail } }

test('the terminal board shows the item on the seat row and as a notice to the planner in the timeline', () => {
  const lines = board.renderFrame({ ...boardData([THRASH], [THRASH_EVENT]), now: NOW, frame: 0, columns: 200, rows: 30, offsetMinutes: 0 }, 0)
  const row = lines.find(line => line.includes('w-api') && line.includes('owns rule')) ?? ''
  assert.match(row, /guard's owns rule 3 times in 10 minutes/)
  assert.ok(lines.some(line => /w-api.*⌘.*notice.*guard-thrash: /.test(line)), 'the timeline names it a notice to the lead')
  assert.equal(board.renderFrame({ ...boardData([], []), now: NOW, frame: 0, columns: 200, rows: 30, offsetMinutes: 0 }, 0).some(line => line.includes('owns rule')), false)
})

test('the web board carries the same row text and the notice, and the seat is not marked as needing a person', () => {
  const payload = web.payloadOf(boardData([THRASH], [THRASH_EVENT]), NOW, 0)
  const seat = payload.seats.find(entry => entry.name === 'w-api')
  assert.match(seat?.activity ?? '', /guard's owns rule 3 times/)
  assert.equal(seat?.needsYou, false)
  const notice = payload.feed.find(entry => entry.kind === 'notice')
  assert.match(notice?.summary ?? '', /^guard-thrash: /)
  assert.equal(notice?.to, '⌘')
})

test("the mod board's feed and roster treat the item as the planner's", () => {
  assert.equal(isForHuman({ reason: 'guard-thrash' }), false)
  const draft = feedOf(THRASH_EVENT, new Map())
  assert.equal(draft?.kind, 'notice')
  assert.equal(draft?.to, '⌘')
})
