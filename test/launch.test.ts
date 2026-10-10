import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import * as launch from '../src/launch.ts'
import type { Identity, LaunchRequest } from '../src/types.ts'
import { assertGolden, tmp } from './p3-helpers.ts'

const HOME = '/home/cal/.drove'
const RUN = 'drove-20261009-1042-a3f1'
const TOKEN = 'tok-0123456789abcdef'
const ENTRY = '/opt/drove/src/cli.ts'
const ROLE = 'You are a worker.\nQuote: "yes" and \\ backslash with `ticks`'

const worker: Identity = { home: HOME, run: RUN, role: 'worker', seat: 'w-api', token: TOKEN }
const planner: Identity = { home: HOME, run: RUN, role: 'planner', seat: 'planner' }

const request = (overrides: Partial<launch.CodexLaunchRequest>): launch.CodexLaunchRequest => ({
  identity: worker,
  kind: 'claude',
  repo: '/work/repo',
  cwd: '/work/repo/.claude/worktrees/w-api',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  roleText: ROLE,
  initialPrompt: 'Build the thing. (You are worker `w-api`.)',
  droveEntry: ENTRY,
  ...overrides,
})

test('claude worker spec matches the golden file', () => {
  const spec = launch.claudeWorkerSpec(request({ cwd: '/work/repo', sessionId: '11111111-2222-3333-4444-555555555555' }))
  assertGolden('claude-worker', spec)
  assert.equal(spec.cwd, '/work/repo')
  assert.deepEqual(spec.argv.slice(spec.argv.indexOf('--worktree'), spec.argv.indexOf('--worktree') + 2), ['--worktree', 'w-api'])
  assert.equal(spec.env._CC_ACCT_PINNED, '1')
  assert.equal(spec.env.DROVE_AGENT, 'claude')
  assert.ok(spec.argv.includes('--dangerously-skip-permissions'))
})

test('claude worker resume replaces --session-id with --resume', () => {
  const spec = launch.claudeWorkerSpec(request({ resumeId: 'abc', sessionId: 'ignored', initialPrompt: undefined }))
  assertGolden('claude-worker-resume', spec)
  assert.ok(!spec.argv.includes('--session-id'))
  assert.ok(!spec.argv.includes('--worktree'))
  assert.equal(spec.cwd, '/work/repo/.claude/worktrees/w-api')
})

test('claude planner and codex worker never get --worktree', () => {
  assert.ok(!launch.claudePlannerSpec(request({ identity: planner })).argv.includes('--worktree'))
  assert.ok(!launch.codexWorkerSpec(request({ kind: 'codex' })).argv.includes('--worktree'))
})

test('a prompt that starts with a dash is passed after --', () => {
  const spec = launch.claudeWorkerSpec(request({ initialPrompt: '- do this' }))
  assert.deepEqual(spec.argv.slice(-2), ['--', '- do this'])
})

test('codex worker spec matches the golden file', () => {
  const spec = launch.codexWorkerSpec(request({ kind: 'codex', model: 'gpt-x', effort: 'high' }))
  assertGolden('codex-worker', spec)
  assert.equal(spec.env._CC_ACCT_PINNED, undefined)
  assert.equal(spec.env.DROVE_AGENT, 'codex')
  assert.ok(spec.argv.includes('--dangerously-bypass-approvals-and-sandbox'))
  for (const gone of ['-s', '--add-dir', 'sandbox_workspace_write.network_access=true']) assert.ok(!spec.argv.includes(gone), gone)
  assert.deepEqual(spec.files.map(file => file.path), [shimOf(spec)])
})

const shimOf = (spec: { files: readonly { path: string }[] }): string => spec.files[0]?.path ?? ''

test('codex worker keeps the old sandbox when bypassSandbox is false', () => {
  const spec = launch.codexWorkerSpec(request({ kind: 'codex', bypassSandbox: false }))
  assert.ok(!spec.argv.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.deepEqual(spec.argv.slice(0, 2), ['-s', 'workspace-write'])
  assert.ok(spec.argv.includes('--add-dir'))
  assert.ok(spec.argv.includes('sandbox_workspace_write.network_access=true'))
})

test('the codex planner never bypasses approvals or the sandbox', () => {
  const spec = launch.codexPlannerSpec(request({ identity: planner, kind: 'codex', bypassSandbox: true }))
  assert.ok(!spec.argv.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.deepEqual(spec.argv.slice(0, 2), ['-s', 'workspace-write'])
})

test('the guard PreToolUse hook is present in both codex worker sandbox modes', () => {
  for (const bypassSandbox of [true, false]) {
    const spec = launch.codexWorkerSpec(request({ kind: 'codex', bypassSandbox }))
    const hook = spec.argv.find(arg => arg.startsWith('hooks.PreToolUse='))
    assert.ok(hook?.includes(`${shimOf(spec)} pre-tool-use`), `bypassSandbox=${bypassSandbox}`)
    assert.ok(hook?.includes(launch.CODEX_GUARDED_TOOLS))
  }
})

test('the codex mcp server takes the identity from env_vars names, so no value is typed into the shell', () => {
  const spec = launch.codexWorkerSpec(request({ kind: 'codex' }))
  const server = spec.argv.find(arg => arg.startsWith('mcp_servers.drove='))
  assert.ok(server?.includes('env_vars=["DROVE_HOME","DROVE_RUN","DROVE_ROLE","DROVE_SEAT","DROVE_TOKEN"]'), server)
  assert.ok(!server?.includes('env={'))
  assert.ok(!spec.argv.some(arg => arg.includes(TOKEN)))
})

test('codex worker with the default model omits -m, and resume leads with the subcommand', () => {
  const spec = launch.codexWorkerSpec(request({ kind: 'codex', model: '', effort: 'low', resumeId: 'thread-1', roleText: '', bypassHookTrust: true, initialPrompt: 'go' }))
  assertGolden('codex-worker-resume', spec)
  assert.deepEqual(spec.argv.slice(0, 2), ['resume', 'thread-1'])
  assert.ok(!spec.argv.includes('-m'))
  assert.ok(!spec.argv.some(arg => arg.startsWith('developer_instructions')))
  assert.ok(spec.argv.includes('--dangerously-bypass-hook-trust'))
})

test('claude planner spec matches the golden file and has no permission bypass', () => {
  const spec = launch.claudePlannerSpec(request({ identity: planner, model: 'claude-opus-5-5', effort: 'high', sessionId: 'planner-uuid', channel: true, initialPrompt: 'Ship it.' }))
  assertGolden('claude-planner', spec)
  assert.ok(!spec.argv.includes('--dangerously-skip-permissions'))
  assert.equal(spec.env._CC_ACCT_PINNED, undefined)
  assert.equal(spec.env.DROVE_CHANNEL, '1')
  assert.equal(spec.env.DROVE_TOKEN, undefined)
  assert.ok(spec.argv.includes('server:drove'))
})

test('claude planner without the channel does not set DROVE_CHANNEL', () => {
  const spec = launch.claudePlannerSpec(request({ identity: planner, initialPrompt: undefined }))
  assert.equal(spec.env.DROVE_CHANNEL, undefined)
  assert.ok(!spec.argv.includes('--dangerously-load-development-channels'))
})

test('codex planner spec matches the golden file', () => {
  const spec = launch.codexPlannerSpec(request({ identity: planner, kind: 'codex', model: 'gpt-x', effort: 'high', initialPrompt: 'Read the roster and wait for the human.' }))
  assertGolden('codex-planner', spec)
  assert.equal(spec.env.DROVE_ROLE, 'planner')
  assert.ok(spec.argv.includes(`${HOME}/runs/${RUN}`))
})

test('specFor dispatches on kind and role, and rejects a mismatched identity', () => {
  assert.equal(launch.specFor(request({})).kind, 'claude')
  assert.equal(launch.specFor(request({ kind: 'codex' })).role, 'worker')
  assert.equal(launch.specFor(request({ identity: planner, kind: 'codex' })).role, 'planner')
  assert.throws(() => launch.claudePlannerSpec(request({})), /identity role worker/)
})

test('claude settings and mcp config carry the guard hooks and the drove server', () => {
  const settings = launch.claudeSettings(ENTRY, 'worker') as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> }
  assert.equal(settings.hooks.PreToolUse?.[0]?.matcher, launch.CLAUDE_GUARDED_TOOLS)
  assert.equal(settings.hooks.PreToolUse?.[0]?.hooks[0]?.command, `node ${ENTRY} guard pre-tool-use`)
  assert.deepEqual(Object.keys(settings.hooks), ['PreToolUse', 'SessionStart', 'Stop', 'Notification'])
  assert.deepEqual(launch.claudeMcpConfig(ENTRY), { mcpServers: { drove: { command: 'node', args: [ENTRY, 'mcp'] } } })
})

test('the claude mcp.json carries the drove identity env and is written with mode 600', async () => {
  const dir = await tmp('mcp-env')
  const spec = launch.claudeWorkerSpec(request({ identity: { ...worker, home: dir } }))
  const mcp = spec.files.find(file => file.path.endsWith('/mcp.json'))
  assert.ok(mcp)
  const servers = (JSON.parse(mcp.content) as { mcpServers: { drove: { env: Record<string, string> } } }).mcpServers
  assert.deepEqual(servers.drove.env, { DROVE_HOME: dir, DROVE_RUN: RUN, DROVE_ROLE: 'worker', DROVE_SEAT: 'w-api', DROVE_TOKEN: TOKEN })
  assert.equal(mcp.mode, 0o600)
  await launch.writeLaunchFiles(spec)
  assert.equal(statSync(mcp.path).mode & 0o777, 0o600)
  assert.ok(!JSON.stringify(launch.redactSpec(spec)).includes(TOKEN))
})

test('the claude planner mcp.json has the identity env without a token', () => {
  const spec = launch.claudePlannerSpec(request({ identity: planner }))
  const mcp = JSON.parse(spec.files[0]?.content ?? '{}') as { mcpServers: { drove: { env: Record<string, string> } } }
  assert.deepEqual(Object.keys(mcp.mcpServers.drove.env), ['DROVE_HOME', 'DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT'])
})

test('codex specs install the UserPromptSubmit hook for workers and planners', () => {
  for (const identity of [worker, planner]) {
    const spec = launch.specFor(request({ identity, kind: 'codex' }))
    assert.ok(spec.argv.some(arg => arg.startsWith('hooks.UserPromptSubmit=') && arg.includes(`${shimOf(spec)} user-prompt-submit`)))
  }
})

test('the codex hook shim is named by the drove entry and execs it with the event as an argument', () => {
  const first = launch.codexWorkerSpec(request({ kind: 'codex' }))
  const other = launch.codexWorkerSpec(request({ kind: 'codex', droveEntry: '/elsewhere/cli.ts' }))
  assert.equal(first.files[0]?.content, '#!/bin/sh\nexec node /opt/drove/src/cli.ts guard "$@"\n')
  assert.equal(first.files[0]?.mode, 0o700)
  assert.notEqual(shimOf(first), shimOf(other))
  assert.equal(shimOf(first), shimOf(launch.codexWorkerSpec(request({ kind: 'codex', cwd: '/x' }))))
})

// The readiness gate in commands.ts (DROVE-23) is what makes a line over 1024 bytes safe to type; this budget only
// stops the line from growing unnoticed. Measured with these fixtures: 1054 bytes; the budget leaves a small margin.
test('the typed Codex launch line stays within its pinned budget', () => {
  const BUDGET = 1100
  const spec = launch.codexWorkerSpec(request({ kind: 'codex', roleText: '', initialPrompt: undefined }))
  assert.ok(typedBytes(spec) <= BUDGET, `${typedBytes(spec)} bytes`)
})

test('hook commands quote an entry path that has spaces', () => {
  const settings = launch.claudeSettings('/my dir/cli.ts', 'planner') as { hooks: { Stop: { hooks: { command: string }[] }[] } }
  assert.equal(settings.hooks.Stop[0]?.hooks[0]?.command, "node '/my dir/cli.ts' guard stop")
})

test('tomlString escapes quotes, backslashes, newlines and control characters', () => {
  assert.equal(launch.tomlString('plain'), '"plain"')
  assert.equal(launch.tomlString('a"b\\c'), '"a\\"b\\\\c"')
  assert.equal(launch.tomlString('l1\nl2\t\r'), '"l1\\nl2\\t\\r"')
  assert.equal(launch.tomlString('\u0001\u007f'), '"\\u0001\\u007f"')
  assert.equal(launch.tomlString('é → ⟦'), '"é → ⟦"')
})

test('codex -c values for paths with quotes stay valid TOML strings', () => {
  const spec = launch.codexWorkerSpec(request({ kind: 'codex', cwd: '/work/we"ird path' }))
  assert.ok(spec.argv.includes('projects."/work/we\\"ird path".trust_level="trusted"'))
})

test('redactSpec removes the token from env, argv and files but keeps the structure', () => {
  const codex = launch.redactSpec(launch.codexWorkerSpec(request({ kind: 'codex' })))
  assert.ok(!JSON.stringify(codex).includes(TOKEN))
  assert.equal(codex.env.DROVE_TOKEN, '<redacted>')
  assert.ok(!codex.argv.some(arg => arg.includes('DROVE_TOKEN=')))
  const plannerSpec = launch.claudePlannerSpec(request({ identity: planner }))
  assert.equal(launch.redactSpec(plannerSpec), plannerSpec)
})

test('writeLaunchFiles writes the files with their modes', async () => {
  const dir = await tmp('files')
  const spec = launch.claudeWorkerSpec(request({ identity: { ...worker, home: dir } }))
  await launch.writeLaunchFiles(spec)
  for (const file of spec.files) {
    assert.equal(await readFile(file.path, 'utf8'), file.content)
    assert.equal(statSync(file.path).mode & 0o777, 0o600)
  }
  assert.ok(spec.files[0]?.path.startsWith(join(dir, 'runs', RUN, 'seats', 'w-api')))
})

test('isShellSafeArg rejects newlines, C0 control characters and DEL, and accepts quotes, backticks and unicode', () => {
  for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u001bb', 'a\u007fb']) assert.equal(launch.isShellSafeArg(bad), false, JSON.stringify(bad))
  for (const good of ['', 'plain', `it's "quoted" {a=b} \`tick\` $(x) \\`, 'é → ⟦drove⟧']) assert.equal(launch.isShellSafeArg(good), true, good)
  assert.throws(() => launch.assertShellSafeArgs(['ok', 'two\nlines']), /launch argument 1/)
})

test('every spec builder passes the shell-safety check, with and without a prompt, for fresh and resumed launches', () => {
  const variants: Partial<LaunchRequest>[] = [{}, { initialPrompt: undefined }, { resumeId: 'abc' }, { roleText: '' }, { initialPrompt: '- dash first' }]
  for (const identity of [worker, planner]) {
    for (const kind of ['claude', 'codex'] as const) {
      for (const variant of variants) {
        const spec = launch.specFor(request({ identity, kind, channel: true, ...variant }))
        assert.doesNotThrow(() => launch.assertShellSafeArgs(spec.argv), `${kind} ${identity.role} ${JSON.stringify(variant)}`)
      }
    }
  }
})

test('a worker spec refuses a multi-line prompt, a planner spec lets its exec-ed prompt carry newlines', () => {
  for (const kind of ['claude', 'codex'] as const) {
    assert.throws(() => launch.specFor(request({ kind, initialPrompt: 'line one\nline two' })), /newline or control character/)
    assert.doesNotThrow(() => launch.specFor(request({ kind, identity: planner, initialPrompt: 'line one\nline two' })))
  }
})

test('the claude role text travels in a role.md file, never in argv', () => {
  for (const identity of [worker, planner]) {
    const spec = launch.specFor(request({ identity }))
    const flag = spec.argv.indexOf('--append-system-prompt-file')
    const file = spec.files.find(entry => entry.path.endsWith('/role.md'))
    assert.ok(flag >= 0 && file)
    assert.equal(spec.argv[flag + 1], file.path)
    assert.equal(file.content, `${ROLE}\n`)
    assert.equal(file.mode, 0o600)
    assert.ok(!spec.argv.includes('--append-system-prompt'))
    assert.ok(!spec.argv.some(arg => arg.includes('You are a worker')))
  }
  const bare = launch.claudeWorkerSpec(request({ roleText: '' }))
  assert.ok(!bare.argv.includes('--append-system-prompt-file'))
  assert.ok(!bare.files.some(entry => entry.path.endsWith('/role.md')))
})

test('the codex developer_instructions override escapes newlines as two characters', () => {
  const spec = launch.codexWorkerSpec(request({ kind: 'codex' }))
  const override = spec.argv.find(arg => arg.startsWith('developer_instructions='))
  assert.equal(override, 'developer_instructions="You are a worker.\\nQuote: \\"yes\\" and \\\\ backslash with `ticks`"')
  assert.ok(!/[\u0000-\u001f]/.test(override ?? ''))
})

const typedBytes = (spec: { kind: string; argv: readonly string[] }): number => Buffer.byteLength([spec.kind, ...spec.argv].join(' '))

test('the typed Claude launch line stays well under the 1024-byte tty limit with a long role and long paths', () => {
  const longRole = 'You are a worker. '.repeat(400)
  const longPaths = { repo: `/Users/someone/${'projects/'.repeat(8)}repo`, cwd: `/Users/someone/${'projects/'.repeat(8)}repo/.claude/worktrees/w-api` }
  const spec = launch.claudeWorkerSpec(request({ ...longPaths, roleText: longRole, initialPrompt: undefined }))
  assert.ok(typedBytes(spec) < 700, `${typedBytes(spec)} bytes`)
})

test('execArgv puts the agent binary first', () => {
  assert.deepEqual(launch.execArgv({ kind: 'codex', role: 'planner', cwd: '/x', env: {}, argv: ['-s', 'x'], files: [] }), ['codex', '-s', 'x'])
})
