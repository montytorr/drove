import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { loadRoster, loadRun } from '../src/roster.ts'
import type { Deps, ExecResult, Identity } from '../src/types.ts'
import { cairnProbe, FakeHerdr, makeDeps, makeRepo, RUN, seedRun, tmp } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

type Task = { title: string; status: string; description?: string; labels?: string[] }

const NOISE = 'cairn: acme could not be checked (stale project cache); routing DROVE to personal on its own record\n'

// A stand-in for the cairn CLI behind the fake herdr's exec: show, next and note, with the stale-cache preamble on stderr.
const stubCairn = (fake: FakeHerdr, tasks: Record<string, Task>, next: string[] = []) => {
  const calls: string[][] = []
  const base = fake.exec
  fake.exec = async (argv, options) => {
    if (argv[0] !== 'cairn') return base(argv, options)
    const probe = cairnProbe(argv)
    if (probe) return probe
    calls.push([...argv])
    const [, verb, ref] = argv
    const reply = (stdout: string, code = 0, stderr = ''): ExecResult => ({ code, stdout, stderr: `${NOISE}${stderr}` })
    if (verb === 'show') {
      const task = ref ? tasks[ref] : undefined
      return task ? reply(JSON.stringify({ ref, ...task })) : reply('', 1, `No task ${ref}.\n`)
    }
    if (verb === 'next') {
      const project = argv[argv.indexOf('--project') + 1]
      if (project !== 'DROVE') return reply('', 1, `No project ${project}.\n`)
      const [first, ...rest] = next
      return reply(JSON.stringify({ pick: first ? { ref: first, title: tasks[first]?.title } : null, then: rest.map(item => ({ ref: item })) }))
    }
    if (verb === 'note') return reply('')
    return reply('', 2, 'unknown verb')
  }
  return { calls, notes: () => calls.filter(call => call[1] === 'note') }
}

const planner = (deps: Deps): Identity => ({ home: deps.home, run: RUN, role: 'planner', seat: 'planner' })

const setup = async (fake: FakeHerdr, goalRef?: string) => {
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  const run = await seedRun(deps, repo, [], goalRef ? { cairn: goalRef } : {})
  return { repo, deps, run, identity: planner(deps) }
}

const brief = 'Build the widget.'

test('spawn refuses a Cairn task that is done or cancelled, before it opens a pane or takes a seat', async () => {
  const fake = new FakeHerdr()
  stubCairn(fake, { 'DROVE-1': { title: 'old', status: 'done' }, 'DROVE-2': { title: 'dropped', status: 'cancelled' } })
  const { deps, identity } = await setup(fake)
  for (const [ref, status] of [['DROVE-1', 'done'], ['DROVE-2', 'cancelled']] as const) {
    const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', cairn: ref, brief })
    assert.equal(spawned.ok, false)
    assert.equal(!spawned.ok && spawned.code, 'task-closed')
    assert.match(spawned.text, new RegExp(`${ref} is ${status}`))
  }
  assert.deepEqual((await loadRoster(deps.home, RUN)).seats, [])
  assert.equal(fake.calls.filter(call => call[0] === 'herdr').length, 0)
})

test('spawn refuses a Cairn task that does not exist, and passes an open one without a note', async () => {
  const fake = new FakeHerdr()
  stubCairn(fake, { 'DROVE-5': { title: 'open', status: 'doing' } })
  const { deps, identity } = await setup(fake)
  const missing = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', cairn: 'DROVE-404', brief })
  assert.equal(!missing.ok && missing.code, 'no-task')
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', cairn: 'DROVE-5', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.doesNotMatch(spawned.text, /not checked/)
  assert.equal((await loadRoster(deps.home, RUN)).seats[0]?.cairn, 'DROVE-5')
})

test('spawn proceeds with a note when cairn is missing or errors, and skips the check when no ref is given', async () => {
  const cases: Array<(argv: readonly string[]) => ExecResult> = [
    () => ({ code: 127, stdout: '', stderr: 'command not found' }),
    () => ({ code: 1, stdout: '', stderr: 'database locked' }),
    () => ({ code: 0, stdout: 'not json', stderr: '' }),
    () => {
      throw new Error('spawn cairn ENOENT')
    },
  ]
  for (const answer of cases) {
    const fake = new FakeHerdr()
    const base = fake.exec
    fake.exec = async (argv, options) => (argv[0] === 'cairn' ? answer(argv) : base(argv, options))
    const { deps, identity } = await setup(fake)
    const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', cairn: 'DROVE-5', brief })
    assert.equal(spawned.ok, true, spawned.text)
    assert.match(spawned.text, /The Cairn task DROVE-5 was not checked|Note: the Cairn task DROVE-5 was not checked/i)
  }
  const fake = new FakeHerdr()
  const { deps, identity } = await setup(fake)
  const spawned = await commands.spawn(deps, identity, { seat: 'w-api', kind: 'claude', brief })
  assert.equal(spawned.ok, true, spawned.text)
  assert.equal(fake.calls.filter(call => call[0] === 'cairn').length, 0)
})

test('plan --from-cairn makes the task the run goal, stores run.cairn and says so in the first prompt', async () => {
  const fake = new FakeHerdr()
  const { calls } = stubCairn(fake, { 'DROVE-70': { title: 'Drove and Cairn', status: 'doing', description: '## Do\n\nCheck refs at spawn.' } })
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan(deps, { repo, kind: 'claude', cairn: 'DROVE-70' })
  assert.equal(planned.ok, true, planned.text)
  assert.deepEqual(calls[0], ['cairn', 'show', 'DROVE-70', '--full', '--json'])
  const processPlan = (planned.ok ? planned.data : undefined) as commands.ProcessPlan
  const run = await loadRun(deps.home, processPlan.env.DROVE_RUN as string)
  assert.equal(run?.cairn, 'DROVE-70')
  assert.equal(run?.goal, 'DROVE-70: Drove and Cairn')
  const prompt = processPlan.argv.at(-1) ?? ''
  assert.match(prompt, /goal is Cairn task DROVE-70: Drove and Cairn/)
  assert.match(prompt, /Check refs at spawn\./)
  assert.match(prompt, /DROVE-70 is the run's goal task and you hold it/)
  assert.match(planned.text, /on Cairn task DROVE-70/)
})

test('plan --from-cairn carries kind labels and says when that kind is absent', async () => {
  for (const kind of ['codex', 'claude'] as const) {
    for (const available of [true, false]) {
      const fake = new FakeHerdr()
      stubCairn(fake, { 'DROVE-70': { title: 'Labelled task', status: 'todo', labels: ['frontend', `kind:${kind}`] } })
      const base = fake.exec
      fake.exec = async (argv, options) => argv[0] === kind && argv[1] === '--version'
        ? { code: available ? 0 : 127, stdout: available ? '1.2.3' : '', stderr: '' }
        : base(argv, options)
      const repo = await makeRepo()
      const deps = await makeDeps(fake)
      process.env.HERDR_PANE_ID = 'w1:p5'
      const planned = await commands.plan(deps, { repo, kind: kind === 'codex' ? 'claude' : 'codex', cairn: 'DROVE-70' })
      assert.equal(planned.ok, true, planned.text)
      const prompt = (planned.ok ? (planned.data as commands.ProcessPlan).argv.at(-1) : '') ?? ''
      if (available) assert.ok(prompt.includes(`This task is labelled kind:${kind}: spawn its workers as ${kind}.`), prompt)
      else {
        assert.ok(prompt.includes(`This task is labelled kind:${kind}, but ${kind} is not detected on this host (drove doctor)`), prompt)
        assert.ok(!prompt.includes(`spawn its workers as ${kind}.`), prompt)
      }
    }
  }
})

test('plan --from-cairn refuses a closed or missing task, a goal beside it, and a task cairn cannot be asked about', async () => {
  const fake = new FakeHerdr()
  stubCairn(fake, { 'DROVE-1': { title: 'old', status: 'done' }, 'DROVE-5': { title: 'open', status: 'backlog' } })
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  process.env.HERDR_PANE_ID = 'w1:p5'
  const code = async (request: Partial<commands.PlanRequest>) => {
    const planned = await commands.plan(deps, { repo, kind: 'claude', ...request })
    return planned.ok ? 'ok' : planned.code
  }
  assert.equal(await code({ cairn: 'DROVE-1' }), 'task-closed')
  assert.equal(await code({ cairn: 'DROVE-404' }), 'no-task')
  assert.equal(await code({ cairn: 'nope' }), 'usage')
  assert.equal(await code({ cairn: 'DROVE-5', goal: 'also this' }), 'usage')
  assert.equal(await code({ cairn: 'DROVE-5', next: 'DROVE' }), 'usage')

  const offline = new FakeHerdr()
  const base = offline.exec
  offline.exec = async (argv, options) => (argv[0] === 'cairn' ? { code: 127, stdout: '', stderr: 'command not found' } : base(argv, options))
  const planned = await commands.plan(await makeDeps(offline), { repo, kind: 'claude', cairn: 'DROVE-5' })
  assert.equal(!planned.ok && planned.code, 'cairn')
})

test('plan --next picks the first task cairn ranks for the project and goes on as --from-cairn does', async () => {
  const fake = new FakeHerdr()
  const { calls } = stubCairn(
    fake,
    { 'DROVE-69': { title: 'Migrate', status: 'backlog', description: 'Body 69' }, 'DROVE-71': { title: 'Owned files', status: 'backlog', description: 'Body 71' } },
    ['DROVE-69', 'DROVE-71'],
  )
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan(deps, { repo, kind: 'codex', next: 'DROVE' })
  assert.equal(planned.ok, true, planned.text)
  assert.deepEqual(calls.map(call => call.slice(1, 3)), [['next', '--project'], ['show', 'DROVE-69']])
  assert.deepEqual(calls[0], ['cairn', 'next', '--project', 'DROVE', '--json'])
  const processPlan = (planned.ok ? planned.data : undefined) as commands.ProcessPlan
  const run = await loadRun(deps.home, processPlan.env.DROVE_RUN as string)
  assert.deepEqual([run?.cairn, run?.goal], ['DROVE-69', 'DROVE-69: Migrate'])
  assert.match(processPlan.argv.at(-1) ?? '', /Body 69/)

  process.env.HERDR_PANE_ID = 'w1:p6'
  const none = await commands.plan(deps, { repo, kind: 'claude', next: 'EMPTY' })
  assert.equal(!none.ok && none.code, 'no-task')
  const bad = await commands.plan(deps, { repo, kind: 'claude', next: 'drove' })
  assert.equal(!bad.ok && bad.code, 'usage')
})

test('a plan attached to an existing run keeps its goal task unless a new one is given', async () => {
  const fake = new FakeHerdr()
  stubCairn(fake, { 'DROVE-8': { title: 'Other', status: 'doing' } })
  const { deps, repo } = await setup(fake, 'DROVE-70')
  process.env.HERDR_PANE_ID = 'w1:p5'
  const kept = await commands.plan(deps, { repo, kind: 'claude', run: RUN })
  assert.equal(kept.ok, true, kept.text)
  assert.equal((await loadRun(deps.home, RUN))?.cairn, 'DROVE-70')
  const moved = await commands.plan(deps, { repo, kind: 'claude', run: RUN, cairn: 'DROVE-8' })
  assert.equal(moved.ok, true, moved.text)
  assert.equal((await loadRun(deps.home, RUN))?.cairn, 'DROVE-8')
})

test('down writes a summary note on the goal task: seats, which closed, their branches and what is still open', async () => {
  const fake = new FakeHerdr({ startSession: 'codex-thread' })
  const { notes } = stubCairn(fake, { 'DROVE-5': { title: 'a', status: 'doing' }, 'DROVE-6': { title: 'b', status: 'doing' } })
  const { deps, identity } = await setup(fake, 'DROVE-70')
  await commands.spawn(deps, identity, { seat: 'w-a', kind: 'claude', cairn: 'DROVE-5', brief })
  await commands.spawn(deps, identity, { seat: 'w-b', kind: 'codex', cairn: 'DROVE-6', brief })
  const closed = await commands.close(deps, identity, 'w-a', false)
  assert.equal(closed.ok, true, closed.text)
  fake.setStatus('w-b', 'idle')
  const downed = await commands.down(deps, { run: RUN, repo: '/x' })
  assert.equal(downed.ok, true, downed.text)
  assert.match(downed.text, /Wrote a summary note on the goal task DROVE-70/)
  const [note] = notes()
  assert.deepEqual(note?.slice(0, 3), ['cairn', 'note', 'DROVE-70'])
  const text = note?.[3] ?? ''
  assert.match(text, new RegExp(`run ${RUN} was taken down`))
  assert.match(text, /Seats \(1 closed, 1 open\)/)
  assert.match(text, /- w-a \(claude, DROVE-5\): closed; branch \S+/)
  assert.match(text, /- w-b \(codex, DROVE-6\): still open, down, resumable; branch drove\/w-b/)
  assert.match(text, /Still open: DROVE-6\./)
  assert.equal(notes().length, 1)
})

test('down writes no note without a goal task, and still comes down when cairn fails', async () => {
  const plain = new FakeHerdr()
  const { notes } = stubCairn(plain, {})
  const first = await setup(plain)
  await commands.spawn(first.deps, first.identity, { seat: 'w-a', kind: 'claude', brief })
  plain.setStatus('w-a', 'idle')
  const downedPlain = await commands.down(first.deps, { run: RUN, repo: '/x' })
  assert.equal(downedPlain.ok, true, downedPlain.text)
  assert.equal(notes().length, 0)
  assert.doesNotMatch(downedPlain.text, /summary note/)

  for (const failure of ['exit', 'throw'] as const) {
    const fake = new FakeHerdr()
    const base = fake.exec
    fake.exec = async (argv, options) => {
      if (argv[0] !== 'cairn') return base(argv, options)
      if (failure === 'throw') throw new Error('spawn cairn ENOENT')
      return { code: 1, stdout: '', stderr: `${NOISE}database locked` }
    }
    const { deps } = await setup(fake, 'DROVE-70')
    const downed = await commands.down(deps, { run: RUN, repo: '/x' })
    assert.equal(downed.ok, true, downed.text)
    assert.match(downed.text, /summary note on DROVE-70 was not written/)
    assert.doesNotMatch(downed.text, /could not be checked/)
    assert.equal((await loadRun(deps.home, RUN))?.status, 'down')
  }
})

test('a real cairn executable on PATH is read as JSON, so the goal comes from its title and body', async () => {
  const bin = await tmp('cairn-bin')
  await mkdir(bin, { recursive: true })
  const script = join(bin, 'cairn')
  await writeFile(
    script,
    `#!/bin/sh
echo "cairn: acme could not be checked (stale project cache); routing DROVE to personal on its own record" >&2
case "$1 $2" in
  "--version ") echo "cairn 0.22.3" ;;
  "projects ") echo "DROVE" ;;
  "show DROVE-9") printf '%s' '{"ref":"DROVE-9","title":"From PATH","status":"todo","description":"Real body"}' ;;
  *) echo "No task $2." >&2; exit 1 ;;
esac
`,
  )
  await chmod(script, 0o755)
  const fake = new FakeHerdr()
  const base = fake.exec
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  const withPath: Deps = {
    ...deps,
    exec: (argv, options = {}) => (argv[0] === 'cairn' ? commands.nodeExec(argv, { ...options, env: { ...options.env, PATH: `${bin}:${process.env.PATH ?? ''}` } }) : base(argv, options)),
  }
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan(withPath, { repo, kind: 'claude', cairn: 'DROVE-9' })
  assert.equal(planned.ok, true, planned.text)
  const processPlan = (planned.ok ? planned.data : undefined) as commands.ProcessPlan
  assert.equal((await loadRun(deps.home, processPlan.env.DROVE_RUN as string))?.goal, 'DROVE-9: From PATH')
  assert.match(processPlan.argv.at(-1) ?? '', /Real body/)
  process.env.HERDR_PANE_ID = 'w1:p6'
  const missing = await commands.plan(withPath, { repo, kind: 'claude', cairn: 'DROVE-10' })
  assert.equal(!missing.ok && missing.code, 'no-task')
})


test('plan Cairn reads carry the planner kind and preserve an explicit CAIRN_AGENT (DROVE-160)', async () => {
  const previous = process.env.CAIRN_AGENT
  try {
    for (const [kind, explicit, expected] of [
      ['claude', undefined, 'claude-code'],
      ['codex', undefined, 'codex'],
      ['claude', 'maintenance', 'maintenance'],
      ['codex', '', ''],
    ] as const) {
      if (explicit === undefined) delete process.env.CAIRN_AGENT
      else process.env.CAIRN_AGENT = explicit
      const fake = new FakeHerdr()
      const base = fake.exec
      let agent: string | undefined
      fake.exec = async (argv, options) => {
        if (argv[0] !== 'cairn') return base(argv, options)
        agent = options?.env?.CAIRN_AGENT
        const probe = cairnProbe(argv)
        if (probe) return (assert.equal(agent, expected, 'the Cairn detection carries the planner kind too'), probe)
        return { code: 1, stdout: '', stderr: 'CAIRN_API_KEY is not set (~/.cairn/instances/croft/env).' }
      }
      const deps = await makeDeps(fake)
      process.env.HERDR_PANE_ID = 'w1:p5'
      const result = await commands.plan(deps, { repo: await makeRepo(), kind, cairn: 'DROVE-160' })
      assert.equal(agent, expected)
      assert.equal(result.ok, false)
      assert.match(result.text, /set CAIRN_AGENT=claude-code or codex \(the runtime whose key the instance holds\)/)
    }
  } finally {
    if (previous === undefined) delete process.env.CAIRN_AGENT
    else process.env.CAIRN_AGENT = previous
  }
})

test('spawn Cairn check uses the run planner kind, independently of worker kind (DROVE-160)', async () => {
  const previous = process.env.CAIRN_AGENT
  try {
    for (const [kind, explicit, expected] of [
      ['claude', undefined, 'claude-code'], ['codex', undefined, 'codex'], ['codex', 'maintenance', 'maintenance'],
    ] as const) {
      if (explicit === undefined) delete process.env.CAIRN_AGENT
      else process.env.CAIRN_AGENT = explicit
      const fake = new FakeHerdr()
      const base = fake.exec
      let agent: string | undefined
      fake.exec = async (argv, options) => {
        if (argv[0] !== 'cairn') return base(argv, options)
        agent = options?.env?.CAIRN_AGENT
        return { code: 0, stdout: JSON.stringify({ title: 'Closed', status: 'done' }), stderr: '' }
      }
      const repo = await makeRepo()
      const deps = await makeDeps(fake)
      await seedRun(deps, repo, [], { planner: { kind, paneId: 'w1:p5', model: '', effort: 'high', viaMod: false } })
      const result = await commands.spawn(deps, planner(deps), { seat: 'w-check', kind: kind === 'codex' ? 'claude' : 'codex', cairn: 'DROVE-160', brief })
      assert.equal(agent, expected)
      assert.equal(!result.ok && result.code, 'task-closed')
    }
  } finally {
    if (previous === undefined) delete process.env.CAIRN_AGENT
    else process.env.CAIRN_AGENT = previous
  }
})
