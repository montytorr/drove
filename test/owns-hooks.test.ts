import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as hooks from '../src/hooks.ts'
import { identityFromEnv } from '../src/paths.ts'

const NOW = new Date('2026-10-09T10:00:00.000Z')
const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'drove-owns-hook-')))
writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/w-owns\n')
mkdirSync(join(worktree, 'src'), { recursive: true })

const fakeDeps = () => {
  const written: { path: string; value: Record<string, unknown> }[] = []
  const deps: hooks.HookDeps = {
    now: () => NOW,
    identity: env => identityFromEnv(env),
    hooksPath: identity => `/h/${identity.seat}/hooks.jsonl`,
    eventsPath: () => '/h/events.jsonl',
    scratchRoot: () => '/h/scratch',
    append: async (path, value) => void written.push({ path, value: value as Record<string, unknown> }),
    openIds: async () => [],
    seatToken: async () => undefined,
    adoptGoal: async () => undefined,
  }
  return { deps, written }
}

const WORKER = { DROVE_HOME: '/h', DROVE_RUN: 'r1', DROVE_ROLE: 'worker', DROVE_SEAT: 'w-owns' }
const OWNS = JSON.stringify(['src/guard.ts', 'test/**'])
const pre = (tool: string, toolInput: Record<string, unknown>) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: worktree, tool_name: tool, tool_input: toolInput })

test('pre-tool-use: a worker with DROVE_OWNS is denied an edit outside its globs, and the deny is logged', async () => {
  const { deps, written } = fakeDeps()
  const env = { ...WORKER, DROVE_OWNS: OWNS }
  const denied = await hooks.runHook('pre-tool-use', pre('Edit', { file_path: join(worktree, 'src/launch.ts') }), env, deps)
  assert.equal(denied.code, 2)
  assert.match(denied.stderr, /this file is outside the paths your brief gives you \(src\/guard\.ts, test\/\*\*\); ask the planner with the drove report tool/)
  assert.equal(written.at(-1)?.value.type, 'guard.deny')
  assert.equal((await hooks.runHook('pre-tool-use', pre('Edit', { file_path: join(worktree, 'src/guard.ts') }), env, deps)).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'echo x > package.json' }), env, deps)).code, 2)
  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'echo x > test/a.txt' }), env, deps)).code, 0)
})

test('pre-tool-use: a worker with no DROVE_OWNS, or an unreadable one, may edit anywhere as before', async () => {
  const { deps } = fakeDeps()
  const input = pre('Edit', { file_path: join(worktree, 'src/launch.ts') })
  assert.equal((await hooks.runHook('pre-tool-use', input, WORKER, deps)).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', input, { ...WORKER, DROVE_OWNS: 'not json' }, deps)).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', input, { ...WORKER, DROVE_OWNS: '[]' }, deps)).code, 0)
})

test('a stop record carries the transcript path, so the watcher can read usage from it', async () => {
  const { deps, written } = fakeDeps()
  const stop = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd: worktree, transcript_path: '/home/u/.claude/projects/x/s1.jsonl' })
  await hooks.runHook('stop', stop, WORKER, deps)
  assert.equal(written.at(-1)?.value.transcript, '/home/u/.claude/projects/x/s1.jsonl')
  await hooks.runHook('stop', JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: null }), WORKER, deps)
  assert.equal('transcript' in (written.at(-1)?.value ?? {}), false)
})
