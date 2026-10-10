import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
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

// ---------- Drove-owned CODEX_HOME (DROVE-34) ----------

const CODEX_DIR = '/home/cal/.drove/runs/drove-20261009-1042-a3f1/codex-home'
const USER_CODEX = '/home/cal/.codex'
const USER_CONFIG = [
  'model = "gpt-6.1-sol"',
  "personality = 'pragmatic'",
  'model_reasoning_effort = "high"',
  '',
  '[projects."/home/cal/elsewhere"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.docs]',
  'command = "npx"',
  'args = [',
  '  "docs-mcp",',
  ']',
  '',
  '[mcp_servers.docs.env]',
  'TOKEN_FILE = "/home/cal/.docs"',
  '',
  '[mcp_servers.drove]',
  'command = "stale"',
  '',
  '[tui]',
  'screen_reader_detection_done = true',
  '',
  '[hooks.state."/home/cal/.codex/hooks.json:session_start:0:0"]',
  'trusted_hash = "sha256:user-approved"',
  '',
  '[hooks.state."/home/cal/.codex/hooks.json:stop:0:0"]',
  'trusted_hash = "sha256:user-stop"',
  'enabled = false',
  '',
  '[hooks.state."/<session-flags>/config.toml:stop:0:0"]',
  'trusted_hash = "sha256:old-inline"',
].join('\n')
const USER_HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: "bash '/home/cal/.codex/herdr-agent-state.sh' session", timeout: 10 }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'cairn-end', timeout: 120, async: true }] }],
}
const codexHome = (overrides: Partial<launch.CodexHome> = {}): launch.CodexHome => ({
  dir: CODEX_DIR, user: USER_CODEX, userConfig: USER_CONFIG, userHooks: USER_HOOKS, links: ['auth.json', 'AGENTS.md'], skills: ['cairn', 'croft'], ...overrides,
})
const homeRequest = (overrides: Partial<launch.CodexLaunchRequest> = {}) =>
  request({ kind: 'codex', model: 'gpt-x', effort: 'high', roleText: '', initialPrompt: undefined, codexHome: codexHome(), ...overrides })
const fileOf = (spec: { files: readonly { path: string; content: string }[] }, name: string): string => spec.files.find(file => file.path.endsWith(`/${name}`))?.content ?? ''

test('codexHookHash reproduces the trusted_hash values Codex itself wrote (codex-cli 0.162.0)', () => {
  const shim = '/Users/cal/.drove/g-ff7841bf'
  const command = (event: string) => ({ type: 'command', command: `${shim} ${event}`, timeout: 10 })
  assert.equal(launch.codexHookHash('PreToolUse', { matcher: launch.CODEX_GUARDED_TOOLS }, command('pre-tool-use')), 'sha256:164080a958b75aedbbaf804fddc99ac5a7dfac9779587c0bab11e1f72abe34c5')
  assert.equal(launch.codexHookHash('PermissionRequest', {}, command('permission-request')), 'sha256:12473e07e15a5d300591c818a3e98e32656cea5ad30d810b2912e6831d1aa383')
  assert.equal(launch.codexHookHash('SessionStart', {}, command('session-start')), 'sha256:b1f47b3c43ad06c6726a135cf0ca33355c01a434ac05b0e7dbf1c152f2f77643')
  assert.equal(launch.codexHookHash('UserPromptSubmit', {}, command('user-prompt-submit')), 'sha256:2879930912548ff1529c26e88918af63a70979b68430a967f9aaa492887f61bf')
  assert.equal(launch.codexHookHash('Stop', {}, command('stop')), 'sha256:6a7dff9277070641a6b1a1d35637089498f5c614c577472eac9d576486b8a07c')
  assert.equal(launch.codexHookHash('SessionStart', {}, { type: 'command', command: "bash '/Users/cal/.codex/herdr-agent-state.sh' session", timeout: 10 }), 'sha256:caebd0a1922d55ac29a2de20f125aa461e0a11777d499c99f22c11597ed42a4c')
  assert.equal(
    launch.codexHookHash('Stop', {}, { type: 'command', command: 'CAIRN_AGENT=codex CAIRN_PLATFORM=codex node /Users/cal/.cairn/hooks/cairn-session-end.mjs --ongoing', timeout: 120, async: true }),
    'sha256:9e08c97c86da93f549b778314a7f9917369cde4da6b4559520c5b2eb3b100315',
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
  assert.ok(!config.includes('/home/cal/elsewhere'))
  assert.ok(config.includes('[mcp_servers.drove]\ncommand = "node"\nargs = ["/opt/drove/src/cli.ts", "mcp"]\nenv_vars = ["DROVE_HOME", "DROVE_RUN", "DROVE_ROLE", "DROVE_SEAT", "DROVE_TOKEN"]\ndefault_tools_approval_mode = "approve"\n'))
  assert.ok(config.includes('[mcp_servers.docs]\ncommand = "npx"\nargs = [\n  "docs-mcp",\n]\n\n[mcp_servers.docs.env]\nTOKEN_FILE = "/home/cal/.docs"\n'))
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

test('the Drove hooks.json keeps the user groups first, at the indices their trust is keyed by, then Drove groups', () => {
  const hooks = (JSON.parse(fileOf(launch.codexWorkerSpec(homeRequest()), 'hooks.json')) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> }).hooks
  assert.deepEqual(hooks.SessionStart?.map(group => group.hooks[0]?.command), ["bash '/home/cal/.codex/herdr-agent-state.sh' session", `${HOME}/g-d43caf1d session-start`])
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
