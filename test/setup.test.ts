import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { main } from '../src/cli.ts'
import type { DoctorReport } from '../src/doctor.ts'
import { runSetup, type SetupDeps, type SetupOptions, type SetupResult } from '../src/setup.ts'

const DOCTOR: DoctorReport = { ok: true, checks: [{ id: 'herdr', status: 'ok', detail: 'herdr 0.9.0' }, { id: 'herdr-server', status: 'ok', detail: 'herdr server reachable' }, { id: 'mod', status: 'ok', detail: 'the Claude mod loads' }] }

const clone = async (root: string): Promise<string> => {
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'cli.ts'), '#!/usr/bin/env node\n')
  await chmod(join(root, 'src', 'cli.ts'), 0o755)
  await mkdir(join(root, 'mod', '.claude-plugin'), { recursive: true })
  await writeFile(join(root, 'mod', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'orchestrator' }))
  return root
}

const machine = async (extra: Partial<SetupDeps> = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drove-setup-')))
  const home = join(root, 'home')
  const claudeDir = join(root, 'claude-config')
  await mkdir(home, { recursive: true })
  await mkdir(claudeDir, { recursive: true })
  const droveRoot = await clone(join(root, 'drove'))
  const deps: SetupDeps = {
    droveRoot,
    userHome: home,
    claudeDir,
    droveHome: join(home, '.drove'),
    binDir: join(home, '.local', 'bin'),
    pathEnv: join(root, 'empty-bin'),
    isTTY: false,
    ask: async () => true,
    now: () => new Date('2026-10-13T09:30:00Z'),
    doctor: async () => DOCTOR,
    ...extra,
  }
  return { root, home, claudeDir, droveRoot, deps, settings: join(claudeDir, 'settings.json') }
}

const run = async (deps: SetupDeps, options: Partial<SetupOptions> = {}) => {
  const out: string[] = []
  const err: string[] = []
  const code = await runSetup(deps, { steps: [], yes: false, dryRun: false, json: false, ...options }, { out: text => out.push(text), err: text => err.push(text) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const runJson = async (deps: SetupDeps, options: Partial<SetupOptions> = {}) => {
  const outcome = await run(deps, { ...options, json: true })
  return { ...outcome, result: JSON.parse(outcome.out) as SetupResult }
}

// Every path under root with its mtime, so a run that writes nothing leaves this unchanged.
const snapshot = async (root: string): Promise<Record<string, number>> => {
  const entries = await readdir(root, { recursive: true })
  const pairs = await Promise.all(entries.map(async entry => [entry, (await lstat(join(root, entry))).mtimeMs] as const))
  return Object.fromEntries(pairs.sort(([a], [b]) => a.localeCompare(b)))
}

const exists = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined)) !== undefined

test('AC1: drove setup --yes links the CLI, adds the mod, makes DROVE_HOME and backs up the old settings', async () => {
  const m = await machine()
  const old = `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`
  await writeFile(m.settings, old)
  const { code, result } = await runJson(m.deps, { yes: true })
  assert.equal(code, 0)
  assert.deepEqual(result.steps.map(step => [step.step, step.status]), [['cli', 'written'], ['mod', 'written'], ['home', 'written']])
  assert.equal(await readlink(join(m.deps.binDir, 'drove')), join(m.droveRoot, 'src', 'cli.ts'))
  const settings = JSON.parse(await readFile(m.settings, 'utf8'))
  assert.deepEqual(settings, { theme: 'dark', env: { CLAUDE_CODE_PLUGIN_DIRS: join(m.droveRoot, 'mod') } })
  assert.ok((await stat(m.deps.droveHome)).isDirectory())
  const backup = result.steps.find(step => step.step === 'mod')?.backup ?? ''
  assert.equal(backup, `${m.settings}.drove-backup-20261013T093000Z`)
  assert.equal(await readFile(backup, 'utf8'), old)
  assert.equal(await exists(join(m.home, '.claude.json')), false)
  assert.equal(await exists(join(m.claudeDir, '.claude.json')), false)
  assert.deepEqual(result.doctor, DOCTOR)
  assert.ok(result.left.some(item => /herdr/.test(item)) === false, 'a passing herdr check drops the herdr line')
  assert.ok(result.left.some(item => /gh auth login/.test(item)))
  assert.ok(result.left.some(item => /folder-trust/.test(item)))
  assert.ok(result.left.some(item => /not on PATH/.test(item)), 'the bin dir is not on PATH here')
})

test('AC2: a second drove setup --yes writes nothing and reports every step done', async () => {
  const m = await machine()
  await writeFile(m.settings, '{}\n')
  assert.equal((await run(m.deps, { yes: true })).code, 0)
  const before = await snapshot(m.root)
  const { code, result } = await runJson(m.deps, { yes: true })
  assert.equal(code, 0)
  assert.deepEqual(result.steps.map(step => step.status), ['done', 'done', 'done'])
  assert.deepEqual(await snapshot(m.root), before)
  const text = await run(m.deps, { yes: true })
  assert.doesNotMatch(text.out, /^Plan:/m)
  assert.deepEqual(await snapshot(m.root), before)
})

test('AC2: a fresh machine with no settings.json gets one, and no backup', async () => {
  const m = await machine()
  const { result } = await runJson(m.deps, { yes: true })
  assert.equal(result.steps.find(step => step.step === 'mod')?.backup, undefined)
  assert.deepEqual(JSON.parse(await readFile(m.settings, 'utf8')), { env: { CLAUDE_CODE_PLUGIN_DIRS: join(m.droveRoot, 'mod') } })
  assert.deepEqual((await runJson(m.deps, { yes: true })).result.steps.map(step => step.status), ['done', 'done', 'done'])
})

test('AC3: drove setup mod --yes runs the mod step only and still prints the doctor summary', async () => {
  const m = await machine()
  const out: string[] = []
  const err: string[] = []
  const code = await main(['setup', 'mod', '--yes'], { out: text => out.push(text), err: text => err.push(text), stdin: async () => '', setupDeps: m.deps })
  assert.equal(code, 0, err.join('\n'))
  const text = out.join('\n')
  assert.match(text, /^mod\s+written/m)
  assert.doesNotMatch(text, /^(cli|home)\s/m)
  assert.match(text, /^ok\s+herdr\s+herdr 0\.9\.0$/m)
  assert.match(text, /^ready$/m)
  assert.match(text, /Left for you:/)
  assert.equal(await exists(join(m.deps.binDir, 'drove')), false)
  assert.equal(await exists(m.deps.droveHome), false)
})

test('AC3: an unknown step is refused with the valid ones, and named steps keep their order', async () => {
  const m = await machine()
  const err: string[] = []
  const code = await main(['setup', 'mod', 'herdr'], { out: () => undefined, err: text => err.push(text), stdin: async () => '', setupDeps: m.deps })
  assert.equal(code, 2)
  assert.match(err.join('\n'), /unknown setup step herdr; valid steps: cli, mod, home/)
  assert.equal(await exists(m.settings), false)
  const { result } = await runJson(m.deps, { yes: true, steps: ['home', 'cli'] })
  assert.deepEqual(result.steps.map(step => step.step), ['cli', 'home'])
})

test('AC4: other plugin dirs and settings keys survive, and another clone’s mod is replaced in place', async () => {
  const m = await machine()
  const other = await clone(join(m.home, 'old-drove'))
  const original = {
    theme: 'dark',
    permissions: { allow: ['Bash(ls:*)'], deny: [] },
    enabledPlugins: { 'x@market': true },
    env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: ['/plugins/a', '~/old-drove/mod', '/plugins/b'].join(delimiter) },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
  }
  await writeFile(m.settings, JSON.stringify(original))
  const { code, result } = await runJson(m.deps, { yes: true, steps: ['mod'] })
  assert.equal(code, 0)
  const mod = result.steps[0]
  assert.equal(mod?.before, original.env.CLAUDE_CODE_PLUGIN_DIRS)
  assert.match(mod?.detail ?? '', /another clone's mod \(~\/old-drove\/mod\)/)
  const after = JSON.parse(await readFile(m.settings, 'utf8'))
  assert.deepEqual(after, { ...original, env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: ['/plugins/a', join(m.droveRoot, 'mod'), '/plugins/b'].join(delimiter) } })
  assert.deepEqual(Object.keys(after), Object.keys(original))
  assert.ok(await exists(join(other, 'mod')), 'the other clone itself is left alone')
})

test("AC4: an entry written with ~ that is this clone's mod counts as done", async () => {
  const m = await machine()
  const droveRoot = await clone(join(m.home, 'src', 'drove'))
  const text = JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: `/plugins/a${delimiter}~/src/drove/mod` } })
  await writeFile(m.settings, text)
  const { result } = await runJson({ ...m.deps, droveRoot }, { yes: true, steps: ['mod'] })
  assert.equal(result.steps[0]?.status, 'done')
  assert.equal(await readFile(m.settings, 'utf8'), text)
})

test('AC5: without a terminal and without --yes, setup prints the plan, writes nothing and exits non-zero naming --yes', async () => {
  const m = await machine()
  await writeFile(m.settings, '{"theme":"dark"}')
  const before = await snapshot(m.root)
  const { code, out, err } = await run(m.deps)
  assert.equal(code, 1)
  assert.match(out, /^Plan:\n {2}cli: .*\/\.local\/bin\/drove: \(none\) -> .*\/src\/cli\.ts$/m)
  assert.match(out, /^ {2}mod: .*settings\.json: \(none\) -> .*\/mod$/m)
  assert.match(out, /^ {2}home: .*\.drove: \(none\) -> folder$/m)
  assert.match(out, /^ready$/m, 'the doctor still runs')
  assert.match(err, /--yes/)
  assert.deepEqual(await snapshot(m.root), before)
  const json = await runJson({ ...m.deps, isTTY: true })
  assert.equal(json.code, 1)
  assert.match(json.result.error ?? '', /--yes/)
  assert.deepEqual(json.result.steps.map(step => step.status), ['change', 'change', 'change'])
  assert.deepEqual(await snapshot(m.root), before)
})

test('--dry-run prints the plan, writes nothing and exits 0', async () => {
  const m = await machine({ isTTY: true, ask: async () => assert.fail('a dry run never asks') })
  const before = await snapshot(m.root)
  const { code, out } = await run(m.deps, { dryRun: true })
  assert.equal(code, 0)
  assert.match(out, /^Plan:/m)
  assert.deepEqual(await snapshot(m.root), before)
})

test('on a terminal each change is asked for, and a no leaves that step unwritten', async () => {
  const asked: string[] = []
  const m = await machine({ isTTY: true, ask: async question => (asked.push(question), !question.startsWith('mod')) })
  const { code, out } = await run(m.deps)
  assert.equal(code, 1)
  assert.equal(asked.length, 3)
  assert.match(asked[1] ?? '', /^mod: write .*settings\.json\? \[y\/N\] $/)
  assert.match(out, /^mod\s+declined/m)
  assert.equal(await exists(m.settings), false)
  assert.ok(await exists(join(m.deps.binDir, 'drove')))
  assert.ok(await exists(m.deps.droveHome))
})

test('unreadable settings, a non-link at the bin path and a file at DROVE_HOME are blocked and left alone', async () => {
  const m = await machine()
  await writeFile(m.settings, '{not json')
  await mkdir(m.deps.binDir, { recursive: true })
  await writeFile(join(m.deps.binDir, 'drove'), 'mine')
  await writeFile(m.deps.droveHome, 'a file')
  const before = await snapshot(m.root)
  const { code, result } = await runJson(m.deps, { yes: true })
  assert.equal(code, 1)
  assert.deepEqual(result.steps.map(step => step.status), ['blocked', 'blocked', 'blocked'])
  assert.match(result.steps[0]?.detail ?? '', /--bin DIR/)
  assert.match(result.steps[1]?.detail ?? '', /not valid JSON/)
  assert.deepEqual(await snapshot(m.root), before)
})

test('the cli step: drove on PATH that is this clone is done; a link to another clone is replaced', async () => {
  const m = await machine()
  const pathBin = join(m.root, 'path-bin')
  await mkdir(pathBin, { recursive: true })
  await symlink(join(m.droveRoot, 'src', 'cli.ts'), join(pathBin, 'drove'))
  const onPath = await runJson({ ...m.deps, pathEnv: pathBin }, { yes: true, steps: ['cli'] })
  assert.equal(onPath.result.steps[0]?.status, 'done')
  assert.equal(await exists(join(m.deps.binDir, 'drove')), false)

  const other = await clone(join(m.root, 'other'))
  await mkdir(m.deps.binDir, { recursive: true })
  await symlink(join(other, 'src', 'cli.ts'), join(m.deps.binDir, 'drove'))
  const replaced = await runJson({ ...m.deps, pathEnv: m.deps.binDir }, { yes: true, steps: ['cli'] })
  assert.equal(replaced.result.steps[0]?.status, 'written')
  assert.equal(replaced.result.steps[0]?.before, join(other, 'src', 'cli.ts'))
  assert.equal(await readlink(join(m.deps.binDir, 'drove')), join(m.droveRoot, 'src', 'cli.ts'))
  assert.equal(replaced.result.steps[0]?.note, undefined)
  assert.equal(replaced.result.left.some(item => /PATH/.test(item)), false)
})

test('a settings.json that is a link is written through to its target', async () => {
  const m = await machine()
  const dotfiles = join(m.root, 'dotfiles')
  await mkdir(dotfiles, { recursive: true })
  await writeFile(join(dotfiles, 'settings.json'), '{"theme":"light"}')
  await symlink(join(dotfiles, 'settings.json'), m.settings)
  await runJson(m.deps, { yes: true, steps: ['mod'] })
  assert.ok((await lstat(m.settings)).isSymbolicLink())
  assert.equal(JSON.parse(await readFile(join(dotfiles, 'settings.json'), 'utf8')).env.CLAUDE_CODE_PLUGIN_DIRS, join(m.droveRoot, 'mod'))
})
