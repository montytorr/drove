import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import { beforeEach, test } from 'node:test'
import { parseArgs } from 'node:util'
import { COMMANDS, main, spawnRequestOf, splitGlobs } from '../src/cli.ts'
import type { ProcessPlan } from '../src/commands.ts'
import { saveRun } from '../src/roster.ts'
import { makeRepo, makeRun, RUN, tmp } from './p3-helpers.ts'

const capture = (stdin = '') => {
  const out: string[] = []
  const err: string[] = []
  const launched: ProcessPlan[] = []
  return {
    out, err, launched,
    io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text), stdin: async () => stdin, launch: async (plan: ProcessPlan) => (launched.push(plan), 7) },
  }
}

beforeEach(async () => {
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN', 'DROVE_AGENT', 'HERDR_PANE_ID']) delete process.env[key]
  process.env.DROVE_HOME = await tmp('cli-home')
})

test('cli knows the commands from the design', () => {
  assert.deepEqual(Object.keys(COMMANDS), ['plan', 'init', 'spawn', 'send', 'owns', 'prompt', 'promote', 'migrate', 'roster', 'reports', 'report', 'diagnose', 'trace', 'capture', 'close', 'merge', 'checks', 'board', 'down', 'up', 'attention', 'goal', 'doctor', 'budget', 'guard', 'mcp', 'mod'])
})

test('--owns splits on commas outside braces, and spawn reads --owns, --max-turns and --max-tokens', async () => {
  assert.deepEqual(splitGlobs('src/a.ts, test/**/*.{ts,tsx} ,{README,DESIGN}.md,'), ['src/a.ts', 'test/**/*.{ts,tsx}', '{README,DESIGN}.md'])
  assert.deepEqual(splitGlobs('a}, b'), ['a}', 'b'])
  assert.match(COMMANDS.spawn?.usage ?? '', /--owns GLOB,GLOB.*--max-turns N.*--max-tokens N/)
  const base = ['spawn', 'w-api', '--kind', 'claude', '--brief', 'x']
  for (const [extra, message] of [
    [['--owns', 'src/**,../other'], /--owns takes globs relative to the worktree/],
    [['--max-turns', 'abc'], /--max-turns must be a whole number of at least 1/],
    [['--max-tokens', '0'], /--max-tokens must be a whole number of at least 1/],
  ] as const) {
    const { err, io } = capture()
    assert.equal(await main([...base, ...extra], io), 1)
    assert.match(err.join('\n'), message)
  }
})

test('spawn reads --plugins and --user-memory, and checks their shape', async () => {
  assert.match(COMMANDS.spawn?.usage ?? '', /--plugins NAME,NAME.*--user-memory on\|off/)
  const base = ['spawn', 'w-api', '--kind', 'claude', '--brief', 'x']
  for (const [extra, code, message] of [
    [['--plugins', 'context7,a b'], 1, /--plugins takes plugin names separated by commas; got "a b"/],
    [['--user-memory', 'maybe'], 2, /--user-memory must be on or off; got "maybe"/],
  ] as const) {
    const { err, io } = capture()
    assert.equal(await main([...base, ...extra], io), code)
    assert.match(err.join('\n'), message)
  }
})

test("an empty --mcp or --plugins is the empty list, not a dropped option, and a missing one is undefined", () => {
  const requestOf = (...args: string[]) => {
    const { values, positionals } = parseArgs({ args: ['w-api', '--kind', 'claude', '--brief', 'x', ...args], options: COMMANDS.spawn?.options ?? {}, allowPositionals: true, strict: true })
    return spawnRequestOf(values as Parameters<typeof spawnRequestOf>[0], positionals, 'x')
  }
  const lean = requestOf('--mcp', '', '--plugins', '', '--user-memory', 'off')
  assert.deepEqual([lean.mcp, lean.plugins, lean.userMemory], [[], [], false])
  const named = requestOf('--mcp', 'notion, mongodb', '--plugins', 'context7', '--user-memory', 'on')
  assert.deepEqual([named.mcp, named.plugins, named.userMemory], [['notion', 'mongodb'], ['context7'], true])
  const open = requestOf()
  assert.deepEqual([open.mcp, open.plugins, open.userMemory], [undefined, undefined, undefined])
  assert.deepEqual([open.skills, open.agents, open.userHooks], [undefined, undefined, undefined])
  const trimmed = requestOf('--skills', '', '--agents', 'debugger, code-reviewer', '--user-hooks', 'off')
  assert.deepEqual([trimmed.skills, trimmed.agents, trimmed.userHooks], [[], ['debugger', 'code-reviewer'], false])
  assert.equal(requestOf('--user-hooks', 'on').userHooks, true)
})

test('cli --help prints usage and exits 0', async () => {
  const { out, io } = capture()
  assert.equal(await main(['--help'], io), 0)
  assert.match(out.join('\n'), /drove spawn <seat>/)
  assert.match(out.join('\n'), /drove up \[--run ID\] \[--seat SEAT\]/)
})

test('cli rejects an unknown command with 2', async () => {
  const { err, io } = capture()
  assert.equal(await main(['nope'], io), 2)
  assert.match(err.join('\n'), /unknown command nope/)
})

test('cli reports usage errors with 2', async () => {
  for (const argv of [['spawn', 'w-api'], ['send', 'w-api', '--kind', 'brief', 'x'], ['budget'], ['guard', 'nonsense'], ['promote', 'w-api', '--model', 'm'], ['migrate', 'w-api'], ['spawn', '--bogus']]) {
    const { err, io } = capture()
    assert.equal(await main(argv, io), 2, argv.join(' '))
    assert.ok(err.join('\n').length > 0)
  }
})

test('merge takes a seat, --pr, --squash, -m, --no-checks and --run; without a seat it is a usage error', async () => {
  const missing = capture()
  assert.equal(await main(['merge'], missing.io), 2)
  assert.match(missing.err.join('\n'), /missing <seat>[\s\S]*drove merge <seat> \[--pr\] \[--squash\] \[-m MSG\]/)
  for (const argv of [['merge', 'w-api', '--pr', '--squash', '-m', 'merge: x', '--run', 'no-such-run'], ['merge', 'w-api', '--no-checks', '--run', 'no-such-run']]) {
    const { err, io } = capture()
    assert.equal(await main(argv, io), 1, argv.join(' '))
    assert.match(err.join('\n'), /^no-run: no run named no-such-run/)
  }
  const { err, io } = capture()
  assert.equal(await main(['merge', 'w-api', '--bogus'], io), 2)
  assert.ok(err.join('\n').length > 0)
})

test('merge takes --fresh, and checks takes a seat and --fresh (DROVE-122)', async () => {
  assert.match(COMMANDS.merge?.usage ?? '', /\[--fresh\]/)
  const missing = capture()
  assert.equal(await main(['checks'], missing.io), 2)
  assert.match(missing.err.join('\n'), /missing <seat>[\s\S]*drove checks <seat> \[--fresh\]/)
  for (const argv of [['checks', 'w-api', '--fresh', '--run', 'no-such-run'], ['merge', 'w-api', '--fresh', '--run', 'no-such-run']]) {
    const { err, io } = capture()
    assert.equal(await main(argv, io), 1, argv.join(' '))
    assert.match(err.join('\n'), /^no-run: no run named no-such-run/)
  }
})

test('promote accepts a missing --model, so a Codex seat keeps its current one', async () => {
  const { err, io } = capture()
  assert.equal(await main(['promote', 'w-api', '--effort', 'high'], io), 1)
  assert.doesNotMatch(err.join('\n'), /missing --model/)
  assert.match(err.join('\n'), /^no-|forbidden|no-run/)
})

test('a command that fails prints code: text on stderr and exits 1', async () => {
  const { err, io } = capture()
  assert.equal(await main(['roster', '--run', 'no-such-run'], io), 1)
  assert.match(err.join('\n'), /^no-run: no run named no-such-run/)
})

test('drove guard with no Drove identity allows silently', async () => {
  const { out, err, io } = capture('{"tool_name":"Bash","tool_input":{"command":"ls"}}')
  assert.equal(await main(['guard', 'pre-tool-use'], io), 0)
  assert.deepEqual([out, err], [[], []])
})

test('drove plan prints the run line and hands the exec plan to the launcher, returning its exit code', async () => {
  process.env.HERDR_PANE_ID = 'w1:p5'
  const { out, launched, io } = capture()
  // In a repo of its own with a main branch: a CI checkout of a feature branch has no main, and drove plan needs a base.
  assert.equal(await inDir(await makeRepo('plan-repo'), () => main(['plan', '--kind', 'codex', '--goal', 'Do the goal'], io)), 7)
  assert.match(out.join('\n'), /^Run .* is up; starting the codex planner\./)
  assert.equal(launched.length, 1)
  assert.equal(launched[0]?.argv[0], 'codex')
  assert.equal(launched[0]?.argv.at(-1), 'Do the goal')
  assert.equal(launched[0]?.env.DROVE_ROLE, 'planner')
})

test('drove plan outside herdr fails with not-in-herdr and launches nothing', async () => {
  const { err, launched, io } = capture()
  assert.equal(await main(['plan'], io), 1)
  assert.match(err.join('\n'), /not-in-herdr/)
  assert.equal(launched.length, 0)
})

test('stdin feeds the text argument -', async () => {
  const sent = capture('body from stdin')
  assert.equal(await main(['send', 'w-api', '--kind', 'message', '-'], sent.io), 1)
  assert.match(sent.err.join('\n'), /no-run|no Drove run/)
})

const inDir = async <T>(dir: string, body: () => Promise<T>): Promise<T> => {
  const before = process.cwd()
  process.chdir(dir)
  try {
    return await body()
  } finally {
    process.chdir(before)
  }
}

test('drove board with no --run picks the up run for the repo it is run in', async () => {
  const repo = await realpath(await makeRepo('board-repo'))
  await saveRun(process.env.DROVE_HOME as string, makeRun(repo))
  const written: string[] = []
  const realWrite = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => (written.push(String(chunk)), true)) as typeof process.stdout.write
  try {
    const { err, io } = capture()
    assert.equal(await inDir(repo, () => main(['board', '--once'], io)), 0, err.join())
  } finally {
    process.stdout.write = realWrite
  }
  assert.ok(written.join('').includes(RUN))
})

test('drove board with no run anywhere names drove plan and --run', async () => {
  const { err, io } = capture()
  assert.equal(await inDir(await makeRepo('board-empty'), () => main(['board', '--once'], io)), 1)
  assert.match(err.join('\n'), /drove plan.*--run/)
})
