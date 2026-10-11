import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as commands from '../src/commands.ts'

Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })

const root = () => mkdtemp(join(tmpdir(), 'drove-init-'))
const gitOut = (dir: string, ...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout.trim()

test('drove init makes a repo in a missing directory, with parents', async () => {
  const dir = join(await root(), 'a', 'b')
  const result = await commands.initRepo(commands.defaultDeps(), dir, '/', false)
  assert.equal(result.ok, true, result.text)
  assert.equal(gitOut(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(gitOut(dir, 'rev-list', '--count', 'HEAD'), '1')
  assert.equal(gitOut(dir, 'log', '-1', '--format=%s'), 'chore: initial empty commit')
})

test('drove init accepts an empty directory and reports JSON', async () => {
  const dir = await root()
  const result = await commands.initRepo(commands.defaultDeps(), dir, '/', true)
  assert.equal(result.ok, true, result.text)
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.branch, 'main')
  assert.match(parsed.path, /drove-init-/)
})

test('drove init refuses a non-empty directory', async () => {
  const dir = await root()
  await writeFile(join(dir, 'f'), 'x')
  const result = await commands.initRepo(commands.defaultDeps(), dir, '/', false)
  assert.equal(result.ok, false)
  assert.match(result.text, /not empty/)
})

test('drove init refuses an existing repo and a directory inside one', async () => {
  const dir = await root()
  assert.equal((await commands.initRepo(commands.defaultDeps(), dir, '/', false)).ok, true)
  const again = await commands.initRepo(commands.defaultDeps(), dir, '/', false)
  assert.equal(again.ok, false)
  assert.match(again.text, /already a git repository/)
  const nested = await commands.initRepo(commands.defaultDeps(), join(dir, 'sub'), '/', false)
  assert.equal(nested.ok, false)
  assert.match(nested.text, /inside the git repository/)
  await mkdir(join(dir, 'empty'))
  assert.equal((await commands.initRepo(commands.defaultDeps(), join(dir, 'empty'), '/', false)).ok, false)
})
