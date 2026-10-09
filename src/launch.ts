import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ENV, plannerDir, seatDir } from './paths.ts'
import type { Identity, LaunchFile, LaunchRequest, LaunchSpec, Role } from './types.ts'

export const CLAUDE_GUARDED_TOOLS = 'Bash|Edit|Write|MultiEdit|NotebookEdit'
export const CODEX_GUARDED_TOOLS = 'Bash|shell|exec_command|apply_patch'

const HOOK_TIMEOUT_S = 10
const REDACTED = '<redacted>'
const CODEX_NETWORK_FLAG = 'sandbox_workspace_write.network_access=true'
const CHANNEL_FLAG = '--dangerously-load-development-channels'

export const tomlString = (value: string): string => {
  const escaped = [...value]
    .map(char => {
      const code = char.codePointAt(0) ?? 0
      if (char === '\\') return '\\\\'
      if (char === '"') return '\\"'
      if (char === '\n') return '\\n'
      if (char === '\r') return '\\r'
      if (char === '\t') return '\\t'
      if (char === '\b') return '\\b'
      if (char === '\f') return '\\f'
      return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : char
    })
    .join('')
  return `"${escaped}"`
}

const tomlArray = (values: readonly string[]): string => `[${values.map(tomlString).join(', ')}]`
const tomlTable = (entries: Record<string, string>): string => `{${Object.entries(entries).map(([key, value]) => `${key}=${tomlString(value)}`).join(', ')}}`

const UNSAFE_ARG = /[\u0000-\u001f\u007f]/

export const isShellSafeArg = (arg: string): boolean => !UNSAFE_ARG.test(arg)

export const assertShellSafeArgs = (argv: readonly string[]): void => {
  const index = argv.findIndex(arg => !isShellSafeArg(arg))
  if (index >= 0) throw new Error(`launch argument ${index} has a newline or control character, which herdr cannot type into the pane's shell: ${JSON.stringify(argv[index]?.slice(0, 60))}`)
}

const shellQuote = (value: string): string => (/^[A-Za-z0-9_\/.:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`)

const hookCommand = (droveEntry: string, event: string): string => `node ${shellQuote(droveEntry)} guard ${event}`

const identityEnv = (identity: Identity): Record<string, string> => ({
  [ENV.home]: identity.home,
  [ENV.run]: identity.run,
  [ENV.role]: identity.role,
  [ENV.seat]: identity.seat,
  ...(identity.token ? { [ENV.token]: identity.token } : {}),
})

const claudeHook = (droveEntry: string, event: string) => ({ type: 'command', command: hookCommand(droveEntry, event), timeout: HOOK_TIMEOUT_S })

export const claudeSettings = (droveEntry: string, _role: Role): Record<string, unknown> => ({
  hooks: {
    PreToolUse: [{ matcher: CLAUDE_GUARDED_TOOLS, hooks: [claudeHook(droveEntry, 'pre-tool-use')] }],
    SessionStart: [{ hooks: [claudeHook(droveEntry, 'session-start')] }],
    Stop: [{ hooks: [claudeHook(droveEntry, 'stop')] }],
    Notification: [{ hooks: [claudeHook(droveEntry, 'notification')] }],
  },
})

export const claudeMcpConfig = (droveEntry: string, env: Record<string, string> = {}): Record<string, unknown> => ({
  mcpServers: { drove: { command: 'node', args: [droveEntry, 'mcp'], ...(Object.keys(env).length > 0 ? { env } : {}) } },
})

const jsonFile = (path: string, value: unknown): LaunchFile => ({ path, content: `${JSON.stringify(value, null, 2)}\n`, mode: 0o600 })

const dirOf = (identity: Identity): string => (identity.role === 'planner' ? plannerDir(identity.home, identity.run) : seatDir(identity.home, identity.run, identity.seat))

const claudeSpec = (request: LaunchRequest): LaunchSpec => {
  const { identity } = request
  const dir = dirOf(identity)
  const isWorker = identity.role === 'worker'
  const mcpPath = `${dir}/mcp.json`
  const settingsPath = `${dir}/settings.json`
  const rolePath = `${dir}/role.md`
  const prompt = request.initialPrompt
  const argv = [
    ...(isWorker ? ['--dangerously-skip-permissions'] : []),
    '--model', request.model,
    '--effort', request.effort,
    ...(isWorker ? ['-n', identity.seat] : []),
    ...(isWorker && !request.resumeId ? ['--worktree', identity.seat] : []),
    ...(request.resumeId ? ['--resume', request.resumeId] : request.sessionId ? ['--session-id', request.sessionId] : []),
    '--mcp-config', mcpPath,
    '--settings', settingsPath,
    ...(request.roleText ? ['--append-system-prompt-file', rolePath] : []),
    ...(!isWorker && request.channel ? [CHANNEL_FLAG, 'server:drove'] : []),
    ...(prompt ? (prompt.startsWith('-') ? ['--', prompt] : [prompt]) : []),
  ]
  assertShellSafeArgs(isWorker || !prompt ? argv : argv.slice(0, -1))
  return {
    kind: 'claude',
    role: identity.role,
    cwd: request.cwd,
    env: { ...(isWorker ? { _CC_ACCT_PINNED: '1' } : {}), ...identityEnv(identity), DROVE_AGENT: 'claude', ...(!isWorker && request.channel ? { DROVE_CHANNEL: '1' } : {}) },
    argv,
    files: [
      jsonFile(mcpPath, claudeMcpConfig(request.droveEntry, identityEnv(identity))),
      jsonFile(settingsPath, claudeSettings(request.droveEntry, identity.role)),
      ...(request.roleText ? [{ path: rolePath, content: `${request.roleText}\n`, mode: 0o600 }] : []),
    ],
  }
}

const codexHook = (droveEntry: string, event: string, matcher?: string): string =>
  `[{${matcher ? `matcher=${tomlString(matcher)}, ` : ''}hooks=[{type="command", command=${tomlString(hookCommand(droveEntry, event))}, timeout=${HOOK_TIMEOUT_S}}]}]`

const codexSpec = (request: LaunchRequest): LaunchSpec => {
  const { identity } = request
  const isWorker = identity.role === 'worker'
  const env = identityEnv(identity)
  const writableRoots = isWorker ? [`${request.repo}/.git`] : [`${request.repo}/.git`, `${identity.home}/runs/${identity.run}`]
  const overrides = [
    `model_reasoning_effort=${tomlString(request.effort)}`,
    ...(isWorker ? ['check_for_update_on_startup=false'] : []),
    CODEX_NETWORK_FLAG,
    ...(isWorker ? [`projects.${tomlString(request.cwd)}.trust_level="trusted"`] : []),
    `mcp_servers.drove.command="node"`,
    `mcp_servers.drove.args=${tomlArray([request.droveEntry, 'mcp'])}`,
    `mcp_servers.drove.env=${tomlTable(env)}`,
    `mcp_servers.drove.default_tools_approval_mode="approve"`,
    ...(request.roleText ? [`developer_instructions=${tomlString(request.roleText)}`] : []),
    `hooks.PreToolUse=${codexHook(request.droveEntry, 'pre-tool-use', CODEX_GUARDED_TOOLS)}`,
    `hooks.SessionStart=${codexHook(request.droveEntry, 'session-start')}`,
    `hooks.UserPromptSubmit=${codexHook(request.droveEntry, 'user-prompt-submit')}`,
    `hooks.Stop=${codexHook(request.droveEntry, 'stop')}`,
    `hooks.PermissionRequest=${codexHook(request.droveEntry, 'permission-request')}`,
  ]
  const argv = [
    ...(request.resumeId ? ['resume', request.resumeId] : []),
    '-s', 'workspace-write',
    '-C', request.cwd,
    ...writableRoots.flatMap(dir => ['--add-dir', dir]),
    ...(request.model ? ['-m', request.model] : []),
    ...overrides.flatMap(override => ['-c', override]),
    ...(request.bypassHookTrust ? ['--dangerously-bypass-hook-trust'] : []),
    ...(request.initialPrompt ? [request.initialPrompt] : []),
  ]
  assertShellSafeArgs(isWorker || !request.initialPrompt ? argv : argv.slice(0, -1))
  return { kind: 'codex', role: identity.role, cwd: request.cwd, env: { ...env, DROVE_AGENT: 'codex' }, argv, files: [] }
}

const requireRole = (request: LaunchRequest, role: Role): LaunchRequest => {
  if (request.identity.role !== role) throw new Error(`launch spec for ${role} was asked with identity role ${request.identity.role}`)
  return request
}

export const claudeWorkerSpec = (request: LaunchRequest): LaunchSpec => claudeSpec(requireRole(request, 'worker'))
export const codexWorkerSpec = (request: LaunchRequest): LaunchSpec => codexSpec(requireRole(request, 'worker'))
export const claudePlannerSpec = (request: LaunchRequest): LaunchSpec => claudeSpec(requireRole(request, 'planner'))
export const codexPlannerSpec = (request: LaunchRequest): LaunchSpec => codexSpec(requireRole(request, 'planner'))

export const specFor = (request: LaunchRequest): LaunchSpec => {
  if (request.kind === 'claude') return request.identity.role === 'worker' ? claudeWorkerSpec(request) : claudePlannerSpec(request)
  return request.identity.role === 'worker' ? codexWorkerSpec(request) : codexPlannerSpec(request)
}

export const redactSpec = (spec: LaunchSpec): LaunchSpec => {
  const token = spec.env[ENV.token]
  if (!token) return spec
  const scrub = (text: string): string => text.replaceAll(token, REDACTED)
  return {
    ...spec,
    env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, scrub(value)])),
    argv: spec.argv.map(scrub),
    files: spec.files.map(file => ({ ...file, content: scrub(file.content) })),
  }
}

export const writeLaunchFiles = async (spec: LaunchSpec): Promise<void> => {
  for (const file of spec.files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 })
    await writeFile(file.path, file.content, { mode: file.mode })
    await chmod(file.path, file.mode)
  }
}

export const execArgv = (spec: LaunchSpec): string[] => [spec.kind, ...spec.argv]
