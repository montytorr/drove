import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { plannerDir } from '../src/paths.ts'
import { loadRun } from '../src/roster.ts'
import type { AgentKind, DetachedStart, ExecResult } from '../src/types.ts'
import { createWatcher, defaultWatchPorts, TICK_MS } from '../src/watch.ts'
import { cairnProbe, FakeHerdr, makeDeps, makeRepo } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const TRUST_SCREEN: Record<AgentKind, string> = {
  claude: ' Do you trust the files in this folder?\n\n /repo\n\n ❯ 1. Yes, proceed\n   2. No, exit\n',
  codex: ' Do you trust the contents of this directory?\n\n › 1. Yes, continue\n   2. No, quit\n',
}
const READY_SCREEN: Record<AgentKind, string> = {
  claude: ' ▐▛███▜▌   Claude Code v2.1.296\n\n──────\n❯ \n──────\n',
  codex: '>_ OpenAI Codex\n\n› \n',
}

// A Cairn task with a multi-line body: the goal cannot ride in the launch line, so it is typed once the planner is up.
const withCairn = (fake: FakeHerdr) => {
  const base = fake.exec
  fake.exec = async (argv, options): Promise<ExecResult> => {
    const probed = cairnProbe(argv)
    if (probed) return probed
    if (argv[0] !== 'cairn') return base(argv, options)
    if (argv[1] === 'show') return { code: 0, stdout: JSON.stringify({ ref: argv[2], title: 'Hold the goal', status: 'todo', description: 'Line one.\nLine two.' }), stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

type Started = { fake: FakeHerdr; deps: Awaited<ReturnType<typeof makeDeps>>; repo: string; data: DetachedStart; text: string }

// `drove plan --detached --from-cairn` with the planner stopped at its folder-trust prompt.
const startAtDialog = async (kind: AgentKind = 'claude'): Promise<Started> => {
  const fake = new FakeHerdr({ startFails: 'agent_not_ready' })
  fake.screen = TRUST_SCREEN[kind]
  withCairn(fake)
  const deps = await makeDeps(fake)
  const repo = await makeRepo()
  const planned = await commands.plan(deps, { repo, kind, cairn: 'DROVE-5', detached: true })
  assert.equal(planned.ok, true, planned.text)
  return { fake, deps, repo, data: (planned.ok ? planned.data : undefined) as DetachedStart, text: planned.text }
}

const answerDialog = (ctx: Started, kind: AgentKind = 'claude') => {
  ctx.fake.screen = READY_SCREEN[kind]
  ctx.fake.setStatus('planner', 'idle')
}

const watcherOf = async (ctx: Started) => {
  const run = await loadRun(ctx.deps.home, ctx.data.run)
  assert.ok(run)
  const errors: string[] = []
  const ports = { ...defaultWatchPorts, paneTty: async () => undefined, writeTty: () => undefined }
  return { watcher: createWatcher(ctx.deps, run, { ports, loop: false, onError: (error, step) => void errors.push(`${step}: ${(error as Error).message}`) }), errors }
}

const goalEvents = async (ctx: Started) =>
  (await readFile(join(ctx.deps.home, 'runs', ctx.data.run, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { type: string; seat?: string; data?: Record<string, unknown> })
    .filter(event => event.type === 'planner.goal-delivered')

const plannerPrompts = (ctx: Started) => ctx.fake.prompts.filter(prompt => prompt.target === ctx.data.planner.pane)

for (const kind of ['claude', 'codex'] as const) {
  test(`AC1: a ${kind} planner started at a dialog gets its goal from the watcher within one tick of the dialog clearing, once, with an event`, async () => {
    const ctx = await startAtDialog(kind)
    assert.equal(ctx.data.planner.state, 'blocked')
    assert.match(ctx.text, new RegExp(`drove goal --run ${ctx.data.run} --deliver`))
    assert.match(ctx.text, /the watcher types the goal once the dialog clears/)
    assert.doesNotMatch(ctx.text, /give the planner its goal in the pane/)
    const held = (await loadRun(ctx.deps.home, ctx.data.run))?.pendingGoal
    assert.match(held?.text ?? '', /DROVE-5[\s\S]*Line two\./)
    assert.equal(plannerPrompts(ctx).length, 0)

    const { watcher, errors } = await watcherOf(ctx)
    await watcher.tick()
    assert.equal(plannerPrompts(ctx).length, 0, 'nothing is typed while the dialog is up')
    assert.ok((await loadRun(ctx.deps.home, ctx.data.run))?.pendingGoal)

    answerDialog(ctx, kind)
    ctx.deps.clock.advance(TICK_MS)
    await watcher.tick()
    assert.deepEqual(plannerPrompts(ctx).map(prompt => prompt.text), [held?.text])
    const run = await loadRun(ctx.deps.home, ctx.data.run)
    assert.equal(run?.pendingGoal, undefined)
    assert.equal(run?.goalDelivered?.by, 'watcher')
    const events = await goalEvents(ctx)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.seat, 'planner')
    assert.equal(events[0]?.data?.by, 'watcher')

    ctx.fake.setStatus('planner', 'idle')
    ctx.deps.clock.advance(TICK_MS)
    await watcher.tick()
    assert.equal(plannerPrompts(ctx).length, 1, 'a second tick types nothing')
    assert.deepEqual(errors, [])
  })
}

test('AC2: drove goal --deliver types the held goal once, and a second run says it was already delivered', async () => {
  const ctx = await startAtDialog()
  const held = (await loadRun(ctx.deps.home, ctx.data.run))?.pendingGoal?.text
  answerDialog(ctx)

  const first = await commands.deliverGoal(ctx.deps, { run: ctx.data.run, repo: ctx.repo })
  assert.equal(first.ok, true, first.text)
  assert.match(first.text, /typed into planner pane/)
  assert.deepEqual(plannerPrompts(ctx).map(prompt => prompt.text), [held])
  assert.equal((await loadRun(ctx.deps.home, ctx.data.run))?.goalDelivered?.by, 'command')

  ctx.fake.setStatus('planner', 'idle')
  const second = await commands.deliverGoal(ctx.deps, { run: ctx.data.run, repo: ctx.repo })
  assert.equal(second.ok, true, second.text)
  assert.match(second.text, /already delivered \(typed by drove goal --deliver at /)
  assert.equal(plannerPrompts(ctx).length, 1)

  const { watcher } = await watcherOf(ctx)
  await watcher.tick()
  assert.equal(plannerPrompts(ctx).length, 1, 'the watcher does not type it again')
  assert.equal((await goalEvents(ctx)).length, 1)
})

test('AC3: drove goal --deliver refuses without typing while the planner is still at its dialog', async () => {
  const ctx = await startAtDialog()
  const refused = await commands.deliverGoal(ctx.deps, { run: ctx.data.run, repo: ctx.repo })
  assert.equal(refused.ok, false)
  assert.equal(!refused.ok && refused.code, 'at-dialog')
  assert.match(refused.text, /Nothing was typed: the planner is still at a dialog \(trust\)/)
  assert.equal(plannerPrompts(ctx).length, 0)
  assert.ok((await loadRun(ctx.deps.home, ctx.data.run))?.pendingGoal, 'the goal stays held')
  assert.equal((await goalEvents(ctx)).length, 0)
})

test('drove goal --deliver with no held goal refuses with no-goal', async () => {
  const fake = new FakeHerdr()
  withCairn(fake)
  const deps = await makeDeps(fake)
  const repo = await makeRepo()
  const planned = await commands.plan(deps, { repo, kind: 'claude', goal: 'Ship the widget.', detached: true })
  assert.equal(planned.ok, true, planned.text)
  const { run } = planned.ok ? (planned.data as DetachedStart) : { run: '' }
  assert.equal((await loadRun(deps.home, run))?.pendingGoal, undefined)
  const refused = await commands.deliverGoal(deps, { run, repo })
  assert.equal(!refused.ok && refused.code, 'no-goal')
})

test('a goal given by hand in the pane after the dialog is not typed again', async () => {
  const ctx = await startAtDialog()
  answerDialog(ctx)
  const dir = plannerDir(ctx.deps.home, ctx.data.run)
  await mkdir(dir, { recursive: true })
  ctx.deps.clock.advance(1000)
  await writeFile(join(dir, 'hooks.jsonl'), `${JSON.stringify({ at: ctx.deps.clock.now().toISOString(), agent: 'claude', event: 'user-prompt-submit', sessionId: 's' })}\n`)

  const { watcher } = await watcherOf(ctx)
  await watcher.tick()
  assert.equal(plannerPrompts(ctx).length, 0)
  const run = await loadRun(ctx.deps.home, ctx.data.run)
  assert.equal(run?.pendingGoal, undefined)
  assert.equal(run?.goalDelivered?.by, 'pane')
  assert.equal((await goalEvents(ctx))[0]?.data?.by, 'pane')
})

test('a new planner on the same run drops the goal held for the last one', async () => {
  const ctx = await startAtDialog()
  ctx.fake.agents.clear()
  ctx.fake.startFails = undefined
  ctx.fake.screen = READY_SCREEN.claude
  const replanned = await commands.plan(ctx.deps, { repo: ctx.repo, kind: 'claude', goal: 'Something else.', run: ctx.data.run, detached: true })
  assert.equal(replanned.ok, true, replanned.text)
  assert.equal((await loadRun(ctx.deps.home, ctx.data.run))?.pendingGoal, undefined)
})
