import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ENV, plannerDir, seatDir } from './paths.ts'
import type { Identity, LaunchFile, LaunchLink, LaunchRequest, LaunchSpec, Role } from './types.ts'

export const CLAUDE_GUARDED_TOOLS = 'Bash|Edit|Write|MultiEdit|NotebookEdit'
export const CODEX_GUARDED_TOOLS = 'Bash|shell|exec_command|apply_patch'

const HOOK_TIMEOUT_S = 10
const REDACTED = '<redacted>'
const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox'
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
    UserPromptSubmit: [{ hooks: [claudeHook(droveEntry, 'user-prompt-submit')] }],
    Stop: [{ hooks: [claudeHook(droveEntry, 'stop')] }],
    StopFailure: [{ hooks: [claudeHook(droveEntry, 'stop-failure')] }],
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
    ...(isWorker && !request.resumeId && !request.inWorktree ? ['--worktree', identity.seat] : []),
    ...(request.resumeId ? ['--resume', request.resumeId] : request.sessionId ? ['--session-id', request.sessionId] : []),
    ...(!isWorker && request.channel ? [CHANNEL_FLAG, 'server:drove'] : []),
    '--mcp-config', mcpPath,
    '--settings', settingsPath,
    ...(request.roleText ? ['--append-system-prompt-file', rolePath] : []),
    ...(prompt ? (prompt.startsWith('-') ? ['--', prompt] : [prompt]) : []),
  ]
  assertShellSafeArgs(isWorker || !prompt ? argv : argv.slice(0, -1))
  return {
    kind: 'claude',
    role: identity.role,
    cwd: request.cwd,
    env: { ...(isWorker ? request.workerEnv : {}), ...identityEnv(identity), DROVE_AGENT: 'claude', ...(!isWorker && request.channel ? { DROVE_CHANNEL: '1' } : {}) },
    argv,
    files: [
      jsonFile(mcpPath, claudeMcpConfig(request.droveEntry, identityEnv(identity))),
      jsonFile(settingsPath, claudeSettings(request.droveEntry, identity.role)),
      ...(request.roleText ? [{ path: rolePath, content: `${request.roleText}\n`, mode: 0o600 }] : []),
    ],
  }
}

// What Drove read from the user's own Codex home for a Drove-owned CODEX_HOME (DROVE-34). Drove never writes there.
export type CodexHome = {
  dir: string
  user: string
  userConfig: string
  userHooks: Record<string, unknown[]>
  links: string[]
  skills: string[]
}

export type CodexLaunchRequest = LaunchRequest & { bypassSandbox?: boolean; codexHome?: CodexHome }

// The Codex launch line is typed into a shell, so every byte counts (DROVE-23). One shim per drove entry, named by a
// hash of it so two checkouts sharing a home never overwrite each other, replaces `node <entry> guard` in all hooks.
const guardShim = (identity: Identity, droveEntry: string): LaunchFile => ({
  path: `${identity.home}/g-${createHash('sha1').update(droveEntry).digest('hex').slice(0, 8)}`,
  content: `#!/bin/sh\nexec node ${shellQuote(droveEntry)} guard "$@"\n`,
  mode: 0o700,
})

const codexHook = (shim: string, event: string, matcher?: string): string =>
  `[{${matcher ? `matcher=${tomlString(matcher)},` : ''}hooks=[{type="command",command=${tomlString(`${shellQuote(shim)} ${event}`)},timeout=${HOOK_TIMEOUT_S}}]}]`

const compactTomlArray = (values: readonly string[]): string => `[${values.map(tomlString).join(',')}]`

type HookHandler = { type?: string; command?: string; timeout?: number; async?: boolean; statusMessage?: string; additionalContextLimit?: number }
type HookGroup = { matcher?: string; hooks?: HookHandler[] }

const HOOK_LABELS: Record<string, string> = {
  PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request', PostToolUse: 'post_tool_use', PreCompact: 'pre_compact', PostCompact: 'post_compact', SessionStart: 'session_start',
  SessionEnd: 'session_end', UserPromptSubmit: 'user_prompt_submit', SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop', Stop: 'stop', Interrupt: 'interrupt',
}
const MATCHERLESS_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'Interrupt'])
const CONTEXT_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'SubagentStart'])
const DEFAULT_CONTEXT_LIMIT = 2500

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Codex's hook trust fingerprint, as stored in `hooks.state."<file>:<event>:<group>:<handler>".trusted_hash`
// (openai/codex rust-v0.162.0: hooks/src/engine/discovery.rs hook_hash, config/src/fingerprint.rs version_for_toml).
export const codexHookHash = (event: string, group: HookGroup, handler: HookHandler): string => {
  const isShortLived = event === 'SessionEnd' || event === 'Interrupt'
  const timeout = isShortLived ? Math.max(1, Math.min(3, handler.timeout ?? 1)) : Math.max(1, handler.timeout ?? 600)
  const contextLimit = CONTEXT_EVENTS.has(event) ? handler.additionalContextLimit : undefined
  const identity = {
    event_name: HOOK_LABELS[event],
    ...(!MATCHERLESS_EVENTS.has(event) && group.matcher != null ? { matcher: group.matcher } : {}),
    hooks: [{
      type: 'command', command: handler.command, timeout, async: Boolean(handler.async),
      ...(handler.statusMessage != null ? { statusMessage: handler.statusMessage } : {}),
      ...(contextLimit != null && contextLimit !== DEFAULT_CONTEXT_LIMIT ? { additionalContextLimit: contextLimit } : {}),
    }],
  }
  return `sha256:${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`
}

const TOML_KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`
const TOML_HEADER = new RegExp(String.raw`^\s*\[\[?\s*${TOML_KEY}(?:\s*\.\s*${TOML_KEY})*\s*\]\]?\s*(?:#.*)?$`)

type TomlSection = { header: string; body: string[] }

// Enough TOML to lift whole tables out of the user's config.toml without a parser: a table runs to the next header.
const tomlSections = (text: string): TomlSection[] => {
  const sections: TomlSection[] = [{ header: '', body: [] }]
  for (const line of text.split(/\r?\n/)) {
    if (TOML_HEADER.test(line)) sections.push({ header: line.trim(), body: [] })
    else sections.at(-1)?.body.push(line)
  }
  return sections
}

const unquoteKey = (raw: string): string => {
  if (raw.startsWith("'")) return raw.slice(1, -1)
  if (!raw.startsWith('"')) return raw
  try {
    return JSON.parse(raw) as string
  } catch {
    return raw.slice(1, -1)
  }
}

const USER_ROOT_KEY = /^\s*(model|personality)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/
const MCP_HEADER = new RegExp(String.raw`^\[\s*mcp_servers\s*\.\s*(${TOML_KEY})`)
const HOOK_STATE_HEADER = new RegExp(String.raw`^\[\s*hooks\s*\.\s*state\s*\.\s*(${TOML_KEY})\s*\]`)

type HookTrust = { hash?: string; enabled?: boolean }

const userHookTrust = (sections: readonly TomlSection[]): Map<string, HookTrust> => {
  const trust = new Map<string, HookTrust>()
  for (const section of sections) {
    const key = HOOK_STATE_HEADER.exec(section.header)?.[1]
    if (!key) continue
    const hash = section.body.map(line => /^\s*trusted_hash\s*=\s*"([^"]*)"/.exec(line)?.[1]).find(Boolean)
    const enabled = section.body.map(line => /^\s*enabled\s*=\s*(true|false)\b/.exec(line)?.[1]).find(Boolean)
    trust.set(unquoteKey(key), { ...(hash ? { hash } : {}), ...(enabled ? { enabled: enabled === 'true' } : {}) })
  }
  return trust
}

const trimBlank = (lines: readonly string[]): string[] => {
  const kept = [...lines]
  while (kept.length > 0 && !kept.at(-1)?.trim()) kept.pop()
  return kept
}

const droveCodexHooks = (shim: string): Record<string, HookGroup> => {
  const handler = (event: string): HookHandler => ({ type: 'command', command: `${shellQuote(shim)} ${event}`, timeout: HOOK_TIMEOUT_S })
  return {
    PreToolUse: { matcher: CODEX_GUARDED_TOOLS, hooks: [handler('pre-tool-use')] },
    SessionStart: { hooks: [handler('session-start')] },
    UserPromptSubmit: { hooks: [handler('user-prompt-submit')] },
    Stop: { hooks: [handler('stop')] },
    PermissionRequest: { hooks: [handler('permission-request')] },
  }
}

const handlersOf = (group: unknown): HookHandler[] => {
  const hooks = (group as HookGroup | null)?.hooks
  return Array.isArray(hooks) ? hooks : []
}

// The Drove-owned CODEX_HOME holds what the typed line used to carry. hooks.json keeps the user's groups first, at the
// indices their trust is keyed by, so the user's own trust decisions carry over re-keyed to this file; Drove's groups
// follow, pre-trusted with Codex's fingerprint. Both files are rewritten on every launch.
const codexHomeContents = (request: CodexLaunchRequest, home: CodexHome, shim: string, envNames: readonly string[]): { files: LaunchFile[]; links: LaunchLink[] } => {
  const sections = tomlSections(home.userConfig)
  const userTrust = userHookTrust(sections)
  const hooks: Record<string, unknown[]> = Object.fromEntries(Object.entries(home.userHooks).map(([event, groups]) => [event, [...groups]]))
  for (const [event, group] of Object.entries(droveCodexHooks(shim))) hooks[event] = [...(hooks[event] ?? []), group]
  const hooksPath = join(home.dir, 'hooks.json')
  const trust: [string, HookTrust][] = []
  for (const [event, groups] of Object.entries(hooks)) {
    const label = HOOK_LABELS[event]
    if (!label) continue
    const userCount = home.userHooks[event]?.length ?? 0
    groups.forEach((group, groupIndex) => {
      handlersOf(group).forEach((handler, handlerIndex) => {
        const position = `${label}:${groupIndex}:${handlerIndex}`
        const state = groupIndex < userCount ? userTrust.get(`${join(home.user, 'hooks.json')}:${position}`) : { hash: codexHookHash(event, group as HookGroup, handler) }
        if (state?.hash || state?.enabled !== undefined) trust.push([`${hooksPath}:${position}`, state])
      })
    })
  }
  const rootKeys = (sections[0]?.body ?? []).filter(line => USER_ROOT_KEY.test(line)).map(line => line.trim())
  const userMcp = sections.filter(section => {
    const name = MCP_HEADER.exec(section.header)?.[1]
    return name !== undefined && unquoteKey(name) !== 'drove'
  })
  const config = [
    "# Written by Drove on every Codex worker launch in this run (DROVE-34). Edits here, Codex's included, are overwritten.",
    ...rootKeys,
    'check_for_update_on_startup = false',
    '',
    `[projects.${tomlString(request.repo)}]`,
    'trust_level = "trusted"',
    '',
    '[mcp_servers.drove]',
    'command = "node"',
    `args = ${tomlArray([request.droveEntry, 'mcp'])}`,
    `env_vars = ${tomlArray(envNames)}`,
    'default_tools_approval_mode = "approve"',
    '',
    ...userMcp.flatMap(section => [section.header, ...trimBlank(section.body), '']),
    ...trust.flatMap(([key, state]) => [
      `[hooks.state.${tomlString(key)}]`,
      ...(state.hash ? [`trusted_hash = ${tomlString(state.hash)}`] : []),
      ...(state.enabled !== undefined ? [`enabled = ${state.enabled}`] : []),
      '',
    ]),
  ]
  return {
    files: [
      { path: join(home.dir, 'config.toml'), content: `${trimBlank(config).join('\n')}\n`, mode: 0o600 },
      { path: hooksPath, content: `${JSON.stringify({ hooks }, null, 2)}\n`, mode: 0o600 },
    ],
    links: [
      ...home.links.map(name => ({ path: join(home.dir, name), target: join(home.user, name) })),
      ...home.skills.map(name => ({ path: join(home.dir, 'skills', name), target: join(home.user, 'skills', name) })),
    ],
  }
}

export const CODEX_HOME_LINKS = ['auth.json', 'AGENTS.md', 'AGENTS.override.md'] as const

const parseUserHooks = (text: string): Record<string, unknown[]> => {
  try {
    const hooks = (JSON.parse(text) as { hooks?: unknown }).hooks
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return {}
    return Object.fromEntries(Object.entries(hooks).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1])))
  } catch {
    return {}
  }
}

// Reads only. Codex canonicalises CODEX_HOME and keys hook trust by absolute file path, so both homes are resolved.
export const readCodexHome = async (dir: string, user: string): Promise<CodexHome> => {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const userDir = await realpath(user).catch(() => user)
  const read = (name: string): Promise<string> => readFile(join(userDir, name), 'utf8').catch(() => '')
  const exists = (name: string): Promise<boolean> => lstat(join(userDir, name)).then(() => true, () => false)
  const present = await Promise.all(CODEX_HOME_LINKS.map(async name => ((await exists(name)) ? name : undefined)))
  return {
    dir: await realpath(dir),
    user: userDir,
    userConfig: await read('config.toml'),
    userHooks: parseUserHooks(await read('hooks.json')),
    links: present.filter((name): name is (typeof CODEX_HOME_LINKS)[number] => name !== undefined),
    skills: (await readdir(join(userDir, 'skills')).catch(() => [] as string[])).filter(name => !name.startsWith('.')).sort(),
  }
}

const codexSpec = (request: CodexLaunchRequest): LaunchSpec => {
  const { identity, codexHome } = request
  const isWorker = identity.role === 'worker'
  const isBypass = isWorker && request.bypassSandbox !== false
  const env = identityEnv(identity)
  const shim = guardShim(identity, request.droveEntry)
  const writableRoots = isWorker ? [`${request.repo}/.git`] : [`${request.repo}/.git`, `${identity.home}/runs/${identity.run}`]
  const homeOverrides = [
    `model_reasoning_effort=${tomlString(request.effort)}`,
    ...(isBypass ? [] : [CODEX_NETWORK_FLAG]),
    ...(request.roleText ? [`developer_instructions=${tomlString(request.roleText)}`] : []),
  ]
  const inlineOverrides = [
    `model_reasoning_effort=${tomlString(request.effort)}`,
    ...(isWorker ? ['check_for_update_on_startup=false'] : []),
    ...(isBypass ? [] : [CODEX_NETWORK_FLAG]),
    ...(isWorker ? [`projects.${tomlString(request.cwd)}.trust_level="trusted"`] : []),
    `mcp_servers.drove={command="node",args=${compactTomlArray([request.droveEntry, 'mcp'])},env_vars=${compactTomlArray(Object.keys(env))},default_tools_approval_mode="approve"}`,
    ...(request.roleText ? [`developer_instructions=${tomlString(request.roleText)}`] : []),
    `hooks.PreToolUse=${codexHook(shim.path, 'pre-tool-use', CODEX_GUARDED_TOOLS)}`,
    `hooks.SessionStart=${codexHook(shim.path, 'session-start')}`,
    `hooks.UserPromptSubmit=${codexHook(shim.path, 'user-prompt-submit')}`,
    `hooks.Stop=${codexHook(shim.path, 'stop')}`,
    `hooks.PermissionRequest=${codexHook(shim.path, 'permission-request')}`,
  ]
  const overrides = codexHome ? homeOverrides : inlineOverrides
  const argv = [
    ...(request.resumeId ? ['resume', request.resumeId] : []),
    ...(isBypass ? [CODEX_BYPASS_FLAG] : ['-s', 'workspace-write']),
    '-C', request.cwd,
    ...(isBypass ? [] : writableRoots.flatMap(dir => ['--add-dir', dir])),
    ...(request.model ? ['-m', request.model] : []),
    ...overrides.flatMap(override => ['-c', override]),
    ...(request.bypassHookTrust ? ['--dangerously-bypass-hook-trust'] : []),
    ...(request.initialPrompt ? [request.initialPrompt] : []),
  ]
  assertShellSafeArgs(isWorker || !request.initialPrompt ? argv : argv.slice(0, -1))
  const home = codexHome ? codexHomeContents(request, codexHome, shim.path, Object.keys(env)) : undefined
  return {
    kind: 'codex',
    role: identity.role,
    cwd: request.cwd,
    env: { ...(isWorker ? request.workerEnv : {}), ...env, DROVE_AGENT: 'codex', ...(codexHome ? { CODEX_HOME: codexHome.dir } : {}) },
    argv,
    files: [shim, ...(home?.files ?? [])],
    ...(home ? { links: home.links } : {}),
  }
}

const requireRole = <T extends LaunchRequest>(request: T, role: Role): T => {
  if (request.identity.role !== role) throw new Error(`launch spec for ${role} was asked with identity role ${request.identity.role}`)
  return request
}

export const claudeWorkerSpec = (request: LaunchRequest): LaunchSpec => claudeSpec(requireRole(request, 'worker'))
export const codexWorkerSpec = (request: CodexLaunchRequest): LaunchSpec => codexSpec(requireRole(request, 'worker'))
export const claudePlannerSpec = (request: LaunchRequest): LaunchSpec => claudeSpec(requireRole(request, 'planner'))
export const codexPlannerSpec = (request: CodexLaunchRequest): LaunchSpec => codexSpec(requireRole(request, 'planner'))

export const specFor = (request: CodexLaunchRequest): LaunchSpec => {
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

// A link replaces only a missing path or an older symlink: a real file there (a login made inside the Drove home, say)
// is never overwritten.
const placeLink = async (link: LaunchLink): Promise<void> => {
  await mkdir(dirname(link.path), { recursive: true, mode: 0o700 })
  const current = await lstat(link.path).catch(() => undefined)
  if (current && !current.isSymbolicLink()) return
  if (current && (await readlink(link.path)) === link.target) return
  if (current) await unlink(link.path).catch(() => undefined)
  await symlink(link.target, link.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
}

// Written by rename, because a running Codex may read its config.toml while another seat's launch rewrites it.
export const writeLaunchFiles = async (spec: LaunchSpec): Promise<void> => {
  for (const file of spec.files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 })
    const temporary = `${file.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, file.content, { mode: file.mode })
    await chmod(temporary, file.mode)
    await rename(temporary, file.path)
  }
  for (const link of spec.links ?? []) await placeLink(link)
}

export const execArgv = (spec: LaunchSpec): string[] => [spec.kind, ...spec.argv]
