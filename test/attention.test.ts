import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { main } from '../src/cli.ts'
import type { AttentionDelta } from '../src/attention.ts'
import { seatDir } from '../src/paths.ts'
import { updateRoster } from '../src/roster.ts'
import type { Attention, AttentionItem, Deps, Identity, Report, RunMeta, Seat } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, makeSeat, RUN, seedRun } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const AT = '2026-10-09T09:30:00.000Z'

const dialogOn = (seat: string, reason: Attention['reason'] = 'dialog', detail = 'The pane is waiting at a dialog.', at = AT): Attention => ({ seat, reason, detail, at })

// The planner pane is a live agent, so a poll finds nothing wrong with it unless a test says so.
const setup = async (seats: Seat[] = [], overrides: Partial<RunMeta> = {}) => {
  const fake = new FakeHerdr()
  fake.agents.set('planner-a3f1', { name: 'planner-a3f1', paneId: 'w1:p0', tabId: 'w1:t0', status: 'idle' })
  const deps = await makeDeps(fake)
  const repo = await makeRepo()
  await seedRun(deps, repo, seats, overrides)
  return { fake, deps, repo }
}

const itemsOf = async (deps: Deps, request: commands.AttentionRequest = { run: RUN, repo: '/x' }): Promise<AttentionItem[]> => {
  const result = await commands.attention(deps, request, true)
  assert.equal(result.ok, true, result.text)
  return (JSON.parse(result.text) as { items: AttentionItem[] }).items
}

const report = (overrides: Partial<Report>): Report => ({ v: 1, id: 'r-w-a-1-aaaa', run: RUN, seat: 'w-a', token: 'token-w-a', kind: 'question', expects: 'answer', summary: 'Which database?', at: '2026-10-09T09:40:00.000Z', ...overrides })

const writeOutbox = async (deps: Deps, seat: string, reports: Report[]) => {
  const dir = seatDir(deps.home, RUN, seat)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'outbox.jsonl'), `${reports.map(item => JSON.stringify(item)).join('\n')}\n`)
}

test('a worker dialog is an item with the seat, the pane, since the seat blocked, and a way to inspect it', async () => {
  const { deps } = await setup([makeSeat('w-a', { state: 'blocked', stateAt: '2026-10-09T09:20:00.000Z', attention: [dialogOn('w-a', 'trust', 'Claude is asking to trust the folder')] })])
  const [item, ...rest] = await itemsOf(deps)
  assert.equal(rest.length, 0)
  assert.equal(item?.id, `${RUN}:w-a:trust:1`)
  assert.equal(item?.run, RUN)
  assert.equal(item?.seat, 'w-a')
  assert.equal(item?.kind, 'trust')
  assert.equal(item?.text, 'Claude is asking to trust the folder')
  assert.equal(item?.since, '2026-10-09T09:20:00.000Z')
  assert.deepEqual(item?.answer, { type: 'pane', pane: 'w1:p-w-a', inspect: `drove capture w-a --run ${RUN}`, note: 'Answer it in the pane. Drove never answers a dialog or an approval.' })
})

test('ids and since stay the same across polls, even when the watcher rewrites the attention line', async () => {
  const { deps } = await setup([makeSeat('w-a', { state: 'blocked', stateAt: AT, attention: [dialogOn('w-a')] })])
  const first = await itemsOf(deps)
  const second = await itemsOf(deps)
  assert.deepEqual(second.map(item => item.id), first.map(item => item.id))
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, attention: [dialogOn('w-a', 'dialog', 'The pane is waiting at a dialog.', '2026-10-09T11:00:00.000Z')] })) }))
  const third = await itemsOf(deps)
  assert.deepEqual(third.map(item => [item.id, item.since]), first.map(item => [item.id, item.since]))
})

test('an item that goes away and comes back is a new episode with a new id', async () => {
  const { deps } = await setup([makeSeat('w-a', { state: 'blocked', stateAt: AT, attention: [dialogOn('w-a')] })])
  assert.deepEqual((await itemsOf(deps)).map(item => item.id), [`${RUN}:w-a:dialog:1`])
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'working' as const, attention: [] })) }))
  assert.deepEqual(await itemsOf(deps), [])
  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, state: 'blocked' as const, stateAt: '2026-10-09T09:55:00.000Z', attention: [dialogOn('w-a')] })) }))
  const [again] = await itemsOf(deps)
  assert.equal(again?.id, `${RUN}:w-a:dialog:2`)
  assert.equal(again?.since, '2026-10-09T09:55:00.000Z')
})

test('a question or blocked report addressed to the human is an item until the worker is answered; one for the planner is not', async () => {
  const { deps } = await setup([
    makeSeat('w-a', { owes: 'answer', lastReport: { id: 'r-w-a-1-aaaa', kind: 'question', expects: 'answer', summary: 'Which database?', at: '2026-10-09T09:40:00.000Z' } }),
    makeSeat('w-b', { owes: 'answer' }),
  ])
  await writeOutbox(deps, 'w-a', [report({ for: 'human', details: 'Postgres or SQLite.' })])
  await writeOutbox(deps, 'w-b', [report({ seat: 'w-b', token: 'token-w-b', id: 'r-w-b-1-bbbb', summary: 'Rename the file?' })])

  const [item, ...rest] = await itemsOf(deps)
  assert.equal(rest.length, 0)
  assert.equal(item?.kind, 'question')
  assert.equal(item?.seat, 'w-a')
  assert.equal(item?.since, '2026-10-09T09:40:00.000Z')
  assert.equal(item?.text, 'Which database?\nPostgres or SQLite.')
  assert.equal(item?.answer.type, 'command')
  assert.equal(item?.answer.type === 'command' && item.answer.command, `drove send w-a --run ${RUN} --kind answer <answer>`)

  await updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => ({ ...seat, owes: 'none' as const })) }))
  assert.deepEqual(await itemsOf(deps), [])
})

test('a blocked report for the human keeps its kind, and a later report from the seat replaces it', async () => {
  const { deps } = await setup([makeSeat('w-a', { owes: 'answer' })])
  await writeOutbox(deps, 'w-a', [report({ kind: 'blocked', for: 'human', summary: 'Need the prod credentials.' })])
  assert.deepEqual((await itemsOf(deps)).map(item => item.kind), ['blocked'])
  await writeOutbox(deps, 'w-a', [report({ kind: 'blocked', for: 'human', summary: 'Need the prod credentials.' }), report({ id: 'r-w-a-2-cccc', kind: 'question', summary: 'Never mind: which branch?' })])
  assert.deepEqual(await itemsOf(deps), [])
})

test('a spawn the pane budget refused is a request until the budget is raised', async () => {
  const { deps, fake } = await setup([], { budget: 1 })
  const identity: Identity = { home: deps.home, run: RUN, role: 'planner', seat: 'planner' }
  process.env.HERDR_PANE_ID = 'w1:p0'
  const first = await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', brief: 'Build the widget.' })
  assert.equal(first.ok, true, first.text)
  const second = await commands.spawn(deps, identity, { seat: 'w-b', kind: 'claude', brief: 'Build the other widget.' })
  assert.equal(!second.ok && second.code, 'over-budget')
  fake.setStatus('w-a', 'idle')

  const [item, ...rest] = (await itemsOf(deps)).filter(entry => entry.kind === 'pane-budget')
  assert.equal(rest.length, 0)
  assert.equal(item?.seat, 'w-b')
  assert.equal(item?.id, `${RUN}:pane-budget:w-b:1`)
  assert.match(item?.text ?? '', /w-b \(claude\) needs pane 2, over the pane budget of 1/)
  assert.deepEqual(item?.answer, { type: 'command', command: `drove budget 2 --run ${RUN}`, note: 'Raises the pane budget by one; only a person may run it.' })

  const raised = await commands.raiseBudget(deps, { run: RUN, repo: '/x' }, 2)
  assert.equal(raised.ok, true, raised.text)
  assert.deepEqual((await itemsOf(deps)).filter(entry => entry.kind === 'pane-budget'), [])
})

test('a worker asking in its pane carries the question, and replaces the generic approval line', async () => {
  const { deps } = await setup([makeSeat('w-a', { state: 'needs-input', stateAt: AT, attention: [dialogOn('w-a', 'permission', 'waiting for an approval in the pane')] })])
  await writeFile(join(seatDir(deps.home, RUN, 'w-a'), 'mod.json'), JSON.stringify({ at: '2026-10-09T09:35:00.000Z', asking: 'asking in its pane: which database?' }))
  const items = await itemsOf(deps)
  assert.deepEqual(items.map(item => item.kind), ['asking'])
  assert.equal(items[0]?.text, 'asking in its pane: which database?')
  assert.equal(items[0]?.since, '2026-10-09T09:35:00.000Z')
  assert.equal(items[0]?.answer.type, 'pane')
})

test('a planner stopped at a dialog, or gone while the run is up, is an item of the planner seat', async () => {
  const { deps, fake } = await setup()
  assert.deepEqual(await itemsOf(deps), [])

  fake.setStatus('planner', 'blocked')
  const [blocked] = await itemsOf(deps)
  assert.equal(blocked?.seat, 'planner')
  assert.equal(blocked?.kind, 'dialog')
  assert.equal(blocked?.answer.type, 'pane')
  assert.equal(blocked?.answer.type === 'pane' && blocked.answer.pane, 'w1:p0')

  fake.agents.clear()
  const gone = (await itemsOf(deps)).filter(item => item.kind === 'gone')
  assert.equal(gone.length, 1)
  assert.equal(gone[0]?.seat, 'planner')
  assert.equal(gone[0]?.answer.type === 'command' && gone[0].answer.command, `drove up --run ${RUN} --detached`)
})

test('a seat that is gone offers the relaunch command', async () => {
  const { deps } = await setup([makeSeat('w-a', { state: 'gone', attention: [dialogOn('w-a', 'gone', 'pane w1:p-w-a is gone')] })])
  const gone = (await itemsOf(deps)).find(item => item.kind === 'gone')
  assert.equal(gone?.answer.type === 'command' && gone.answer.command, `drove up --run ${RUN} --seat w-a`)
})

test('what the planner handles is not an item for a person: idle-without-report, stalled, budget, pending-delivery (DROVE-108)', async () => {
  const planners = [
    ['w-b', 'idle-without-report', 'The seat stopped without sending a report.'],
    ['w-d', 'stalled', 'agent_prompt_stalled'],
    ['w-e', 'budget', 'used 20 of its 20 turns'],
    ['w-f', 'pending-delivery', 'message c-1 is waiting'],
  ] as const
  const { deps } = await setup([
    ...planners.map(([name, reason, detail]) => makeSeat(name, { state: 'idle', attention: [dialogOn(name, reason, detail)] })),
    makeSeat('w-c', { state: 'blocked', stateAt: AT, attention: [dialogOn('w-c')] }),
  ])
  assert.deepEqual((await itemsOf(deps)).map(item => item.seat), ['w-c'])
})

test('--all lists the items of every run that is up, and not a run that is down', async () => {
  const { deps, repo } = await setup([makeSeat('w-a', { state: 'blocked', stateAt: AT, attention: [dialogOn('w-a')] })])
  await seedRun(deps, repo, [makeSeat('w-z', { state: 'blocked', stateAt: AT, attention: [dialogOn('w-z')] })], { id: 'run-b', status: 'down' })
  await seedRun(deps, repo, [makeSeat('w-c', { state: 'blocked', stateAt: AT, attention: [dialogOn('w-c')] })], { id: 'run-c', createdAt: '2026-10-09T09:05:00.000Z' })
  const result = await commands.attention(deps, { all: true, repo: '/x' }, true)
  assert.equal(result.ok, true, result.text)
  const body = JSON.parse(result.text) as { runs: string[]; items: AttentionItem[] }
  assert.deepEqual(body.runs, [RUN, 'run-c'])
  assert.deepEqual(body.items.map(item => item.run), [RUN, 'run-c'])

  const both = await commands.attention(deps, { all: true, run: RUN, repo: '/x' }, true)
  assert.equal(!both.ok && both.code, 'usage')
})

test('--follow prints each new item once and each resolved item once, then stops on abort', async () => {
  const { deps } = await setup([makeSeat('w-a', { state: 'blocked', stateAt: AT, attention: [dialogOn('w-a')] })])
  const deltas: AttentionDelta[] = []
  const controller = new AbortController()
  let sleeps = 0
  const stages = [
    // w-b starts asking for an approval
    () => updateRoster(deps.home, RUN, roster => ({ ...roster, seats: [...roster.seats, makeSeat('w-b', { state: 'needs-input', stateAt: '2026-10-09T09:50:00.000Z', attention: [dialogOn('w-b', 'permission', 'waiting for an approval in the pane')] })] })),
    // nothing changes: no delta
    async () => undefined,
    // w-a is answered
    () => updateRoster(deps.home, RUN, roster => ({ ...roster, seats: roster.seats.map(seat => (seat.name === 'w-a' ? { ...seat, state: 'working' as const, attention: [] } : seat)) })),
  ]
  const followed = await commands.followAttention(
    deps,
    { run: RUN, repo: '/x' },
    delta => deltas.push(delta),
    {
      signal: controller.signal,
      sleep: async () => {
        const stage = stages[sleeps]
        sleeps += 1
        if (stage) await stage()
        else controller.abort()
      },
    },
  )
  assert.equal(followed.ok, true)
  assert.deepEqual(
    deltas.map(delta => [delta.event, delta.item.seat, delta.item.kind]),
    [['new', 'w-a', 'dialog'], ['new', 'w-b', 'permission'], ['resolved', 'w-a', 'dialog']],
  )
  assert.ok(deltas.every(delta => delta.v === 1 && delta.item.id.startsWith(`${RUN}:`)))
  assert.equal(deltas[0]?.item.id, deltas[2]?.item.id, 'the resolved delta names the id that was announced')
})

test('--follow fails at once when the run does not exist', async () => {
  const { deps } = await setup()
  const followed = await commands.followAttention(deps, { run: 'nope', repo: '/x' }, () => assert.fail('no delta'), { sleep: async () => assert.fail('no wait') })
  assert.equal(!followed.ok && followed.code, 'no-run')
})

test('drove attention through the CLI: a failure with --json is one JSON object on stderr, exit 1', async () => {
  const { deps } = await setup()
  process.env.DROVE_HOME = deps.home
  try {
    const out: string[] = []
    const err: string[] = []
    const code = await main(['attention', '--run', 'nope', '--json'], { out: text => out.push(text), err: text => err.push(text), stdin: async () => '' })
    assert.equal(code, 1)
    assert.deepEqual(out, [])
    const failure = JSON.parse(err[0] ?? '') as { ok: boolean; code: string; error: string }
    assert.deepEqual([failure.ok, failure.code], [false, 'no-run'])

    const badUsage = await main(['attention', '--run', RUN, '--all'], { out: () => undefined, err: text => err.push(text), stdin: async () => '' })
    assert.equal(badUsage, 2)
    const needsDetached = await main(['plan', '--json'], { out: () => undefined, err: () => undefined, stdin: async () => '' })
    assert.equal(needsDetached, 2)
  } finally {
    delete process.env.DROVE_HOME
  }
})

test('drove roster --json also says whether the planner pane is alive, the latest report and when the roster was written', async () => {
  const { deps, fake } = await setup([
    makeSeat('w-a', { lastReport: { id: 'r-1', kind: 'progress', expects: 'none', summary: 'half done', at: '2026-10-09T09:31:00.000Z' } }),
    makeSeat('w-b', { lastReport: { id: 'r-2', kind: 'done', expects: 'review', summary: 'finished', at: '2026-10-09T09:45:00.000Z' } }),
  ])
  fake.setStatus('planner', 'working')
  const result = await commands.roster(deps, { run: RUN, repo: '/x' }, true)
  assert.equal(result.ok, true, result.text)
  const body = JSON.parse(result.text) as { run: RunMeta; seats: Seat[]; planner: { state: string; paneId: string }; lastReport: { seat: string; summary: string } | null; updatedAt: string }
  assert.equal(body.run.status, 'up')
  assert.equal(body.planner.state, 'working')
  assert.equal(body.planner.paneId, 'w1:p0')
  assert.deepEqual([body.lastReport?.seat, body.lastReport?.summary], ['w-b', 'finished'])
  assert.ok(body.updatedAt)
  assert.equal(body.seats.length, 2)

  fake.agents.clear()
  const gone = JSON.parse((await commands.roster(deps, { run: RUN, repo: '/x' }, true)).text) as { planner: { state: string } }
  assert.equal(gone.planner.state, 'gone')
})
