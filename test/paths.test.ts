import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as paths from '../src/paths.ts'

test('env names are fixed', () => {
  assert.deepEqual(Object.values(paths.ENV), ['DROVE_HOME', 'DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT', 'DROVE_TOKEN'])
})

test('seat names follow the herdr agent-name rule', () => {
  assert.match('w-api', paths.SEAT_RE)
  assert.match(paths.PLANNER_SEAT, paths.SEAT_RE)
  assert.doesNotMatch('W-api', paths.SEAT_RE)
  assert.doesNotMatch('a'.repeat(33), paths.SEAT_RE)
})

test('defaultHome honours DROVE_HOME and falls back to ~/.drove', () => {
  assert.equal(paths.defaultHome({ DROVE_HOME: '/tmp/x' }), '/tmp/x')
  assert.match(paths.defaultHome({}), /\.drove$/)
})

test('run ids follow <repo>-<yyyymmdd>-<hhmm>-<4 hex>', () => {
  const id = paths.newRunId('/Users/test/src/Drove Repo', new Date(2026, 9, 9, 10, 42))
  assert.match(id, /^drove-repo-20261009-1042-[0-9a-f]{4}$/)
  assert.notEqual(id, paths.newRunId('/x/drove', new Date(2026, 9, 9, 10, 42)))
})

test('directories and names compose', () => {
  assert.equal(paths.runDir('/h', 'r1'), '/h/runs/r1')
  assert.equal(paths.seatDir('/h', 'r1', 'w-api'), '/h/runs/r1/seats/w-api')
  assert.equal(paths.plannerDir('/h', 'r1'), '/h/runs/r1/planner')
  assert.equal(paths.worktreePath('/repo', 'w-api'), '/repo/.claude/worktrees/w-api')
  assert.equal(paths.branchName('w-api'), 'drove/w-api')
})

test('identity round-trips through the env', () => {
  const identity = { home: '/h', run: 'r1', role: 'worker' as const, seat: 'w-api', token: 'abc' }
  const env = paths.identityEnv(identity)
  assert.deepEqual(env, { DROVE_HOME: '/h', DROVE_RUN: 'r1', DROVE_ROLE: 'worker', DROVE_SEAT: 'w-api', DROVE_TOKEN: 'abc' })
  assert.deepEqual(paths.identityFromEnv(env), identity)
})

test('planner identity has no token', () => {
  const env = paths.identityEnv({ home: '/h', run: 'r1', role: 'planner', seat: 'planner' })
  assert.equal('DROVE_TOKEN' in env, false)
  assert.equal(paths.identityFromEnv(env)?.token, undefined)
})

test('identityFromEnv rejects incomplete or invalid env', () => {
  assert.equal(paths.identityFromEnv({}), undefined)
  assert.equal(paths.identityFromEnv({ DROVE_RUN: 'r', DROVE_ROLE: 'boss', DROVE_SEAT: 'w' }), undefined)
  assert.equal(paths.identityFromEnv({ DROVE_RUN: 'r', DROVE_ROLE: 'worker', DROVE_SEAT: 'Bad Seat' }), undefined)
  assert.equal(paths.identityFromEnv({ DROVE_ROLE: 'worker', DROVE_SEAT: 'w' }), undefined)
})

test('the Drove CODEX_HOME is per run, and the user Codex home ignores a CODEX_HOME inherited from a Drove pane', () => {
  assert.equal(paths.codexHomeDir('/h/.drove', 'r-1'), '/h/.drove/runs/r-1/codex-home')
  assert.equal(paths.userCodexHome('/h/.drove', { CODEX_HOME: '/h/my-codex' }), '/h/my-codex')
  assert.match(paths.userCodexHome('/h/.drove', { CODEX_HOME: '/h/.drove/runs/r-1/codex-home' }), /\/\.codex$/)
  assert.match(paths.userCodexHome('/h/.drove', {}), /\/\.codex$/)
  assert.equal(paths.userCodexHome('/h/.drove', { CODEX_HOME: '/h/.drove-other' }), '/h/.drove-other')
})
