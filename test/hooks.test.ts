import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as hooks from '../src/hooks.ts'
import { runDir, seatDir } from '../src/paths.ts'
import { updateRoster, upsertSeat } from '../src/roster.ts'
import type { Identity, Seat } from '../src/types.ts'
import { assertExports } from './helpers.ts'

const NOW = new Date('2026-10-09T10:00:00.000Z')

type Written = { path: string; value: Record<string, unknown> }

const fakeDeps = (overrides: Partial<hooks.HookDeps> = {}) => {
  const written: Written[] = []
  const deps: hooks.HookDeps = {
    now: () => NOW,
    identity: env => (env.DROVE_ROLE ? { home: '/h', run: 'r1', role: env.DROVE_ROLE as Identity['role'], seat: env.DROVE_SEAT ?? 'planner' } : undefined),
    hooksPath: identity => `/h/${identity.role}/${identity.seat}/hooks.jsonl`,
    eventsPath: () => '/h/events.jsonl',
    scratchRoot: () => '/h/runs/r1/scratch',
    append: async (path, value) => void written.push({ path, value: value as Record<string, unknown> }),
    openIds: async () => ['w-api', 'sess-1'],
    ...overrides,
  }
  return { deps, written }
}

const PLANNER = { DROVE_ROLE: 'planner', DROVE_SEAT: 'planner' }
const WORKER = { DROVE_ROLE: 'worker', DROVE_SEAT: 'w-api' }
const pre = (tool: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/work/repo', tool_name: tool, tool_input: toolInput, ...extra })

test('hooks exports its interface', () => {
  assertExports(hooks, ['detectAgent', 'parseHookInput', 'renderHookOutput', 'toRecord', 'recordHook', 'runHook'])
  assert.equal(hooks.DENY_EXIT_CODE, 2)
  assert.ok(hooks.HOOK_EVENTS.includes('pre-tool-use'))
})

test('detectAgent reads the env, then the tool name, then turn_id', () => {
  assert.equal(hooks.detectAgent({}, {}), 'claude')
  assert.equal(hooks.detectAgent({ tool_name: 'Bash' }, {}), 'claude')
  assert.equal(hooks.detectAgent({ tool_name: 'exec_command' }, {}), 'codex')
  assert.equal(hooks.detectAgent({ tool_name: 'apply_patch' }, {}), 'codex')
  assert.equal(hooks.detectAgent({ tool_name: 'Bash', turn_id: 't1' }, {}), 'codex')
  assert.equal(hooks.detectAgent({ tool_name: 'shell' }, { DROVE_AGENT: 'claude' }), 'claude')
  assert.equal(hooks.detectAgent({}, { DROVE_AGENT: 'codex' }), 'codex')
})

test('parseHookInput reads Claude and Codex shapes', () => {
  const claude = hooks.parseHookInput('pre-tool-use', { session_id: 's1', cwd: '/w', tool_name: 'Bash', tool_input: { command: 'ls' } }, 'claude')
  assert.deepEqual(claude, { agent: 'claude', event: 'pre-tool-use', sessionId: 's1', cwd: '/w', tool: 'Bash', toolInput: { command: 'ls' } })
  const codex = hooks.parseHookInput('pre-tool-use', { session_id: 't9', tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'ls'] } }, 'codex')
  assert.deepEqual(codex.toolInput, { command: ['bash', '-lc', 'ls'] })
  assert.equal(codex.sessionId, 't9')
  assert.equal(hooks.parseHookInput('notification', { notification_type: 'permission_prompt', message: 'x' }, 'claude').detail, 'permission_prompt')
  assert.equal(hooks.parseHookInput('notification', { message: 'Claude needs input' }, 'claude').detail, 'Claude needs input')
  assert.equal(hooks.parseHookInput('session-start', { source: 'startup' }, 'claude').detail, 'startup')
  assert.equal(hooks.parseHookInput('permission-request', { tool_name: 'shell', tool_input: { command: ['rm', 'x'] } }, 'codex').detail, 'shell: rm x')
  assert.equal(hooks.parseHookInput('user-prompt-submit', { prompt: 'secret text' }, 'claude').detail, undefined)
  assert.equal(hooks.parseHookInput('stop', { tool_input: 'not an object' }, 'claude').toolInput, undefined)
  assert.ok((hooks.parseHookInput('notification', { message: 'x'.repeat(500) }, 'claude').detail ?? '').length <= 200)
})

test('renderHookOutput: exit 2 and stderr for both, JSON for Claude', () => {
  assert.deepEqual(hooks.renderHookOutput('claude', { allow: true }), { stdout: '', stderr: '', code: 0 })
  const claude = hooks.renderHookOutput('claude', { allow: false, reason: 'no' })
  assert.equal(claude.code, 2)
  assert.equal(claude.stderr, 'no')
  assert.deepEqual(JSON.parse(claude.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } })
  assert.deepEqual(hooks.renderHookOutput('codex', { allow: false, reason: 'no' }), { stdout: '', stderr: 'no', code: 2 })
})

test('toRecord keeps only what the roster needs', () => {
  const input = hooks.parseHookInput('session-start', { session_id: 's1', cwd: '/w', source: 'resume' }, 'codex')
  assert.deepEqual(hooks.toRecord(input, NOW), { at: NOW.toISOString(), agent: 'codex', event: 'session-start', sessionId: 's1', detail: 'resume' })
})

test('pre-tool-use: the planner is denied a code edit and the deny is logged', async () => {
  const { deps, written } = fakeDeps()
  const result = await hooks.runHook('pre-tool-use', pre('Edit', { file_path: '/work/repo/src/a.ts' }), PLANNER, deps)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /Drove planner: Edit on \/work\/repo\/src\/a.ts changes code/)
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(written.length, 1)
  assert.equal(written[0]?.path, '/h/events.jsonl')
  assert.equal(written[0]?.value.type, 'guard.deny')
  assert.equal(written[0]?.value.seat, 'planner')
})

test('pre-tool-use: the planner may write to the run scratch dir and read-only shell', async () => {
  const { deps, written } = fakeDeps()
  assert.equal((await hooks.runHook('pre-tool-use', pre('Write', { file_path: '/h/runs/r1/scratch/note.md' }), PLANNER, deps)).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'git status' }), PLANNER, deps)).code, 0)
  assert.equal(written.length, 0)
})

test('pre-tool-use: the planner prompts an open seat but not an unknown agent', async () => {
  const { deps } = fakeDeps()
  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'herdr agent prompt w-api "go"' }), PLANNER, deps)).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'herdr agent prompt stranger "go"' }), PLANNER, deps)).code, 2)
  assert.equal((await hooks.runHook('pre-tool-use', pre('shell', { command: ['bash', '-lc', 'codex queue --thread sess-1 --message hi'] }), PLANNER, deps)).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', pre('shell', { command: ['bash', '-lc', 'codex queue --thread nope --message hi'] }), PLANNER, deps)).code, 2)
})

test('pre-tool-use: the roster is read only when a command mentions herdr or codex', async () => {
  let reads = 0
  const { deps } = fakeDeps({ openIds: async () => { reads += 1; return [] } })
  await hooks.runHook('pre-tool-use', pre('Bash', { command: 'git status' }), PLANNER, deps)
  assert.equal(reads, 0)
  await hooks.runHook('pre-tool-use', pre('Bash', { command: 'herdr agent list' }), PLANNER, deps)
  assert.equal(reads, 1)
})

test('pre-tool-use: a worker is denied a push, denied by apply_patch only for the planner', async () => {
  const { deps } = fakeDeps()
  const push = await hooks.runHook('pre-tool-use', pre('Bash', { command: 'git push origin x' }), WORKER, deps)
  assert.equal(push.code, 2)
  assert.match(push.stderr, /never push/)
  assert.equal((await hooks.runHook('pre-tool-use', pre('Edit', { file_path: '/work/repo/a.ts' }), WORKER, deps)).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', pre('apply_patch', { command: '*** Begin Patch\n*** Update File: a.ts\n*** End Patch' }), PLANNER, deps)).code, 2)
})

test('pre-tool-use: push to production is denied for both roles', async () => {
  const { deps } = fakeDeps()
  for (const env of [PLANNER, WORKER]) {
    assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'git push origin HEAD:production' }), env, deps)).code, 2)
  }
})

test('pre-tool-use: a Codex call is denied with exit 2 and stderr only', async () => {
  const { deps } = fakeDeps()
  const result = await hooks.runHook('pre-tool-use', pre('exec_command', { cmd: 'rm -rf dist' }, { turn_id: 't1' }), PLANNER, deps)
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /rm changes files/)
})

test('pre-tool-use: internal errors fail closed for the planner and open for a worker', async () => {
  const { deps } = fakeDeps({ openIds: async () => { throw new Error('roster unreadable') } })
  const command = pre('Bash', { command: 'herdr agent prompt w-api go' })
  const planner = await hooks.runHook('pre-tool-use', command, PLANNER, deps)
  assert.equal(planner.code, 2)
  assert.match(planner.stderr, /could not check this call \(roster unreadable\)/)
  assert.equal(JSON.parse(planner.stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal((await hooks.runHook('pre-tool-use', 'not json', PLANNER, deps)).code, 2)
  assert.deepEqual(await hooks.runHook('pre-tool-use', 'not json', WORKER, deps), { stdout: '', stderr: '', code: 0 })
  const brokenWorker = fakeDeps({ scratchRoot: () => { throw new Error('boom') } }).deps
  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'ls' }), WORKER, brokenWorker)).code, 0)
})

test('pre-tool-use: a deny survives an unwritable event log', async () => {
  const { deps } = fakeDeps({ append: async () => { throw new Error('disk full') } })
  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'rm x' }), PLANNER, deps)).code, 2)
})

test('without a Drove identity the guard stands aside', async () => {
  const { deps, written } = fakeDeps()
  assert.deepEqual(await hooks.runHook('pre-tool-use', pre('Bash', { command: 'rm -rf /' }), {}, deps), { stdout: '', stderr: '', code: 0 })
  assert.equal(written.length, 0)
})

test('state events are recorded and never block', async () => {
  const { deps, written } = fakeDeps()
  for (const event of ['session-start', 'user-prompt-submit', 'stop', 'notification', 'permission-request'] as const) {
    const result = await hooks.runHook(event, JSON.stringify({ session_id: 's1', notification_type: 'idle_prompt' }), WORKER, deps)
    assert.equal(result.code, 0)
  }
  assert.deepEqual(written.map(entry => entry.value.event), ['session-start', 'user-prompt-submit', 'stop', 'notification', 'permission-request'])
  assert.equal(written[0]?.path, '/h/worker/w-api/hooks.jsonl')
  assert.equal(written[3]?.value.detail, 'idle_prompt')
  assert.equal(written[0]?.value.sessionId, 's1')
  const broken = fakeDeps({ append: async () => { throw new Error('disk full') } }).deps
  assert.equal((await hooks.runHook('stop', '{}', PLANNER, broken)).code, 0)
  assert.equal((await hooks.runHook('stop', 'garbage', PLANNER, deps)).code, 0)
})

test('with the real P1 modules: records land in hooks.jsonl and the roster feeds the seat check', async () => {
  const home = mkdtempSync(join(tmpdir(), 'drove-hooks-'))
  const run = 'drove-20261009-1000-abcd'
  const seat = { name: 'w-api', kind: 'codex', model: 'm', effort: 'high', worktree: '/wt', branch: 'drove/w-api', state: 'working', stateAt: NOW.toISOString(), spawnedAt: NOW.toISOString(), owes: 'none', attention: [], sessionId: 'thread-abc' } satisfies Seat
  await updateRoster(home, run, roster => upsertSeat(roster, seat))
  const planner = { DROVE_HOME: home, DROVE_RUN: run, DROVE_ROLE: 'planner', DROVE_SEAT: 'planner' }
  const worker = { DROVE_HOME: home, DROVE_RUN: run, DROVE_ROLE: 'worker', DROVE_SEAT: 'w-api' }

  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'herdr agent prompt w-api hi' }), planner)).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'codex queue --thread thread-abc --message hi' }), planner)).code, 0)
  assert.equal((await hooks.runHook('pre-tool-use', pre('Bash', { command: 'herdr agent prompt ghost hi' }), planner)).code, 2)
  assert.equal((await hooks.runHook('pre-tool-use', pre('Write', { file_path: join(runDir(home, run), 'scratch', 'n.md') }), planner)).code, 0)

  await hooks.runHook('session-start', JSON.stringify({ session_id: 'thread-abc', source: 'startup' }), worker)
  await hooks.runHook('session-start', JSON.stringify({ session_id: 'planner-sess' }), planner)
  const records = readFileSync(join(seatDir(home, run, 'w-api'), 'hooks.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.length, 1)
  assert.equal(records[0].event, 'session-start')
  assert.equal(records[0].sessionId, 'thread-abc')
  assert.match(readFileSync(join(runDir(home, run), 'planner', 'hooks.jsonl'), 'utf8'), /planner-sess/)
  assert.match(readFileSync(join(runDir(home, run), 'events.jsonl'), 'utf8'), /guard\.deny/)
})
