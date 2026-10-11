import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import * as commands from '../src/commands.ts'
import * as deliver from '../src/deliver.ts'
import { loadRun } from '../src/roster.ts'
import type { Deps, ExecResult } from '../src/types.ts'
import { FakeHerdr, makeDeps, makeRepo, RUN, seedRun, tmp } from './p3-helpers.ts'

beforeEach(() => {
  Object.assign(deliver.confirmTiming, { waitMs: 30, pollMs: 5 })
  Object.assign(commands.timing, { pollMs: 1, exitWaitMs: 50, closeWaitMs: 20, lockWaitMs: 20, promptWaitMs: 5 })
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_ROLE_IN_BRIEF', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_BRIEF_VIA = 'launch-arg'
})

const NOISE = 'cairn: acme could not be checked (stale project cache); routing DROVE to personal on its own record\n'

const LAB_SUBJECT = {
  ref: 'LAB-21',
  title: 'Drove as a software factory',
  body: '## Idea\n\nStart with orchestration.',
  todos: [
    { ref: 'DROVE-91', title: 'Reviewer seats', status: 'in-review' },
    { ref: 'DROVE-97', title: 'Remote machine', status: 'todo' },
    { ref: 'DROVE-92', title: 'A merge gate', status: 'done' },
    { ref: 'DROVE-3', title: 'Dropped idea', status: 'cancelled' },
  ],
}

// A cairn stand-in that answers `--instance <name> subject show|note` and records every call.
const stubLab = (fake: FakeHerdr, instances: Record<string, Record<string, unknown>> = { croft: { 'LAB-21': LAB_SUBJECT } }) => {
  const calls: string[][] = []
  const base = fake.exec
  fake.exec = async (argv, options) => {
    if (argv[0] !== 'cairn') return base(argv, options)
    calls.push([...argv])
    const flag = argv.indexOf('--instance')
    const instance = flag >= 0 ? argv[flag + 1] : undefined
    const [sub, verb, ref] = argv.slice(flag >= 0 ? 3 : 1)
    const reply = (stdout: string, code = 0, stderr = ''): ExecResult => ({ code, stdout, stderr: `${NOISE}${stderr}` })
    if (sub !== 'subject' || !instance) return reply('', 2, 'unexpected')
    if (verb === 'show') {
      const subject = ref ? instances[instance]?.[ref] : undefined
      return subject ? reply(JSON.stringify(subject)) : reply('', 1, `No subject ${ref}. Subjects are addressed as LAB-12.\n`)
    }
    return verb === 'note' ? reply('') : reply('', 2, 'unknown verb')
  }
  return { calls, notes: () => calls.filter(call => call.includes('note')) }
}

test('plan --from-cairn LAB-n reads the subject from the lab instance: goal, write-up and open todos only', async () => {
  const fake = new FakeHerdr()
  const { calls } = stubLab(fake)
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan(deps, { repo, kind: 'claude', cairn: 'LAB-21' })
  assert.equal(planned.ok, true, planned.text)
  assert.deepEqual(calls[0], ['cairn', '--instance', 'croft', 'subject', 'show', 'LAB-21', '--json'])
  assert.match(planned.text, /on Lab subject LAB-21/)
  const processPlan = (planned.ok ? planned.data : undefined) as commands.ProcessPlan
  const run = await loadRun(deps.home, processPlan.env.DROVE_RUN as string)
  assert.deepEqual([run?.cairn, run?.goal], ['LAB-21', 'LAB-21: Drove as a software factory'])
  const prompt = processPlan.argv.at(-1) ?? ''
  assert.match(prompt, /Start with orchestration\./)
  assert.match(prompt, /- DROVE-91: Reviewer seats/)
  assert.match(prompt, /- DROVE-97: Remote machine/)
  assert.doesNotMatch(prompt, /DROVE-92|DROVE-3\b/)
  assert.match(prompt, /one worker per todo/)
  assert.match(prompt, /cairn --instance croft subject note LAB-21/)
  assert.match(prompt, /Never close the subject/)
})

test('plan --from-cairn refuses a missing subject, a bad ref and --goal beside it', async () => {
  const fake = new FakeHerdr()
  stubLab(fake)
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  process.env.HERDR_PANE_ID = 'w1:p5'
  const code = async (request: Partial<commands.PlanRequest>) => {
    const planned = await commands.plan(deps, { repo, kind: 'claude', ...request })
    return planned.ok ? 'ok' : planned.code
  }
  assert.equal(await code({ cairn: 'LAB-404' }), 'no-task')
  assert.equal(await code({ cairn: 'LAB-x' }), 'usage')
  assert.equal(await code({ cairn: 'LAB-21', goal: 'also this' }), 'usage')
})

test('labInstance in config picks the cairn instance for the read and for the down note', async () => {
  const fake = new FakeHerdr()
  const { calls, notes } = stubLab(fake, { elsewhere: { 'LAB-21': LAB_SUBJECT } })
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await writeFile(join(deps.home, 'config.json'), JSON.stringify({ labInstance: 'elsewhere' }))
  process.env.HERDR_PANE_ID = 'w1:p5'
  const planned = await commands.plan(deps, { repo, kind: 'claude', cairn: 'LAB-21' })
  assert.equal(planned.ok, true, planned.text)
  assert.deepEqual(calls[0]?.slice(0, 3), ['cairn', '--instance', 'elsewhere'])
  const processPlan = (planned.ok ? planned.data : undefined) as commands.ProcessPlan
  assert.match(processPlan.argv.at(-1) ?? '', /cairn --instance elsewhere subject note LAB-21/)
  const downed = await commands.down(deps, { run: processPlan.env.DROVE_RUN as string, repo })
  assert.equal(downed.ok, true, downed.text)
  assert.match(downed.text, /Wrote a summary note on the goal subject LAB-21/)
  assert.deepEqual(notes()[0]?.slice(0, 6), ['cairn', '--instance', 'elsewhere', 'subject', 'note', 'LAB-21'])
})

test('down writes the summary as a subject note on the croft instance when the run goal is a LAB ref', async () => {
  const fake = new FakeHerdr()
  const { notes } = stubLab(fake)
  const repo = await makeRepo()
  const deps = await makeDeps(fake)
  await seedRun(deps, repo, [], { cairn: 'LAB-21' })
  const downed = await commands.down(deps, { run: RUN, repo: '/x' })
  assert.equal(downed.ok, true, downed.text)
  assert.match(downed.text, /Wrote a summary note on the goal subject LAB-21/)
  assert.equal(notes().length, 1)
  assert.deepEqual(notes()[0]?.slice(0, 6), ['cairn', '--instance', 'croft', 'subject', 'note', 'LAB-21'])
  assert.match(notes()[0]?.[6] ?? '', new RegExp(`run ${RUN} was taken down`))
})

test('a real cairn executable on PATH: --instance subject show --json is parsed', async () => {
  const bin = await tmp('lab-bin')
  await mkdir(bin, { recursive: true })
  const script = join(bin, 'cairn')
  await writeFile(
    script,
    `#!/bin/sh
echo "cairn: acme could not be checked (stale project cache); routing DROVE to personal on its own record" >&2
if [ "$1 $2 $3 $4 $5" = "--instance croft subject show LAB-9" ]; then
  printf '%s' '${JSON.stringify(LAB_SUBJECT).replace(/LAB-21/, 'LAB-9')}'
else
  echo "No subject $5." >&2; exit 1
fi
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
  const planned = await commands.plan(withPath, { repo, kind: 'claude', cairn: 'LAB-9' })
  assert.equal(planned.ok, true, planned.text)
  const processPlan = (planned.ok ? planned.data : undefined) as commands.ProcessPlan
  assert.equal((await loadRun(deps.home, processPlan.env.DROVE_RUN as string))?.goal, 'LAB-9: Drove as a software factory')
  const missing = await commands.plan(withPath, { repo, kind: 'claude', cairn: 'LAB-10' })
  assert.equal(!missing.ok && missing.code, 'no-task')
})
