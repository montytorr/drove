import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import * as launch from '../src/launch.ts'
import type { Identity, LaunchRequest } from '../src/types.ts'
import { assertGolden, tmp } from './p3-helpers.ts'

const HOME = '/home/user/.drove'
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
  const spec = launch.claudeWorkerSpec(request({ cwd: '/work/repo', sessionId: '11111111-2222-3333-4444-555555555555', workerEnv: { WORKER_FLAG: '1' } }))
  assertGolden('claude-worker', spec)
  assert.equal(spec.cwd, '/work/repo')
  assert.deepEqual(spec.argv.slice(spec.argv.indexOf('--worktree'), spec.argv.indexOf('--worktree') + 2), ['--worktree', 'w-api'])
  assert.equal(spec.env.WORKER_FLAG, '1')
  assert.equal(spec.env.DROVE_AGENT, 'claude')
  assert.ok(spec.argv.includes('--dangerously-skip-permissions'))
})

test('Claude launches forward the process CLAUDE_CONFIG_DIR only when non-empty', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    for (const value of [undefined, '/custom/claude', '']) {
      if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = value
      for (const identity of [worker, planner]) {
        const spec = launch.specFor(request({ identity }))
        assert.equal(spec.env.CLAUDE_CONFIG_DIR, value || undefined)
        assert.equal(Object.hasOwn(spec.env, 'CLAUDE_CONFIG_DIR'), Boolean(value))
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  }
})

test('a lean claude worker matches the golden file', () => {
  const spec = launch.claudeWorkerSpec(request({ cwd: '/work/repo', sessionId: '11111111-2222-3333-4444-555555555555', mcpAllow: ['mongodb'], userMcp: { mongodb: { command: 'mongo-mcp', args: ['--read-only'] }, notion: { command: 'notion-mcp' } } }))
  assertGolden('claude-worker-lean', spec)
})

test('claude worker resume replaces --session-id with --resume', () => {
  const spec = launch.claudeWorkerSpec(request({ resumeId: 'abc', sessionId: 'ignored', initialPrompt: undefined, workerEnv: { WORKER_FLAG: '1' } }))
  assertGolden('claude-worker-resume', spec)
  assert.ok(!spec.argv.includes('--session-id'))
  assert.ok(!spec.argv.includes('--worktree'))
  assert.equal(spec.cwd, '/work/repo/.claude/worktrees/w-api')
})

test('a claude worker started in an existing worktree gets --session-id and no --worktree', () => {
  const spec = launch.claudeWorkerSpec(request({ inWorktree: true, sessionId: 'fresh-id', initialPrompt: undefined }))
  assert.ok(!spec.argv.includes('--worktree'))
  assert.ok(!spec.argv.includes('--resume'))
  assert.equal(spec.argv[spec.argv.indexOf('--session-id') + 1], 'fresh-id')
  assert.equal(spec.cwd, '/work/repo/.claude/worktrees/w-api')
})

test('claude settings wire StopFailure to drove guard stop-failure, for workers and planners', () => {
  for (const role of ['worker', 'planner'] as const) {
    const hooks = (launch.claudeSettings(ENTRY, role) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks
    assert.equal(hooks.StopFailure?.[0]?.hooks[0]?.command, `node ${ENTRY} guard stop-failure`)
  }
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
  assert.equal(spec.env.WORKER_FLAG, undefined)
  assert.equal(spec.env.DROVE_AGENT, 'codex')
  assert.ok(spec.argv.includes('--dangerously-bypass-approvals-and-sandbox'))
  for (const gone of ['-s', '--add-dir', 'sandbox_workspace_write.network_access=true']) assert.ok(!spec.argv.includes(gone), gone)
  assert.deepEqual(spec.files.map(file => file.path), [shimOf(spec)])
})

const shimOf = (spec: { files: readonly { path: string }[] }): string => spec.files[0]?.path ?? ''

test('workerEnv reaches Claude and Codex workers, never planners, and never overrides Drove\'s own variables', () => {
  const workerEnv = { WORKER_FLAG: '1', CAIRN_AGENT: 'openclaw', DROVE_TOKEN: 'forged', DROVE_AGENT: 'other', DROVE_HOME: '/forged', DROVE_RUN: 'forged', DROVE_ROLE: 'planner', DROVE_SEAT: 'forged' }
  for (const kind of ['claude', 'codex'] as const) {
    const spec = launch.specFor(request({ kind, workerEnv }))
    assert.equal(spec.env.WORKER_FLAG, '1', kind)
    assert.equal(spec.env.CAIRN_AGENT, 'openclaw', kind)
    assert.equal(spec.env.DROVE_TOKEN, TOKEN, kind)
    assert.equal(spec.env.DROVE_AGENT, kind, kind)
    assert.equal(spec.env.DROVE_HOME, HOME, kind)
    assert.equal(spec.env.DROVE_RUN, RUN, kind)
    assert.equal(spec.env.DROVE_ROLE, 'worker', kind)
    assert.equal(spec.env.DROVE_SEAT, worker.seat, kind)
    const plannerSpec = launch.specFor(request({ kind, identity: planner, workerEnv }))
    assert.equal(plannerSpec.env.WORKER_FLAG, undefined, kind)
    assert.equal(plannerSpec.env.CAIRN_AGENT, kind === 'claude' ? 'claude-code' : 'codex', kind)
  }
})

test('Claude and Codex seats use their own Cairn runtime regardless of the parent env or run path', () => {
  const previous = process.env.CAIRN_AGENT
  const run = 'openclaw-dashboard-20261016-1854-0abb'
  try {
    for (const parentAgent of [undefined, 'claude-code', 'codex', 'openclaw']) {
      if (parentAgent === undefined) delete process.env.CAIRN_AGENT
      else process.env.CAIRN_AGENT = parentAgent
      for (const identity of [worker, planner]) {
        const claude = launch.specFor(request({ identity: { ...identity, run } }))
        assert.equal(claude.env.CAIRN_AGENT, 'claude-code', `${identity.role}, parent=${parentAgent}`)
        const codex = launch.specFor(request({ kind: 'codex', identity: { ...identity, run }, codexHome: codexHome({ dir: join(HOME, 'runs', run, 'codex-home') }) }))
        assert.ok(codex.env.CODEX_HOME?.includes('openclaw'))
        assert.equal(codex.env.CAIRN_AGENT, 'codex', `${identity.role}, parent=${parentAgent}`)
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CAIRN_AGENT
    else process.env.CAIRN_AGENT = previous
  }
})

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
  const spec = launch.claudePlannerSpec(request({ identity: planner, model: 'claude-opus-5-5', effort: 'high', sessionId: 'planner-uuid', channel: true, initialPrompt: 'Ship it.', workerEnv: { WORKER_FLAG: '1' } }))
  assertGolden('claude-planner', spec)
  assert.ok(!spec.argv.includes('--dangerously-skip-permissions'))
  assert.equal(spec.env.WORKER_FLAG, undefined)
  assert.equal(spec.env.DROVE_CHANNEL, '1')
  assert.equal(spec.env.DROVE_TOKEN, undefined)
  assert.ok(spec.argv.includes('server:drove'))
})

test('a variadic claude flag is never followed by the prompt or any extra non-flag token', () => {
  const variadic = ['--mcp-config', '--dangerously-load-development-channels']
  const specs = [true, false].flatMap(channel => [undefined, 'Ship it.', 'Build the thing.'].flatMap(initialPrompt => [
    launch.claudePlannerSpec(request({ identity: planner, channel, initialPrompt })),
    launch.claudeWorkerSpec(request({ channel, initialPrompt, roleText: undefined })),
    launch.claudeWorkerSpec(request({ channel, initialPrompt })),
  ]))
  for (const { argv } of specs) {
    argv.forEach((arg, i) => {
      if (!variadic.includes(arg)) return
      const value = argv[i + 1]
      assert.ok(value !== undefined && !value.startsWith('-'), `${arg} has a value`)
      const next = argv[i + 2]
      assert.ok(next === undefined ? false : next.startsWith('-'), `${arg} <value> is followed by ${next}, not a flag`)
    })
  }
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

test('Codex planners trust the repo with a per-process override, with or without a Drove home', () => {
  for (const codexHome of [undefined, { dir: '/drove/codex-home', user: '/home/user/.codex', userConfig: '', userHooks: {}, links: [], skills: [] }]) {
    const spec = launch.codexPlannerSpec(request({ identity: planner, kind: 'codex', repo: '/work/repo "quoted"', codexHome }))
    const index = spec.argv.indexOf(String.raw`projects."/work/repo \"quoted\"".trust_level="trusted"`)
    assert.ok(index > 0)
    assert.equal(spec.argv[index - 1], '-c')
    for (const file of spec.files) assert.ok(!file.path.startsWith('/home/user/.codex/'))
  }
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
  assert.deepEqual(Object.keys(settings.hooks), ['PreToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification'])
  assert.equal(settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command, `node ${ENTRY} guard user-prompt-submit`)
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
  assert.equal(codex.env.CAIRN_AGENT, 'codex')
  const claude = launch.redactSpec(launch.claudeWorkerSpec(request({})))
  assert.equal(claude.env.DROVE_TOKEN, '<redacted>')
  assert.equal(claude.env.CAIRN_AGENT, 'claude-code')
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

// ---------- Drove-owned CODEX_HOME (DROVE-34) ----------

const CODEX_DIR = '/home/user/.drove/runs/drove-20261009-1042-a3f1/codex-home'
const USER_CODEX = '/home/user/.codex'
const USER_CONFIG = [
  'model = "gpt-6.1-sol"',
  "personality = 'pragmatic'",
  'model_reasoning_effort = "high"',
  '',
  '[projects."/home/user/elsewhere"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.docs]',
  'command = "npx"',
  'args = [',
  '  "docs-mcp",',
  ']',
  '',
  '[mcp_servers.docs.env]',
  'TOKEN_FILE = "/home/user/.docs"',
  '',
  '[mcp_servers.drove]',
  'command = "stale"',
  '',
  '[tui]',
  'screen_reader_detection_done = true',
  '',
  '[hooks.state."/home/user/.codex/hooks.json:session_start:0:0"]',
  'trusted_hash = "sha256:user-approved"',
  '',
  '[hooks.state."/home/user/.codex/hooks.json:stop:0:0"]',
  'trusted_hash = "sha256:user-stop"',
  'enabled = false',
  '',
  '[hooks.state."/<session-flags>/config.toml:stop:0:0"]',
  'trusted_hash = "sha256:old-inline"',
].join('\n')
const USER_HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: "bash '/home/user/.codex/herdr-agent-state.sh' session", timeout: 10 }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'cairn-end', timeout: 120, async: true }] }],
}
const codexHome = (overrides: Partial<launch.CodexHome> = {}): launch.CodexHome => ({
  dir: CODEX_DIR, user: USER_CODEX, userConfig: USER_CONFIG, userHooks: USER_HOOKS, links: ['auth.json', 'AGENTS.md'], skills: ['cairn', 'croft'], ...overrides,
})
const homeRequest = (overrides: Partial<launch.CodexLaunchRequest> = {}) =>
  request({ kind: 'codex', model: 'gpt-x', effort: 'high', initialPrompt: undefined, codexHome: codexHome(), ...overrides })
const fileOf = (spec: { files: readonly { path: string; content: string }[] }, name: string): string => spec.files.find(file => file.path.endsWith(`/${name}`))?.content ?? ''

test('codexHookHash reproduces Codex\'s trusted_hash (checked against values codex-cli 0.162.0 wrote; the paths here are generic)', () => {
  const shim = '/Users/test/.drove/g-ff7841bf'
  const command = (event: string) => ({ type: 'command', command: `${shim} ${event}`, timeout: 10 })
  assert.equal(launch.codexHookHash('PreToolUse', { matcher: launch.CODEX_GUARDED_TOOLS }, command('pre-tool-use')), 'sha256:dfa64f7118e75fd73a50104576f96f9fc501b2c5e86f530fd3100aac181af9c0')
  assert.equal(launch.codexHookHash('PermissionRequest', {}, command('permission-request')), 'sha256:a6016bc0883262103342f9ac1a9371d9d95191b70677a302de3cba183fb4d49f')
  assert.equal(launch.codexHookHash('SessionStart', {}, command('session-start')), 'sha256:019e6bbeec07517012c1e2a13dfc8beb86aab8309dd426cf259e752c7d313af7')
  assert.equal(launch.codexHookHash('UserPromptSubmit', {}, command('user-prompt-submit')), 'sha256:2752a8ae3ab05fe52f032af2cfcea9a25fe4ba7030055bc280b1bc99649682ff')
  assert.equal(launch.codexHookHash('Stop', {}, command('stop')), 'sha256:83029344a1ca77b33a655740d445ebb9a0301153f19127dd3c4db4ce047f9adc')
  assert.equal(launch.codexHookHash('SessionStart', {}, { type: 'command', command: "bash '/Users/test/.codex/herdr-agent-state.sh' session", timeout: 10 }), 'sha256:3cda037cde67292f957909fdd42d2e84de391f2d5f80c362caacb8c5019d8a89')
  assert.equal(
    launch.codexHookHash('Stop', {}, { type: 'command', command: 'CAIRN_AGENT=codex CAIRN_PLATFORM=codex node /Users/test/.cairn/hooks/cairn-session-end.mjs --ongoing', timeout: 120, async: true }),
    'sha256:31e94fd79c322783727d88db4996280f3d3f08b819f4b1b2be6863a8a2a9392f',
  )
})

test('codex worker with a Drove-owned CODEX_HOME matches the golden file', () => {
  const spec = launch.codexWorkerSpec(homeRequest({ initialPrompt: 'Build the thing. (You are worker `w-api`.)' }))
  assertGolden('codex-worker-home', spec)
  assert.equal(spec.env.CODEX_HOME, CODEX_DIR)
  assert.deepEqual(spec.argv.slice(0, 7), ['--dangerously-bypass-approvals-and-sandbox', '-C', '/work/repo/.claude/worktrees/w-api', '-m', 'gpt-x', '-c', 'model_reasoning_effort="high"'])
  assert.ok(!spec.argv.some(arg => /^(hooks\.|mcp_servers|projects\.|check_for_update)/.test(arg)))
})

test('the Drove config.toml holds the repo trust, the drove MCP server, the user model and MCP servers, and hook trust', () => {
  const config = fileOf(launch.codexWorkerSpec(homeRequest()), 'config.toml')
  assert.ok(config.includes('model = "gpt-6.1-sol"\npersonality = \'pragmatic\'\ncheck_for_update_on_startup = false\n'), config)
  assert.ok(!config.includes('model_reasoning_effort'), 'effort stays per seat on the launch line')
  assert.ok(config.includes('[projects."/work/repo"]\ntrust_level = "trusted"\n'))
  assert.ok(config.includes('[projects."/work/repo/.claude/worktrees/w-api"]\ntrust_level = "trusted"\n'))
  assert.ok(!config.includes('/home/user/elsewhere'))
  assert.ok(config.includes('[mcp_servers.drove]\ncommand = "node"\nargs = ["/opt/drove/src/cli.ts", "mcp"]\nenv_vars = ["DROVE_HOME", "DROVE_RUN", "DROVE_ROLE", "DROVE_SEAT", "DROVE_TOKEN"]\ndefault_tools_approval_mode = "approve"\n'))
  assert.ok(config.includes('[mcp_servers.docs]\ncommand = "npx"\nargs = [\n  "docs-mcp",\n]\n\n[mcp_servers.docs.env]\nTOKEN_FILE = "/home/user/.docs"\n'))
  assert.ok(!config.includes('stale'), 'a user mcp_servers.drove never shadows Drove\'s')
  assert.ok(!config.includes('[tui]') && !config.includes('session-flags'))
  assert.ok(config.includes(`[hooks.state."${CODEX_DIR}/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:user-approved"\n`))
  assert.ok(config.includes(`[hooks.state."${CODEX_DIR}/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:user-stop"\nenabled = false\n`))
  const shim = `${HOME}/g-d43caf1d`
  const droveHash = launch.codexHookHash('SessionStart', {}, { type: 'command', command: `${shim} session-start`, timeout: 10 })
  assert.ok(config.includes(`[hooks.state."${CODEX_DIR}/hooks.json:session_start:1:0"]\ntrusted_hash = "${droveHash}"\n`))
  for (const position of ['pre_tool_use:0:0', 'user_prompt_submit:0:0', 'stop:1:0', 'permission_request:0:0']) assert.ok(config.includes(`hooks.json:${position}"]\ntrusted_hash = "sha256:`), position)
  assert.ok(!config.includes('\n\n\n'))
})

test('Codex home project trust keys are deduplicated when the launch cwd is the repo', () => {
  const config = fileOf(launch.codexWorkerSpec(homeRequest({ cwd: '/work/repo' })), 'config.toml')
  assert.equal(config.match(/\[projects\./g)?.length, 1)
})

test('the Drove hooks.json keeps the user groups first, at the indices their trust is keyed by, then Drove groups', () => {
  const hooks = (JSON.parse(fileOf(launch.codexWorkerSpec(homeRequest()), 'hooks.json')) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> }).hooks
  assert.deepEqual(hooks.SessionStart?.map(group => group.hooks[0]?.command), ["bash '/home/user/.codex/herdr-agent-state.sh' session", `${HOME}/g-d43caf1d session-start`])
  assert.deepEqual(hooks.Stop?.map(group => group.hooks[0]?.command), ['cairn-end', `${HOME}/g-d43caf1d stop`])
  assert.equal(hooks.PreToolUse?.[0]?.matcher, launch.CODEX_GUARDED_TOOLS)
  assert.deepEqual(Object.keys(hooks).sort(), ['PermissionRequest', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'])
})

test('with no user Codex setup the Drove home holds only Drove, and every Drove hook is trusted', () => {
  const spec = launch.codexWorkerSpec(homeRequest({ codexHome: codexHome({ userConfig: '', userHooks: {}, links: [], skills: [] }) }))
  const config = fileOf(spec, 'config.toml')
  assert.ok(config.startsWith('# Written by Drove'))
  assert.equal(config.match(/trusted_hash/g)?.length, 5)
  assert.deepEqual(spec.links, [])
})

test('the Drove home links the user login, instructions and each skill, never .system', () => {
  const spec = launch.codexWorkerSpec(homeRequest())
  assert.deepEqual(spec.links, [
    { path: `${CODEX_DIR}/auth.json`, target: `${USER_CODEX}/auth.json` },
    { path: `${CODEX_DIR}/AGENTS.md`, target: `${USER_CODEX}/AGENTS.md` },
    { path: `${CODEX_DIR}/skills/cairn`, target: `${USER_CODEX}/skills/cairn` },
    { path: `${CODEX_DIR}/skills/croft`, target: `${USER_CODEX}/skills/croft` },
  ])
})

test('the typed Codex line with a Drove-owned CODEX_HOME stays under 700 bytes for worker, resume and promote, with long paths', () => {
  const user = '/Users/someone-with-a-long-account-name'
  const repo = `${user}/${'projects/'.repeat(4)}a-rather-long-repository-name`
  const long = {
    identity: { ...worker, home: `${user}/.drove`, run: 'a-rather-long-repository-name-20261010-1934-87d7', seat: 'w-a-seat-name-of-32-characters-x' },
    repo, cwd: `${repo}/.claude/worktrees/w-a-seat-name-of-32-characters-x`, droveEntry: `${user}/${'projects/'.repeat(4)}drove/src/cli.ts`,
    codexHome: codexHome({ dir: `${user}/.drove/runs/a-rather-long-repository-name-20261010-1934-87d7/codex-home` }),
  }
  const fresh = launch.codexWorkerSpec(homeRequest({ ...long, model: 'gpt-6.1-sol', effort: 'medium' }))
  const resume = launch.codexWorkerSpec(homeRequest({ ...long, model: 'gpt-6.1-sol', effort: 'medium', resumeId: '019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b' }))
  const promote = launch.codexWorkerSpec(homeRequest({ ...long, model: 'gpt-6.1-sol-pro-max', effort: 'xhigh', resumeId: '019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b', bypassHookTrust: true }))
  const sandboxed = launch.codexWorkerSpec(homeRequest({ ...long, model: 'gpt-6.1-sol', effort: 'xhigh', resumeId: '019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b', bypassSandbox: false }))
  for (const [name, spec] of Object.entries({ fresh, resume, promote, sandboxed })) assert.ok(typedBytes(spec) < 700, `${name}: ${typedBytes(spec)} bytes`)
  assert.ok(typedBytes(launch.codexWorkerSpec(homeRequest({ ...long, codexHome: undefined }))) > 1024, 'the inline line this replaces was over the tty limit')
})

test('readCodexHome reads the user home without writing to it, and writeLaunchFiles links without replacing a real file', async () => {
  const { mkdir, writeFile: write, readlink, lstat, readdir, symlink, unlink } = await import('node:fs/promises')
  const root = await tmp('codex-home')
  const user = join(root, 'user-codex')
  await mkdir(join(user, 'skills', '.system'), { recursive: true })
  await mkdir(join(user, 'skills', 'cairn'))
  await write(join(user, 'auth.json'), '{"user":true}')
  await write(join(user, 'config.toml'), 'model = "gpt-y"\n')
  await write(join(user, 'hooks.json'), JSON.stringify({ hooks: USER_HOOKS }))
  const before = (await readdir(user)).sort()
  const home = await launch.readCodexHome(join(root, 'drove', 'codex-home'), user)
  assert.deepEqual([home.links, home.skills, home.userConfig, Object.keys(home.userHooks)], [['auth.json'], ['cairn'], 'model = "gpt-y"\n', ['SessionStart', 'Stop']])
  assert.equal(home.dir, await realpath(join(root, 'drove', 'codex-home')))

  const spec = launch.codexWorkerSpec(homeRequest({ identity: { ...worker, home: join(root, 'drove') }, codexHome: home }))
  await write(join(home.dir, 'AGENTS.md'), 'a real file the user made here')
  await launch.writeLaunchFiles({ ...spec, links: [...(spec.links ?? []), { path: join(home.dir, 'AGENTS.md'), target: join(user, 'AGENTS.md') }] })
  assert.equal(await readlink(join(home.dir, 'auth.json')), join(home.user, 'auth.json'))
  assert.equal(await readFile(join(home.dir, 'auth.json'), 'utf8'), '{"user":true}')
  assert.equal(await readlink(join(home.dir, 'skills', 'cairn')), join(home.user, 'skills', 'cairn'))
  assert.ok(!(await lstat(join(home.dir, 'skills'))).isSymbolicLink(), 'skills is Drove\'s own folder, so Codex writes .system there')
  assert.equal(await readFile(join(home.dir, 'AGENTS.md'), 'utf8'), 'a real file the user made here')
  assert.match(await readFile(join(home.dir, 'config.toml'), 'utf8'), /model = "gpt-y"/)
  assert.equal(statSync(join(home.dir, 'config.toml')).mode & 0o777, 0o600)

  await unlink(join(home.dir, 'auth.json'))
  await symlink('/somewhere/else/auth.json', join(home.dir, 'auth.json'))
  await launch.writeLaunchFiles(spec)
  assert.equal(await readlink(join(home.dir, 'auth.json')), join(home.user, 'auth.json'), 'an older symlink is re-pointed')
  assert.deepEqual((await readdir(user)).sort(), before, 'nothing was written into the user Codex home')
  assert.ok(!(await readdir(home.dir)).some(name => name.endsWith('.tmp')))
})

// ---------- lean, cacheable spawns (DROVE-72) ----------

const USER_MCP = { mongodb: { command: 'mongo-mcp', args: [] }, notion: { type: 'http', url: 'https://mcp.example/notion' }, drove: { command: 'stale' } }

const mcpServersOf = (spec: { files: readonly { path: string; content: string }[] }): Record<string, { command?: string; args?: string[] }> =>
  (JSON.parse(fileOf(spec, 'mcp.json') || '{}') as { mcpServers: Record<string, { command?: string; args?: string[] }> }).mcpServers

test('a claude worker without an allowlist loads the user MCP setup as before; with one it runs --strict-mcp-config', () => {
  const open = launch.claudeWorkerSpec(request({ userMcp: USER_MCP }))
  assert.ok(!open.argv.includes('--strict-mcp-config'))
  assert.deepEqual(Object.keys(mcpServersOf(open)), ['drove'])

  const lean = launch.claudeWorkerSpec(request({ mcpAllow: ['mongodb', 'drove', 'missing'], userMcp: USER_MCP }))
  const strict = lean.argv.indexOf('--strict-mcp-config')
  assert.ok(strict >= 0)
  assert.equal(lean.argv[strict + 1], '--no-chrome')
  assert.equal(lean.argv[strict + 2], '--mcp-config')
  const servers = mcpServersOf(lean)
  assert.deepEqual(Object.keys(servers), ['mongodb', 'drove'])
  assert.deepEqual(servers.drove?.args, [ENTRY, 'mcp'], 'a user server named drove never shadows Drove\'s')

  const droveOnly = launch.claudeWorkerSpec(request({ mcpAllow: [], userMcp: USER_MCP }))
  assert.ok(droveOnly.argv.includes('--strict-mcp-config'))
  assert.deepEqual(Object.keys(mcpServersOf(droveOnly)), ['drove'])
  assert.ok(!launch.claudePlannerSpec(request({ identity: planner, mcpAllow: [] })).argv.includes('--strict-mcp-config'), 'the planner keeps the user setup')
})

test('readClaudeMcp merges user, project (.mcp.json) and local scope, local winning, and writes nothing', async () => {
  const { mkdir, writeFile: write, readdir } = await import('node:fs/promises')
  const root = await tmp('claude-mcp')
  const repo = join(root, 'repo')
  await mkdir(repo)
  const config = join(root, '.claude.json')
  await write(config, JSON.stringify({ mcpServers: { a: { command: 'user-a' }, b: { command: 'user-b' } }, projects: { [repo]: { mcpServers: { b: { command: 'local-b' } } } } }))
  await write(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'project-a' }, c: { command: 'project-c' } } }))
  assert.deepEqual(await launch.readClaudeMcp(config, repo), { a: { command: 'project-a' }, b: { command: 'local-b' }, c: { command: 'project-c' } })
  assert.deepEqual(await launch.readClaudeMcp(join(root, 'missing.json'), join(root, 'nowhere')), {})
  assert.deepEqual((await readdir(root)).sort(), ['.claude.json', 'repo'])
})

const MCP_CONFIG = [USER_CONFIG, '', '[mcp_servers.mongodb]', 'command = "mongo-mcp"', 'enabled = true', '', '[mcp_servers.off]', 'command = "off"', 'enabled = false'].join('\n')

test('the codex home config.toml carries the shared role as developer_instructions, never the launch line', () => {
  const spec = launch.codexWorkerSpec(homeRequest({ roleText: ROLE }))
  const config = fileOf(spec, 'config.toml')
  assert.ok(config.includes('check_for_update_on_startup = false\ndeveloper_instructions = "You are a worker.\\nQuote: \\"yes\\" and \\\\ backslash with `ticks`"\n'), config)
  assert.ok(config.indexOf('developer_instructions') < config.indexOf('['), 'a root key, before any table')
  assert.ok(!spec.argv.some(arg => arg.includes('developer_instructions')))
  const other = launch.codexWorkerSpec(homeRequest({ roleText: ROLE, identity: { ...worker, seat: 'w-web' }, cwd: '/work/repo/.claude/worktrees/w-web' }))
  assert.equal(fileOf(other, 'config.toml').replace('/work/repo/.claude/worktrees/w-web', '/work/repo/.claude/worktrees/w-api'), config, 'seats share the role and settings apart from their worktree trust key')
  const resumed = launch.codexWorkerSpec(homeRequest({ roleText: ROLE, resumeId: 'thread-1' }))
  assert.equal(fileOf(resumed, 'config.toml'), config, 'a resume keeps the role')
})

test('workerMcp disables the other user servers in the shared codex home; a seat list differs only by enabled overrides', () => {
  const home = codexHome({ userConfig: MCP_CONFIG })
  const open = launch.codexWorkerSpec(homeRequest({ codexHome: home }))
  assert.ok(fileOf(open, 'config.toml').includes('[mcp_servers.docs]\ncommand = "npx"\nargs = [\n  "docs-mcp",\n]\n\n'))
  assert.ok(!open.argv.some(arg => arg.startsWith('mcp_servers.')))

  const lean = launch.codexWorkerSpec(homeRequest({ codexHome: home, homeMcpAllow: ['mongodb'], mcpAllow: ['mongodb'] }))
  const config = fileOf(lean, 'config.toml')
  assert.ok(config.includes('[mcp_servers.docs]\ncommand = "npx"\nargs = [\n  "docs-mcp",\n]\nenabled = false\n\n[mcp_servers.docs.env]\nTOKEN_FILE = "/home/user/.docs"\n'), config)
  assert.ok(config.includes('[mcp_servers.mongodb]\ncommand = "mongo-mcp"\nenabled = true\n'))
  assert.ok(config.includes('[mcp_servers.off]\ncommand = "off"\nenabled = false\n'))
  assert.ok(!lean.argv.some(arg => arg.startsWith('mcp_servers.')))

  const extra = launch.codexWorkerSpec(homeRequest({ codexHome: home, homeMcpAllow: ['mongodb'], mcpAllow: ['mongodb', 'docs', 'off'] }))
  assert.equal(fileOf(extra, 'config.toml'), config, 'the seat list never changes the shared file')
  assert.deepEqual(extra.argv.filter(arg => arg.startsWith('mcp_servers.')), ['mcp_servers.docs.enabled=true'], 'a server the user disabled stays off')

  const seatOnly = launch.codexWorkerSpec(homeRequest({ codexHome: home, mcpAllow: [] }))
  assert.deepEqual(seatOnly.argv.filter(arg => arg.startsWith('mcp_servers.')), ['mcp_servers.docs.enabled=false', 'mcp_servers.mongodb.enabled=false'])
  assert.deepEqual(launch.codexMcpNames(MCP_CONFIG), ['docs', 'mongodb', 'off'])
})

test('workerSkills links only the named skills into the codex home and unlinks the others it linked before', () => {
  const spec = launch.codexWorkerSpec(homeRequest({ codexHome: codexHome({ linkedSkills: ['cairn', 'croft', 'old'] }), skillAllow: ['croft'] }))
  assert.deepEqual(spec.links?.filter(link => link.path.includes('/skills/')).map(link => link.path), [`${CODEX_DIR}/skills/croft`])
  assert.deepEqual(spec.unlinks, [`${CODEX_DIR}/skills/cairn`, `${CODEX_DIR}/skills/old`])
  assert.equal(launch.codexWorkerSpec(homeRequest({ codexHome: codexHome({ linkedSkills: ['cairn', 'croft'] }) })).unlinks, undefined)
})

test('writeLaunchFiles removes an unlinked skill symlink but never a real folder', async () => {
  const { mkdir, symlink, lstat } = await import('node:fs/promises')
  const root = await tmp('unlink')
  await mkdir(join(root, 'skills', 'real'), { recursive: true })
  await symlink('/somewhere/skill', join(root, 'skills', 'linked'))
  await launch.writeLaunchFiles({ kind: 'codex', role: 'worker', cwd: root, env: {}, argv: [], files: [], unlinks: [join(root, 'skills', 'linked'), join(root, 'skills', 'real'), join(root, 'skills', 'none')] })
  await assert.rejects(lstat(join(root, 'skills', 'linked')))
  assert.ok((await lstat(join(root, 'skills', 'real'))).isDirectory())
})

// ---------- lean workers drop Chrome, unlisted plugins and (opt-in) user memory (DROVE-88) ----------

const settingsOf = (spec: { files: readonly { path: string; content: string }[] }): Record<string, unknown> => JSON.parse(fileOf(spec, 'settings.json')) as Record<string, unknown>

const USER_PLUGINS = {
  enabled: ['context7@claude-plugins-official', 'ralph-loop@claude-plugins-official', 'ccc-skills@ccc'],
  dirs: [
    { entry: '~/.claude/mods/ci-watch', name: 'ci-watch' },
    { entry: '~/.claude/mods/secret-guard', name: 'secret-guard' },
    { entry: '~/maestro-dev/drove/mod', name: 'orchestrator' },
  ],
}

test('a lean claude worker runs --no-chrome unless its allowlist names claude-in-chrome; an open worker and a planner keep Chrome', () => {
  const lean = launch.claudeWorkerSpec(request({ mcpAllow: ['mongodb'] }))
  assert.ok(lean.argv.includes('--no-chrome'))
  assert.ok(launch.claudeWorkerSpec(request({ mcpAllow: [] })).argv.includes('--no-chrome'), "Drove's server alone is lean too")
  assert.ok(!launch.claudeWorkerSpec(request({ mcpAllow: ['mongodb', 'claude-in-chrome'] })).argv.includes('--no-chrome'))
  assert.ok(!launch.claudeWorkerSpec(request({})).argv.includes('--no-chrome'), "no allowlist keeps today's setup")
  assert.ok(!launch.claudePlannerSpec(request({ identity: planner, mcpAllow: [] })).argv.includes('--no-chrome'))
})

test("workerPlugins turns off every other user plugin by enabledPlugins and cuts CLAUDE_CODE_PLUGIN_DIRS, always keeping Drove's mod", () => {
  const open = settingsOf(launch.claudeWorkerSpec(request({})))
  assert.deepEqual(Object.keys(open), ['hooks'], 'nothing set, nothing changed')

  const bare = settingsOf(launch.claudeWorkerSpec(request({ pluginAllow: [], userPlugins: USER_PLUGINS })))
  assert.deepEqual(bare.enabledPlugins, { 'context7@claude-plugins-official': false, 'ralph-loop@claude-plugins-official': false, 'ccc-skills@ccc': false })
  assert.deepEqual(bare.env, { CLAUDE_CODE_PLUGIN_DIRS: '~/maestro-dev/drove/mod' })

  const some = settingsOf(launch.claudeWorkerSpec(request({ pluginAllow: ['context7', 'ccc-skills@ccc', 'secret-guard', 'ci-watch@inline'], userPlugins: USER_PLUGINS })))
  assert.deepEqual(some.enabledPlugins, { 'ralph-loop@claude-plugins-official': false })
  assert.deepEqual(some.env, { CLAUDE_CODE_PLUGIN_DIRS: '~/.claude/mods/ci-watch:~/.claude/mods/secret-guard:~/maestro-dev/drove/mod' })

  const wrongMarket = settingsOf(launch.claudeWorkerSpec(request({ pluginAllow: ['context7@elsewhere'], userPlugins: USER_PLUGINS })))
  assert.deepEqual(Object.keys(wrongMarket.enabledPlugins as object), USER_PLUGINS.enabled, 'a marketplace that does not match allows nothing')

  const noDirs = settingsOf(launch.claudeWorkerSpec(request({ pluginAllow: [], userPlugins: { enabled: [] } })))
  assert.deepEqual(Object.keys(noDirs), ['hooks'], 'no user dir list, no env override; nothing enabled, nothing to disable')

  assert.deepEqual(Object.keys(settingsOf(launch.claudePlannerSpec(request({ identity: planner, pluginAllow: [], userPlugins: USER_PLUGINS })))), ['hooks'], 'the planner is never trimmed')
})

test("readClaudePlugins reads the enabled plugins and each mod dir's name, best effort and read only", async () => {
  const { mkdir, writeFile: write, readdir } = await import('node:fs/promises')
  const root = await tmp('claude-plugins')
  await mkdir(join(root, 'mods', 'named', '.claude-plugin'), { recursive: true })
  await mkdir(join(root, 'mods', 'plain'), { recursive: true })
  await write(join(root, 'mods', 'named', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'real-name' }))
  const settings = join(root, 'settings.json')
  await write(settings, JSON.stringify({
    enabledPlugins: { 'a@m': true, 'b@m': false, c: true },
    env: { CLAUDE_CODE_PLUGIN_DIRS: `${join(root, 'mods', 'named')}:${join(root, 'mods', 'plain')}::${join(root, 'mods', 'missing')}` },
  }))
  assert.deepEqual(await launch.readClaudePlugins(settings), {
    enabled: ['a@m', 'c'],
    dirs: [
      { entry: join(root, 'mods', 'named'), name: 'real-name' },
      { entry: join(root, 'mods', 'plain'), name: 'plain' },
      { entry: join(root, 'mods', 'missing'), name: 'missing' },
    ],
  })
  assert.deepEqual(await launch.readClaudePlugins(join(root, 'absent.json')), { enabled: [] })
  await write(join(root, 'bad.json'), '{ nope')
  assert.deepEqual(await launch.readClaudePlugins(join(root, 'bad.json')), { enabled: [] })
  assert.deepEqual((await readdir(root)).sort(), ['bad.json', 'mods', 'settings.json'])
  assert.equal(launch.userClaudeDir({ CLAUDE_CONFIG_DIR: '/cfg' }), '/cfg')
  assert.match(launch.userClaudeDir({}), /\.claude$/)
})

test("workerUserMemory false adds claudeMdExcludes for the user's CLAUDE.md and every file above the repo, never the repo's own", () => {
  assert.ok(!('claudeMdExcludes' in settingsOf(launch.claudeWorkerSpec(request({})))), 'on by default')
  assert.ok(!('claudeMdExcludes' in settingsOf(launch.claudeWorkerSpec(request({ userMemory: true })))))

  const off = settingsOf(launch.claudeWorkerSpec(request({ userMemory: false, claudeDir: '/home/user/.claude', repo: '/home/user/code/app', cwd: '/home/user/code/app/.claude/worktrees/w-api' })))
  const excludes = off.claudeMdExcludes as string[]
  assert.equal(excludes[0], '/home/user/.claude/CLAUDE.md')
  for (const dir of ['/home/user/code', '/home/user', '/home', '']) {
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) assert.ok(excludes.includes(`${dir}/${name}`), `${dir}/${name}`)
  }
  assert.ok(!excludes.some(path => path.startsWith('/home/user/code/app')), "the repo's own files and its worktree stay")
  assert.equal(new Set(excludes).size, excludes.length)

  assert.deepEqual(launch.claudeMdExcludes('/cfg', '/srv/repo', '/srv/repo').slice(0, 2), ['/cfg/CLAUDE.md', '/srv/CLAUDE.md'], 'CLAUDE_CONFIG_DIR replaces ~/.claude')
  const elsewhere = launch.claudeMdExcludes('/cfg', '/srv/repo', '/srv/trees/w-api')
  assert.ok(elsewhere.includes('/srv/trees/CLAUDE.md'), 'a worktree outside the repo has its own ancestors')
  assert.ok(!elsewhere.includes('/srv/trees/w-api/CLAUDE.md'), "the worktree's own file is the repo's")
  assert.ok(!launch.claudeMdExcludes('/cfg', '/srv/repo', '/srv/repo').includes('/srv/repo/CLAUDE.md'))
  assert.ok(!('claudeMdExcludes' in settingsOf(launch.claudePlannerSpec(request({ identity: planner, userMemory: false })))), 'the planner keeps its memory')
})

test('workerUserMemory false leaves AGENTS.md and AGENTS.override.md out of the codex home and unlinks them; auth.json stays', () => {
  const home = codexHome({ links: ['auth.json', 'AGENTS.md', 'AGENTS.override.md'] })
  const on = launch.codexWorkerSpec(homeRequest({ codexHome: home }))
  assert.deepEqual(on.links?.filter(link => !link.path.includes('/skills/')).map(link => link.path), [`${CODEX_DIR}/auth.json`, `${CODEX_DIR}/AGENTS.md`, `${CODEX_DIR}/AGENTS.override.md`])
  assert.equal(on.unlinks, undefined)

  const off = launch.codexWorkerSpec(homeRequest({ codexHome: home, userMemory: false }))
  assert.deepEqual(off.links?.filter(link => !link.path.includes('/skills/')).map(link => link.path), [`${CODEX_DIR}/auth.json`])
  assert.deepEqual(off.unlinks, [`${CODEX_DIR}/AGENTS.md`, `${CODEX_DIR}/AGENTS.override.md`], 'a link an earlier spawn made goes')
})

test('writeLaunchFiles applies the memory unlinks to a symlink an earlier spawn made and keeps a real AGENTS file', async () => {
  const { mkdir, symlink, lstat, writeFile: write } = await import('node:fs/promises')
  const root = await tmp('memory-unlink')
  const home = join(root, 'codex-home')
  await mkdir(home)
  await symlink(join(root, 'user', 'AGENTS.md'), join(home, 'AGENTS.md'))
  await write(join(home, 'AGENTS.override.md'), 'made by hand')
  const spec = launch.codexWorkerSpec(homeRequest({ codexHome: codexHome({ dir: home, user: join(root, 'user'), links: ['AGENTS.md'] }), userMemory: false }))
  await launch.writeLaunchFiles({ ...spec, files: [] })
  await assert.rejects(lstat(join(home, 'AGENTS.md')))
  assert.equal(await readFile(join(home, 'AGENTS.override.md'), 'utf8'), 'made by hand')
})

// ---------- lean workers drop skills, agents and (opt-in) the user's settings hooks (DROVE-98) ----------

const USER_SKILLS = ['arb', 'cairn', 'anthropic-skills:docx', 'audit']
const USER_AGENTS = ['debugger', 'code-reviewer']

test('workerSkills switches off the user skills the list leaves out, by exact name, and an entry may drop the claude.ai prefix', () => {
  assert.ok(!('skillOverrides' in settingsOf(launch.claudeWorkerSpec(request({})))), 'no list, nothing changed')
  const some = settingsOf(launch.claudeWorkerSpec(request({ skillAllow: ['cairn', 'docx'], userSkills: USER_SKILLS })))
  assert.deepEqual(some.skillOverrides, { arb: 'off', audit: 'off' })
  assert.ok(!launch.claudeWorkerSpec(request({ skillAllow: ['cairn'], userSkills: USER_SKILLS })).argv.includes('--disable-slash-commands'))
  assert.ok(!('skillOverrides' in settingsOf(launch.claudePlannerSpec(request({ identity: planner, skillAllow: [], userSkills: USER_SKILLS })))), 'the planner is never trimmed')
})

test('an empty workerSkills list is --disable-slash-commands for the worker: no skill at all', () => {
  const none = launch.claudeWorkerSpec(request({ skillAllow: [], userSkills: USER_SKILLS }))
  assert.ok(none.argv.includes('--disable-slash-commands'))
  assert.deepEqual(settingsOf(none).skillOverrides, { arb: 'off', cairn: 'off', 'anthropic-skills:docx': 'off', audit: 'off' })
  assert.ok(!launch.claudePlannerSpec(request({ identity: planner, skillAllow: [] })).argv.includes('--disable-slash-commands'))
})

test('workerAgents denies the Agent(<name>) of every user agent the list leaves out', () => {
  assert.ok(!('permissions' in settingsOf(launch.claudeWorkerSpec(request({})))))
  const some = settingsOf(launch.claudeWorkerSpec(request({ agentAllow: ['debugger'], userAgents: USER_AGENTS })))
  assert.deepEqual(some.permissions, { deny: ['Agent(code-reviewer)'] })
  const none = settingsOf(launch.claudeWorkerSpec(request({ agentAllow: [], userAgents: USER_AGENTS })))
  assert.deepEqual(none.permissions, { deny: ['Agent(debugger)', 'Agent(code-reviewer)'] })
  assert.ok(!('permissions' in settingsOf(launch.claudePlannerSpec(request({ identity: planner, agentAllow: [], userAgents: USER_AGENTS })))))
})

test("workerUserHooks false drops the user setting source and carries the user's settings.json minus its hooks into Drove's settings", () => {
  const userSettings = {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cairn-start' }] }] },
    env: { NOTION_API_KEY: 'k', CLAUDE_CODE_PLUGIN_DIRS: '~/mods/a:~/mods/b' },
    permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm -rf *)'] },
    enabledPlugins: { 'context7@claude-plugins-official': true, 'ccc-skills@ccc': true },
    skipDangerousModePermissionPrompt: true,
    claudeMdExcludes: ['/user/exclude.md'],
  }
  const open = launch.claudeWorkerSpec(request({ userHooks: false, userSettings }))
  assert.deepEqual(open.argv.slice(open.argv.indexOf('--setting-sources'), open.argv.indexOf('--setting-sources') + 2), ['--setting-sources', 'project,local'])
  const settings = settingsOf(open)
  assert.deepEqual(Object.keys(settings.hooks as object), ['PreToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification'], "Drove's hooks only")
  assert.ok(!JSON.stringify(settings.hooks).includes('cairn-start'))
  assert.deepEqual(settings.env, userSettings.env)
  assert.deepEqual(settings.permissions, userSettings.permissions)
  assert.deepEqual(settings.enabledPlugins, userSettings.enabledPlugins)
  assert.equal(settings.skipDangerousModePermissionPrompt, true)
  assert.deepEqual(settings.claudeMdExcludes, ['/user/exclude.md'])

  const merged = settingsOf(launch.claudeWorkerSpec(request({
    userHooks: false, userSettings, pluginAllow: ['context7'], userPlugins: { enabled: ['context7@claude-plugins-official', 'ccc-skills@ccc'], dirs: [{ entry: '~/mods/a', name: 'a' }, { entry: '~/mods/b', name: 'b' }] },
    agentAllow: [], userAgents: USER_AGENTS, skillAllow: ['cairn'], userSkills: USER_SKILLS, userMemory: false, claudeDir: '/home/user/.claude',
  })))
  assert.deepEqual(merged.enabledPlugins, { 'context7@claude-plugins-official': true, 'ccc-skills@ccc': false })
  assert.deepEqual(merged.env, { NOTION_API_KEY: 'k', CLAUDE_CODE_PLUGIN_DIRS: '' }, "Drove's plugin dir list replaces the user's, the rest of env stays")
  assert.deepEqual(merged.permissions, userSettings.permissions, 'the user skills and agents are not loaded without the source: nothing to deny')
  assert.ok(!('skillOverrides' in merged))
  assert.deepEqual((merged.claudeMdExcludes as string[]).slice(0, 2), ['/user/exclude.md', '/home/user/.claude/CLAUDE.md'])

  const off = launch.claudeWorkerSpec(request({ userHooks: false }))
  assert.deepEqual(Object.keys(settingsOf(off)), ['hooks'], 'a settings.json that could not be read carries nothing')
  assert.ok(!launch.claudeWorkerSpec(request({ userHooks: true, userSettings })).argv.includes('--setting-sources'))
  const planned = launch.claudePlannerSpec(request({ identity: planner, userHooks: false, userSettings }))
  assert.ok(!planned.argv.includes('--setting-sources'), 'the planner keeps the user source')
  assert.deepEqual(Object.keys(settingsOf(planned)), ['hooks'])
})

test('a worker without the user setting source is handed the user-scope MCP servers, since Claude no longer reads them', () => {
  const userMcp = { mongodb: { command: 'mongo-mcp' }, notion: { command: 'notion-mcp' }, drove: { command: 'stale' } }
  const mcpOf = (spec: { files: readonly { path: string; content: string }[] }): string[] => Object.keys((JSON.parse(fileOf(spec, 'mcp.json')) as { mcpServers: object }).mcpServers)
  assert.deepEqual(mcpOf(launch.claudeWorkerSpec(request({ userHooks: false, userMcp }))), ['mongodb', 'notion', 'drove'])
  assert.deepEqual(mcpOf(launch.claudeWorkerSpec(request({ userHooks: false, userMcp, mcpAllow: ['notion'] }))), ['notion', 'drove'], 'an allowlist still wins')
  assert.deepEqual(mcpOf(launch.claudeWorkerSpec(request({ userMcp }))), ['drove'], 'with the source kept, Claude loads them itself')
  assert.ok(!launch.claudeWorkerSpec(request({ userHooks: false, userMcp })).argv.includes('--strict-mcp-config'))
})

test("workerUserHooks false leaves the user's Codex hooks out of the shared home's hooks.json and their trust out of config.toml", () => {
  const on = JSON.parse(fileOf(launch.codexWorkerSpec(homeRequest({})), 'hooks.json')) as { hooks: Record<string, unknown[]> }
  assert.equal(on.hooks.SessionStart?.length, 2)
  const spec = launch.codexWorkerSpec(homeRequest({ userHooks: false }))
  const hooks = (JSON.parse(fileOf(spec, 'hooks.json')) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks
  assert.deepEqual(hooks.SessionStart?.map(group => group.hooks[0]?.command), [`${HOME}/g-d43caf1d session-start`])
  assert.deepEqual(hooks.Stop?.map(group => group.hooks[0]?.command), [`${HOME}/g-d43caf1d stop`])
  const config = fileOf(spec, 'config.toml')
  assert.ok(!config.includes('user-approved') && !config.includes('user-stop'))
  assert.ok(config.includes(`hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:`), "Drove's own hook moves to index 0 and stays trusted")
})

test("readClaudeSkills and readClaudeAgents read the names Claude lists: skill folders, synced claude.ai skills, commands and agent files", async () => {
  const { mkdir, writeFile: write, symlink } = await import('node:fs/promises')
  const root = await tmp('claude-names')
  const put = async (path: string, text: string): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true })
    await write(path, text)
  }
  await put(join(root, 'skills', 'cairn', 'SKILL.md'), '---\nname: cairn\ndescription: x\n---\n')
  await put(join(root, 'skills', 'renamed', 'SKILL.md'), '---\nname: "pretty-name"\n---\n')
  await put(join(root, 'skills', 'lib', 'helper.sh'), 'not a skill')
  await put(join(root, 'skills', 'synced', 'acct-1', 'docx', 'SKILL.md'), '---\nname: docx\n---\n')
  await put(join(root, 'skills', 'synced', 'acct-2', 'docx', 'SKILL.md'), '---\nname: docx\n---\n')
  await put(join(root, 'skills', 'synced', 'acct-1', 'manifest.json'), '{}')
  await put(join(root, 'commands', 'audit.md'), 'x')
  await put(join(root, 'commands', 'team', 'plan.md'), 'x')
  await put(join(root, 'agents', 'debugger.md'), '---\nname: debugger\n---\n')
  await put(join(root, 'agents', 'design', 'ui.md'), '---\ndescription: no name\n---\n')
  await put(join(root, 'agents', 'design', 'named.md'), '---\nname: ux-lead\n---\n')
  await symlink(join(root, 'skills', 'cairn'), join(root, 'skills', 'linked'))
  assert.deepEqual((await launch.readClaudeSkills(root)).sort(), ['anthropic-skills:docx', 'audit', 'cairn', 'pretty-name', 'team:plan'])
  assert.deepEqual((await launch.readClaudeAgents(root)).sort(), ['debugger', 'ui', 'ux-lead'])
  assert.deepEqual(await launch.readClaudeSkills(join(root, 'absent')), [])
  assert.deepEqual(await launch.readClaudeAgents(join(root, 'absent')), [])
  assert.deepEqual(await launch.readClaudeSettings(join(root, 'absent.json')), {})
})

test('redactSpec masks env values in settings.json, mcp.json (not Drove\'s server) and config.toml env tables, and keeps Drove\'s own variables', () => {
  const spec = launch.redactSpec({
    kind: 'claude', role: 'worker', cwd: '/x', env: { DROVE_RUN: 'r-1', DROVE_TOKEN: 'tok-1', DROVE_AGENT: 'claude', MY_KEY: 'k-1' }, argv: ['--note', 'tok-1'],
    files: [
      { path: '/s/settings.json', mode: 0o600, content: JSON.stringify({ env: { A: 'a-secret', CLAUDE_CODE_PLUGIN_DIRS: 'dirs' }, permissions: { allow: ['x'] } }) },
      { path: '/s/mcp.json', mode: 0o600, content: JSON.stringify({ mcpServers: { drove: { command: 'node', env: { DROVE_TOKEN: 'tok-1', DROVE_RUN: 'r-1' } }, n: { command: 'n', env: { T: 't-secret' }, headers: { H: 'h-secret' } } } }) },
      { path: '/h/config.toml', mode: 0o600, content: '[mcp_servers.d]\ncommand = "d"\n\n[mcp_servers.d.env]\nTOKEN = "c-secret"\nOTHER = "o-secret"\n\n[projects."/x"]\ntrust_level = "trusted"\n' },
    ],
  })
  const all = JSON.stringify(spec)
  for (const secret of ['a-secret', 'dirs', 't-secret', 'h-secret', 'c-secret', 'o-secret', 'k-1', 'tok-1']) assert.ok(!all.includes(secret), secret)
  assert.deepEqual([spec.env.DROVE_RUN, spec.env.DROVE_AGENT, spec.env.MY_KEY], ['r-1', 'claude', '<redacted>'])
  const mcp = JSON.parse(spec.files[1]?.content ?? '{}') as { mcpServers: { drove: { env: Record<string, string> } } }
  assert.deepEqual(mcp.mcpServers.drove.env, { DROVE_TOKEN: '<redacted>', DROVE_RUN: 'r-1' })
  assert.ok(spec.files[2]?.content.includes('[projects."/x"]\ntrust_level = "trusted"'))
  assert.ok(spec.files[2]?.content.includes('command = "d"'))
})
