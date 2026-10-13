import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { ENV, identityEnv, plannerDir, seatDir } from './paths.ts'
import type { Identity, LaunchFile, LaunchLink, LaunchRequest, LaunchSpec, Role, UserPlugins } from './types.ts'

export const CLAUDE_GUARDED_TOOLS = 'Bash|Edit|Write|MultiEdit|NotebookEdit'
export const CODEX_GUARDED_TOOLS = 'Bash|shell|exec_command|apply_patch'

const HOOK_TIMEOUT_S = 10
const REDACTED = '<redacted>'
const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox'
const CODEX_NETWORK_FLAG = 'sandbox_workspace_write.network_access=true'
const CHANNEL_FLAG = '--dangerously-load-development-channels'
export const CHROME_SERVER = 'claude-in-chrome'

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

const claudeHook = (droveEntry: string, event: string) => ({ type: 'command', command: hookCommand(droveEntry, event), timeout: HOOK_TIMEOUT_S })

// The mod Drove ships is plugin "orchestrator" (mod/.claude-plugin/plugin.json); a plugin allowlist never turns it off.
export const DROVE_PLUGIN = 'orchestrator'
const INLINE_MARKETPLACE = 'inline'
const CLAUDE_MD_FILES = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'] as const

export type ClaudeSettingsOptions = {
  plugins?: { allow: readonly string[]; user: UserPlugins }
  skills?: { allow: readonly string[]; user: readonly string[] }
  agents?: { allow: readonly string[]; user: readonly string[] }
  claudeMdExcludes?: readonly string[]
  // The user's settings.json minus its hooks, carried when the user setting source is dropped (workerUserHooks: false).
  userSettings?: Record<string, unknown>
}

const pluginNameOf = (key: string): string => key.split('@')[0] ?? key

// An allowlist entry names a plugin with or without its marketplace: "context7" or "context7@claude-plugins-official".
const isPluginAllowed = (allow: readonly string[], key: string): boolean =>
  pluginNameOf(key) === DROVE_PLUGIN || allow.some(item => item === key || item === pluginNameOf(key))

// Allowlist entries that match nothing the user enabled, so the seat runs without them (a typo, or a plugin not installed).
export const unknownPlugins = (allow: readonly string[], user: UserPlugins): string[] =>
  allow.filter(item => item !== DROVE_PLUGIN && ![...user.enabled, ...(user.dirs ?? []).map(dir => `${dir.name}@${INLINE_MARKETPLACE}`)].some(key => key === item || pluginNameOf(key) === item))

// Turns off what the user enabled and the list leaves out, for this session only: enabledPlugins false for marketplace
// plugins, and CLAUDE_CODE_PLUGIN_DIRS cut to the allowed mod dirs. Probed on Claude Code 2.1.296: both override the
// user's settings.json when they come from --settings.
const pluginSettings = ({ allow, user }: { allow: readonly string[]; user: UserPlugins }): Record<string, unknown> => {
  const disabled = user.enabled.filter(key => !isPluginAllowed(allow, key))
  const dirs = user.dirs?.filter(dir => isPluginAllowed(allow, `${dir.name}@${INLINE_MARKETPLACE}`))
  return {
    ...(disabled.length > 0 ? { enabledPlugins: Object.fromEntries(disabled.map(key => [key, false])) } : {}),
    ...(dirs ? { env: { CLAUDE_CODE_PLUGIN_DIRS: dirs.map(dir => dir.entry).join(delimiter) } } : {}),
  }
}

// A list entry names a skill or agent whole, or without the prefix its source gives it ("docx" for "anthropic-skills:docx").
const isNameListed = (allow: readonly string[], name: string): boolean => allow.some(item => item === name || name.endsWith(`:${item}`))

const recordOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

// workerSkills (DROVE-98): the user's own skills and commands, and the claude.ai ones synced into ~/.claude/skills/synced,
// that the list leaves out get skillOverrides "off". Probed on Claude Code 2.1.296: exact names only, no wildcard, and
// it does not reach plugin skills (workerPlugins) or the bundled ones (switching those off made the prompt larger).
const skillOverrides = ({ allow, user }: { allow: readonly string[]; user: readonly string[] }): Record<string, string> =>
  Object.fromEntries(user.filter(name => !isNameListed(allow, name)).map(name => [name, 'off']))

// workerAgents (DROVE-98): a permissions.deny rule Agent(<name>) takes that agent out of the Agent tool's list.
const agentDenies = ({ allow, user }: { allow: readonly string[]; user: readonly string[] }): string[] =>
  user.filter(name => !isNameListed(allow, name)).map(name => `Agent(${name})`)

export const claudeSettings = (droveEntry: string, _role: Role, options: ClaudeSettingsOptions = {}): Record<string, unknown> => {
  const carried = Object.fromEntries(Object.entries(options.userSettings ?? {}).filter(([key]) => key !== 'hooks'))
  const plugin = options.plugins ? pluginSettings(options.plugins) : {}
  const enabledPlugins = { ...recordOf(carried.enabledPlugins), ...recordOf(plugin.enabledPlugins) }
  const env = { ...recordOf(carried.env), ...recordOf(plugin.env) }
  const excludes = [...listOf(carried.claudeMdExcludes), ...(options.claudeMdExcludes ?? [])]
  const offs = { ...recordOf(carried.skillOverrides), ...(options.skills ? skillOverrides(options.skills) : {}) }
  const deny = [...listOf(recordOf(carried.permissions).deny), ...(options.agents ? agentDenies(options.agents) : [])]
  return {
    ...carried,
    hooks: {
      PreToolUse: [{ matcher: CLAUDE_GUARDED_TOOLS, hooks: [claudeHook(droveEntry, 'pre-tool-use')] }],
      SessionStart: [{ hooks: [claudeHook(droveEntry, 'session-start')] }],
      UserPromptSubmit: [{ hooks: [claudeHook(droveEntry, 'user-prompt-submit')] }],
      Stop: [{ hooks: [claudeHook(droveEntry, 'stop')] }],
      StopFailure: [{ hooks: [claudeHook(droveEntry, 'stop-failure')] }],
      Notification: [{ hooks: [claudeHook(droveEntry, 'notification')] }],
    },
    ...(Object.keys(enabledPlugins).length > 0 ? { enabledPlugins } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(excludes.length > 0 ? { claudeMdExcludes: excludes } : {}),
    ...(Object.keys(offs).length > 0 ? { skillOverrides: offs } : {}),
    ...(deny.length > 0 ? { permissions: { ...recordOf(carried.permissions), deny } } : {}),
  }
}

const dirsAbove = (dir: string): string[] => {
  const parent = dirname(dir)
  return parent === dir ? [dir] : [dir, ...dirsAbove(parent)]
}

const isWithin = (dir: string, root: string): boolean => dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`)

// What "the user's memory" means for a worker (DROVE-88): the user's own CLAUDE.md, and every CLAUDE.md, CLAUDE.local.md
// and .claude/CLAUDE.md in the folders above the repo root. The repo's own files, and the worktree's, stay. Probed on
// Claude Code 2.1.296: claudeMdExcludes from --settings skips ~/.claude/CLAUDE.md as well as the ancestors' files.
export const claudeMdExcludes = (claudeDir: string, repo: string, cwd: string): string[] => {
  const above = [...dirsAbove(dirname(repo)), ...dirsAbove(dirname(cwd)).filter(dir => !isWithin(dir, repo))]
  const files = [...new Set(above)].flatMap(dir => CLAUDE_MD_FILES.map(name => join(dir, name)))
  return [...new Set([join(claudeDir, 'CLAUDE.md'), ...files])]
}

export const claudeMcpConfig = (droveEntry: string, env: Record<string, string> = {}, user: Record<string, unknown> = {}): Record<string, unknown> => ({
  mcpServers: { ...user, drove: { command: 'node', args: [droveEntry, 'mcp'], ...(Object.keys(env).length > 0 ? { env } : {}) } },
})

// An allowlist (DROVE-72) turns on --strict-mcp-config: the seat loads Drove's server and the named user servers only.
// Without one the seat loads the user's whole MCP setup, as before.
// A worker that drops the user setting source (workerUserHooks: false) no longer gets the user-scope servers from
// Claude, so without an allowlist they are handed over here, all of them.
const allowedMcp = (request: LaunchRequest): Record<string, unknown> => {
  const names = request.mcpAllow ?? (request.userHooks === false ? Object.keys(request.userMcp ?? {}) : [])
  return Object.fromEntries(names.filter(name => name !== 'drove' && request.userMcp?.[name] !== undefined).map(name => [name, request.userMcp?.[name]]))
}

export const userClaudeConfig = (env: NodeJS.ProcessEnv = process.env): string => join(env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')

// Where Claude keeps the user's settings.json and CLAUDE.md: CLAUDE_CONFIG_DIR, or ~/.claude.
export const userClaudeDir = (env: NodeJS.ProcessEnv = process.env): string => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

const serversOf = (value: unknown): Record<string, unknown> => {
  const servers = (value as { mcpServers?: unknown } | null)?.mcpServers
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? (servers as Record<string, unknown>) : {}
}

const readJsonFile = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

// Reads only: the user's MCP servers as Claude would merge them for this repo, local over project over user scope.
export const readClaudeMcp = async (configPath: string, repo: string): Promise<Record<string, unknown>> => {
  const config = await readJsonFile(configPath)
  const projects = (config as { projects?: Record<string, unknown> } | undefined)?.projects
  return { ...serversOf(config), ...serversOf(await readJsonFile(join(repo, '.mcp.json'))), ...serversOf(projects?.[repo]) }
}

// Claude expands a leading ~ in a CLAUDE_CODE_PLUGIN_DIRS entry to the user's home.
export const expandHome = (path: string, home: string = homedir()): string => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path)

const readTextFile = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

// The plugin name a mod dir holds: its .claude-plugin/plugin.json name, else the dir's basename.
export const pluginNameOfDir = async (dir: string, readText: (path: string) => Promise<string | undefined> = readTextFile): Promise<string> => {
  let manifest: unknown
  try {
    manifest = JSON.parse((await readText(join(dir, '.claude-plugin', 'plugin.json'))) ?? 'null')
  } catch {
    manifest = undefined
  }
  const name = recordOf(manifest).name
  return typeof name === 'string' && name.trim() ? name.trim() : basename(dir)
}

// The entries of a CLAUDE_CODE_PLUGIN_DIRS value, as Claude splits it; undefined when it is not a string.
export const pluginDirEntries = (raw: unknown): string[] | undefined =>
  typeof raw === 'string' ? raw.split(delimiter).map(entry => entry.trim()).filter(Boolean) : undefined

// Reads only: the plugins the user enabled, and the mod dirs they load through env.CLAUDE_CODE_PLUGIN_DIRS, each with
// the plugin name from its .claude-plugin/plugin.json (the dir's basename when it has none).
export const readClaudePlugins = async (settingsPath: string): Promise<UserPlugins> => {
  const settings = recordOf(await readJsonFile(settingsPath))
  const enabled = Object.entries(recordOf(settings.enabledPlugins)).filter(([, on]) => on === true).map(([key]) => key)
  const raw = recordOf(settings.env).CLAUDE_CODE_PLUGIN_DIRS
  const entries = pluginDirEntries(raw)
  const dirs = entries ? await Promise.all(entries.map(async entry => ({ entry, name: await pluginNameOfDir(expandHome(entry)) }))) : undefined
  return { enabled, ...(dirs ? { dirs } : {}) }
}

// Reads only: the user's settings.json as a whole, for a worker that drops the user setting source (workerUserHooks: false).
export const readClaudeSettings = async (settingsPath: string): Promise<Record<string, unknown>> => recordOf(await readJsonFile(settingsPath))

// The prefix Claude Code gives the claude.ai skills it syncs into ~/.claude/skills/synced/<account>/<name>/ (2.1.296).
const SYNCED_SKILL_PREFIX = 'anthropic-skills'

const frontmatterName = (text: string): string | undefined => {
  const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  const name = header ? /^name:\s*(.+?)\s*$/m.exec(header)?.[1]?.replace(/^["']|["']$/g, '').trim() : undefined
  return name || undefined
}

type DirEntry = { name: string; path: string; isDir: boolean }

const entriesOf = async (dir: string): Promise<DirEntry[]> => {
  const names = await readdir(dir).catch(() => [] as string[])
  const entries = await Promise.all(names.filter(name => !name.startsWith('.')).sort().map(async (name): Promise<DirEntry | undefined> => {
    const path = join(dir, name)
    const info = await stat(path).catch(() => undefined)
    return info ? { name, path, isDir: info.isDirectory() } : undefined
  }))
  return entries.filter((entry): entry is DirEntry => entry !== undefined)
}

const markdownFiles = async (dir: string, prefix: string[] = []): Promise<{ parts: string[]; path: string }[]> => {
  const found = await Promise.all((await entriesOf(dir)).map(async entry =>
    entry.isDir ? markdownFiles(entry.path, [...prefix, entry.name]) : entry.name.endsWith('.md') ? [{ parts: [...prefix, entry.name.slice(0, -3)], path: entry.path }] : []))
  return found.flat()
}

// Reads only: the names Claude lists as skills for this user: ~/.claude/skills/<name>/SKILL.md, the synced claude.ai
// skills as anthropic-skills:<name>, and the commands in ~/.claude/commands (nested folders become folder:name).
export const readClaudeSkills = async (claudeDir: string): Promise<string[]> => {
  const skillDirs = await entriesOf(join(claudeDir, 'skills'))
  const own = await Promise.all(skillDirs.filter(entry => entry.isDir && entry.name !== 'synced').map(async entry => {
    const text = await readFile(join(entry.path, 'SKILL.md'), 'utf8').catch(() => undefined)
    return text === undefined ? [] : [frontmatterName(text) ?? entry.name]
  }))
  const accounts = await entriesOf(join(claudeDir, 'skills', 'synced'))
  const synced = await Promise.all(accounts.filter(entry => entry.isDir).map(async account =>
    (await entriesOf(account.path)).filter(entry => entry.isDir && existsSync(join(entry.path, 'SKILL.md'))).map(entry => `${SYNCED_SKILL_PREFIX}:${entry.name}`)))
  const commands = (await markdownFiles(join(claudeDir, 'commands'))).map(file => file.parts.join(':'))
  return [...new Set([...own.flat(), ...synced.flat(), ...commands])]
}

// Reads only: the names of the agent definitions in ~/.claude/agents, nested folders included.
export const readClaudeAgents = async (claudeDir: string): Promise<string[]> => {
  const files = await markdownFiles(join(claudeDir, 'agents'))
  const names = await Promise.all(files.map(async file => frontmatterName(await readFile(file.path, 'utf8').catch(() => '')) ?? file.parts.at(-1) ?? ''))
  return [...new Set(names.filter(Boolean))]
}

const jsonFile = (path: string, value: unknown): LaunchFile => ({ path, content: `${JSON.stringify(value, null, 2)}\n`, mode: 0o600 })

const dirOf = (identity: Identity): string => (identity.role === 'planner' ? plannerDir(identity.home, identity.run) : seatDir(identity.home, identity.run, identity.seat))

// The lists and switches (workerPlugins, workerSkills, workerAgents, workerUserMemory: false, workerUserHooks: false)
// shape a worker's settings; a planner is never trimmed. A worker without the user setting source has no user skills or
// agents left to switch off.
const workerSettingsOptions = (request: LaunchRequest): ClaudeSettingsOptions => ({
  ...(request.pluginAllow && request.userPlugins ? { plugins: { allow: request.pluginAllow, user: request.userPlugins } } : {}),
  ...(request.userHooks !== false && request.skillAllow && request.userSkills ? { skills: { allow: request.skillAllow, user: request.userSkills } } : {}),
  ...(request.userHooks !== false && request.agentAllow && request.userAgents ? { agents: { allow: request.agentAllow, user: request.userAgents } } : {}),
  ...(request.userHooks === false ? { userSettings: request.userSettings ?? {} } : {}),
  ...(request.userMemory === false ? { claudeMdExcludes: claudeMdExcludes(request.claudeDir ?? userClaudeDir(), request.repo, request.cwd) } : {}),
})

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
    ...(isWorker && request.mcpAllow ? ['--strict-mcp-config'] : []),
    ...(isWorker && request.mcpAllow && !request.mcpAllow.includes(CHROME_SERVER) ? ['--no-chrome'] : []),
    ...(isWorker && request.skillAllow?.length === 0 ? ['--disable-slash-commands'] : []),
    ...(isWorker && request.userHooks === false ? ['--setting-sources', 'project,local'] : []),
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
      jsonFile(mcpPath, claudeMcpConfig(request.droveEntry, identityEnv(identity), isWorker ? allowedMcp(request) : {})),
      jsonFile(settingsPath, claudeSettings(request.droveEntry, identity.role, isWorker ? workerSettingsOptions(request) : {})),
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
  linkedSkills?: string[]
}

// homeMcpAllow and skillAllow are the run's lists (workerMcp, workerSkills) and shape the shared home; a seat's own
// mcpAllow differs from the home's only through -c mcp_servers.<name>.enabled overrides on its launch line.
export type CodexLaunchRequest = LaunchRequest & { bypassSandbox?: boolean; codexHome?: CodexHome; homeMcpAllow?: string[] }

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
const MCP_TABLE = new RegExp(String.raw`^\[\s*mcp_servers\s*\.\s*(${TOML_KEY})\s*\]`)
const ENABLED_KEY = /^\s*enabled\s*=\s*(true|false)\b/
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

type UserMcp = { name: string; isUserDisabled: boolean }

const userMcpServers = (sections: readonly TomlSection[]): UserMcp[] =>
  sections.flatMap(section => {
    const key = MCP_TABLE.exec(section.header)?.[1]
    const name = key === undefined ? undefined : unquoteKey(key)
    if (name === undefined || name === 'drove') return []
    return [{ name, isUserDisabled: section.body.some(line => ENABLED_KEY.exec(line)?.[1] === 'false') }]
  })

export const codexMcpNames = (userConfig: string): string[] => userMcpServers(tomlSections(userConfig)).map(server => server.name)

const isAllowed = (allow: readonly string[] | undefined, server: UserMcp): boolean => !server.isUserDisabled && (allow?.includes(server.name) ?? true)

const tomlKey = (name: string): string => (/^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name))

// The overrides that turn the shared home's servers into this seat's allowlist: only where the two disagree.
const seatMcpOverrides = (request: CodexLaunchRequest, home: CodexHome): string[] =>
  userMcpServers(tomlSections(home.userConfig))
    .filter(server => isAllowed(request.homeMcpAllow, server) !== isAllowed(request.mcpAllow, server))
    .map(server => `mcp_servers.${tomlKey(server.name)}.enabled=${isAllowed(request.mcpAllow, server)}`)

const withEnabled = (section: TomlSection, isEnabled: boolean): string[] => {
  const body = trimBlank(section.body)
  if (isEnabled || !MCP_TABLE.test(section.header)) return [section.header, ...body]
  return [section.header, ...body.filter(line => !ENABLED_KEY.test(line)), 'enabled = false']
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
const codexHomeContents = (request: CodexLaunchRequest, home: CodexHome, shim: string, envNames: readonly string[]): { files: LaunchFile[]; links: LaunchLink[]; unlinks: string[] } => {
  const sections = tomlSections(home.userConfig)
  const userTrust = userHookTrust(sections)
  const userHooks = request.userHooks === false ? {} : home.userHooks
  const hooks: Record<string, unknown[]> = Object.fromEntries(Object.entries(userHooks).map(([event, groups]) => [event, [...groups]]))
  for (const [event, group] of Object.entries(droveCodexHooks(shim))) hooks[event] = [...(hooks[event] ?? []), group]
  const hooksPath = join(home.dir, 'hooks.json')
  const trust: [string, HookTrust][] = []
  for (const [event, groups] of Object.entries(hooks)) {
    const label = HOOK_LABELS[event]
    if (!label) continue
    const userCount = userHooks[event]?.length ?? 0
    groups.forEach((group, groupIndex) => {
      handlersOf(group).forEach((handler, handlerIndex) => {
        const position = `${label}:${groupIndex}:${handlerIndex}`
        const state = groupIndex < userCount ? userTrust.get(`${join(home.user, 'hooks.json')}:${position}`) : { hash: codexHookHash(event, group as HookGroup, handler) }
        if (state?.hash || state?.enabled !== undefined) trust.push([`${hooksPath}:${position}`, state])
      })
    })
  }
  const rootKeys = (sections[0]?.body ?? []).filter(line => USER_ROOT_KEY.test(line)).map(line => line.trim())
  const servers = userMcpServers(sections)
  const userMcp = sections.flatMap(section => {
    const key = MCP_HEADER.exec(section.header)?.[1]
    const server = key === undefined ? undefined : servers.find(entry => entry.name === unquoteKey(key))
    return server ? [{ section, isEnabled: isAllowed(request.homeMcpAllow, server) }] : []
  })
  const skills = home.skills.filter(name => request.skillAllow?.includes(name) ?? true)
  const links = home.links.filter(name => request.userMemory !== false || !CODEX_MEMORY_LINKS.some(memory => memory === name))
  const config = [
    "# Written by Drove on every Codex worker launch in this run (DROVE-34). Edits here, Codex's included, are overwritten.",
    ...rootKeys,
    'check_for_update_on_startup = false',
    ...(request.roleText ? [`developer_instructions = ${tomlString(request.roleText)}`] : []),
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
    ...userMcp.flatMap(({ section, isEnabled }) => [...withEnabled(section, isEnabled), '']),
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
      ...links.map(name => ({ path: join(home.dir, name), target: join(home.user, name) })),
      ...skills.map(name => ({ path: join(home.dir, 'skills', name), target: join(home.user, 'skills', name) })),
    ],
    unlinks: [
      ...(request.userMemory === false ? CODEX_MEMORY_LINKS.map(name => join(home.dir, name)) : []),
      ...(home.linkedSkills ?? []).filter(name => !skills.includes(name)).map(name => join(home.dir, 'skills', name)),
    ],
  }
}

// The user's AGENTS files are Codex's memory; workerUserMemory: false (DROVE-88) leaves them out of the shared home.
export const CODEX_MEMORY_LINKS = ['AGENTS.md', 'AGENTS.override.md'] as const
export const CODEX_HOME_LINKS = ['auth.json', ...CODEX_MEMORY_LINKS] as const

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
    linkedSkills: await linkedSkills(join(dir, 'skills')),
  }
}

const linkedSkills = async (dir: string): Promise<string[]> => {
  const names = await readdir(dir).catch(() => [] as string[])
  const linked = await Promise.all(names.map(async name => ((await lstat(join(dir, name)).catch(() => undefined))?.isSymbolicLink() ? name : undefined)))
  return linked.filter((name): name is string => name !== undefined).sort()
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
    ...(codexHome ? seatMcpOverrides(request, codexHome) : []),
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
    ...(home && home.unlinks.length > 0 ? { unlinks: home.unlinks } : {}),
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

// The launch.json record (DROVE-98) never holds the user's secrets: the values of the user's env (carried into a worker's
// settings.json when it drops the user setting source), of the user's MCP servers (env and headers), of a Codex home's
// MCP env tables and of workerEnv are masked. The real files, written 0600, keep them: Claude and Codex need them.
const maskedValues = (value: unknown): unknown =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).map(key => [key, REDACTED])) : value

const redactJson = (content: string, redact: (parsed: Record<string, unknown>) => Record<string, unknown>): string => {
  try {
    const parsed: unknown = JSON.parse(content)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? `${JSON.stringify(redact(parsed as Record<string, unknown>), null, 2)}\n` : content
  } catch {
    return content
  }
}

const redactSettings = (parsed: Record<string, unknown>): Record<string, unknown> => ('env' in parsed ? { ...parsed, env: maskedValues(parsed.env) } : parsed)

const redactMcp = (parsed: Record<string, unknown>): Record<string, unknown> => {
  const servers = recordOf(parsed.mcpServers)
  return {
    ...parsed,
    mcpServers: Object.fromEntries(Object.entries(servers).map(([name, server]) => [
      name,
      name === 'drove' ? server : { ...recordOf(server), ...('env' in recordOf(server) ? { env: maskedValues(recordOf(server).env) } : {}), ...('headers' in recordOf(server) ? { headers: maskedValues(recordOf(server).headers) } : {}) },
    ])),
  }
}

const SECRET_TABLE = /^\[[^\]]*\.(env|http_headers|env_http_headers)\s*\]\s*(#.*)?$/
const SECRET_INLINE = /^(\s*(?:env|http_headers|env_http_headers)\s*=\s*)\{.*\}\s*(#.*)?$/

const redactToml = (content: string): string => {
  let inSecretTable = false
  return content.split('\n').map(line => {
    if (/^\s*\[/.test(line)) {
      inSecretTable = SECRET_TABLE.test(line.trim())
      return line
    }
    const inline = SECRET_INLINE.exec(line)
    if (inline) return `${inline[1]}"${REDACTED}"`
    const pair = /^(\s*[^=#\s][^=]*=\s*).+$/.exec(line)
    return inSecretTable && pair ? `${pair[1]}"${REDACTED}"` : line
  }).join('\n')
}

const redactFile = (file: LaunchFile): LaunchFile => {
  if (file.path.endsWith('/settings.json')) return { ...file, content: redactJson(file.content, redactSettings) }
  if (file.path.endsWith('/mcp.json')) return { ...file, content: redactJson(file.content, redactMcp) }
  if (file.path.endsWith('/config.toml')) return { ...file, content: redactToml(file.content) }
  return file
}

const KEPT_ENV = /^(DROVE_|CODEX_HOME$|PORT$)/

// A planner has no token and carries none of the user's env, so its spec is returned as it is.
export const redactSpec = (spec: LaunchSpec): LaunchSpec => {
  const token = spec.env[ENV.token]
  if (!token) return spec
  const scrub = (text: string): string => text.replaceAll(token, REDACTED)
  return {
    ...spec,
    env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, KEPT_ENV.test(key) ? scrub(value) : REDACTED])),
    argv: spec.argv.map(scrub),
    files: spec.files.map(file => {
      const masked = redactFile(file)
      return { ...masked, content: scrub(masked.content) }
    }),
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
  for (const path of spec.unlinks ?? []) await removeLink(path)
}

// Only a symlink is removed: a skill the user copied into the Drove home by hand stays.
const removeLink = async (path: string): Promise<void> => {
  const current = await lstat(path).catch(() => undefined)
  if (current?.isSymbolicLink()) await unlink(path).catch(() => undefined)
}

export const execArgv = (spec: LaunchSpec): string[] => [spec.kind, ...spec.argv]
