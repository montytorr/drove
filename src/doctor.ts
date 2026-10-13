import { cairnEnv, cairnKeyHint } from './cairn.ts'
import { access, constants, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toplevel } from './git.ts'
import { loadPolicy } from './policy.ts'
import { probeServer } from './herdr.ts'
import { detectAgents, nodeAgentDeps } from './agents.ts'
import { DROVE_PLUGIN, expandHome, pluginDirEntries, pluginNameOfDir, userClaudeDir } from './launch.ts'
import { userCodexHome } from './paths.ts'
import type { AgentKind, Exec, ExecResult } from './types.ts'

export type CheckStatus = 'ok' | 'warn' | 'fail'
export type Check = { id: string; status: CheckStatus; detail: string; fix?: string }
export type DoctorReport = { ok: boolean; checks: Check[] }

export const NODE_MIN = '22.18.0'
// The Claude Code version Drove was verified against, not a bisected minimum. The launch flags in src/launch.ts
// (--no-chrome, --setting-sources, --settings) all exist in it. Raise it when a flag needs a newer one.
export const CLAUDE_MIN = '2.1.296'

export type DoctorDeps = {
  exec: Exec
  cwd: string
  home: string
  claudeSettings: string
  nodeVersion: string
  isWritable: (path: string) => Promise<boolean>
  readText: (path: string) => Promise<string | undefined>
  // The user's home (Claude expands ~ in a plugin dir against it), this clone's mod dir, and the process's own
  // CLAUDE_CODE_PLUGIN_DIRS.
  userHome: string
  modDir: string
  envPluginDirs?: string
  realpath: (path: string) => Promise<string>
}

// This clone's mod: the mod/ beside src/.
export const CLONE_MOD_DIR = fileURLToPath(new URL('../mod', import.meta.url))

const TIMEOUT_MS = 10_000

const versionOf = (text: string): string | undefined => /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0]

export const atLeast = (version: string, minimum: string): boolean => {
  const have = version.split('.').map(Number)
  const need = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const [a = 0, b = 0] = [have[i], need[i]]
    if (a !== b) return a > b
  }
  return true
}

const attempt = async (exec: Exec, argv: readonly string[], cwd?: string): Promise<ExecResult> => {
  try {
    return await exec(argv, { timeoutMs: TIMEOUT_MS, ...(cwd === undefined ? {} : { cwd }) })
  } catch (error) {
    return { code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

const firstLine = (result: ExecResult): string =>
  (result.stdout.trim() || result.stderr.trim()).split('\n')[0]?.trim().slice(0, 160) ?? ''

const check = (id: string, status: CheckStatus, detail: string, fix?: string): Check => ({ id, status, detail, ...(fix === undefined ? {} : { fix }) })

const checkNode = (deps: DoctorDeps): Check => {
  const version = versionOf(deps.nodeVersion) ?? deps.nodeVersion
  return atLeast(version, NODE_MIN)
    ? check('node', 'ok', `node ${version}`)
    : check('node', 'fail', `node ${version} is older than ${NODE_MIN}`, `install Node ${NODE_MIN} or newer (nvm install 22) and put it first on PATH`)
}

const checkGit = async (deps: DoctorDeps): Promise<Check[]> => {
  const version = await attempt(deps.exec, ['git', '--version'])
  if (version.code !== 0) return [check('git', 'fail', 'git is not installed', 'install git and put it on PATH')]
  const inside = await attempt(deps.exec, ['git', 'rev-parse', '--is-inside-work-tree'], deps.cwd)
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return [check('git', 'ok', firstLine(version)), check('repo', 'warn', `${deps.cwd} is not a git repository`, 'run drove from the root of the repo the run is for (drove init <dir> makes one)')]
  }
  const remotes = await attempt(deps.exec, ['git', 'remote'], deps.cwd)
  const names = remotes.stdout.split('\n').map(name => name.trim()).filter(Boolean)
  return [
    check('git', 'ok', firstLine(version)),
    names.length > 0
      ? check('repo', 'ok', `git repository with remote ${names.join(', ')}`)
      : check('repo', 'warn', 'git repository with no remote', 'git remote add origin <url>; drove merge --pr and a Claude worktree base need one'),
  ]
}

const checkHerdr = async (deps: DoctorDeps): Promise<Check[]> => {
  const version = await attempt(deps.exec, ['herdr', '--version'])
  if (version.code !== 0) return [check('herdr', 'fail', 'herdr is not installed', 'install herdr 0.9 or newer and put it on PATH')]
  const probe = await probeServer(deps.exec)
  return [
    check('herdr', 'ok', firstLine(version)),
    probe.ok
      ? check('herdr-server', 'ok', 'herdr server reachable')
      : check('herdr-server', 'fail', `herdr server not reachable: ${probe.output.replace(/\s+/g, ' ').trim().slice(0, 120)}`, 'start herdr in a terminal or under a service (Drove never starts it); HERDR_SOCKET_PATH names a non-default socket'),
  ]
}

const checkAgents = async (deps: DoctorDeps): Promise<{ checks: Check[]; kind?: AgentKind }> => {
  const onPath = new Set<string>()
  const exec: Exec = async (argv, options) => {
    const result = await deps.exec(argv, options)
    if (result.code === 0 && argv[0]) onPath.add(argv[0])
    return result
  }
  const { claude, codex } = await detectAgents({ ...nodeAgentDeps(exec, userCodexHome(deps.home)), readText: deps.readText })
  const hasClaude = claude !== undefined
  const hasCodex = codex !== undefined
  const checks: Check[] = []
  if (hasClaude) {
    const version = claude.version
    checks.push(
      version !== undefined && atLeast(version, CLAUDE_MIN)
        ? check('claude', 'ok', `claude ${version}`)
        : check('claude', 'fail', `claude ${version} is older than ${CLAUDE_MIN} (Drove's launch flags need it)`, 'update Claude Code (claude update)'),
    )
  } else if (onPath.has('claude')) {
    checks.push(check('claude', 'fail', 'claude is on PATH but its version could not be read', 'run claude --version; update Claude Code if needed (claude update)'))
  } else {
    checks.push(hasCodex ? check('claude', 'warn', 'claude is not on PATH (Claude workers and a Claude planner are unavailable)', 'install Claude Code, or run Codex only') : check('claude', 'fail', 'claude is not on PATH and neither is codex', 'install Claude Code or Codex and sign in'))
  }
  if (hasCodex) checks.push(check('codex', 'ok', `codex-cli ${codex.version}${codex.model ? ` · ${codex.model}` : ''}${codex.effort ? ` · ${codex.effort} effort` : ''}`))
  else if (onPath.has('codex')) checks.push(check('codex', hasClaude ? 'warn' : 'fail', 'codex is on PATH but its version could not be read', 'run codex --version; update Codex if needed'))
  else checks.push(hasClaude ? check('codex', 'warn', 'codex is not on PATH (Codex workers are unavailable)', 'install Codex if you want Codex seats') : check('codex', 'fail', 'codex is not on PATH and neither is claude', 'install Claude Code or Codex and sign in'))
  return { checks, kind: hasClaude ? 'claude' : hasCodex ? 'codex' : undefined }
}

const checkGh = async (deps: DoctorDeps): Promise<Check> => {
  const version = await attempt(deps.exec, ['gh', '--version'])
  if (version.code !== 0) return check('gh', 'warn', 'gh is not installed (drove merge --pr needs it)', 'install the GitHub CLI and run gh auth login')
  const auth = await attempt(deps.exec, ['gh', 'auth', 'status'])
  return auth.code === 0
    ? check('gh', 'ok', `${firstLine(version)}, signed in`)
    : check('gh', 'warn', 'gh is installed but not signed in', 'run gh auth login (the human does this; Drove never signs in)')
}

const checkCairn = async (deps: DoctorDeps, kind?: AgentKind): Promise<Check> => {
  const exec: Exec = (argv, options) => deps.exec(argv, { ...options, env: cairnEnv(kind) })
  const version = await attempt(exec, ['cairn', '--version'])
  if (version.code !== 0) return check('cairn', 'fail', 'cairn is not installed', 'install the Cairn CLI: cairn setup --url <instance> (see "Running Drove on another machine")')
  const read = await attempt(exec, ['cairn', 'projects'])
  return read.code === 0
    ? check('cairn', 'ok', `${firstLine(version)}, read works`)
    : check('cairn', 'fail', `cairn is installed but a read failed: ${firstLine(read)}${cairnKeyHint(`${read.stderr}\n${read.stdout}`)}`, 'sign in: cairn setup --url <instance>; or set CAIRN_BASE_URL and CAIRN_API_KEY')
}

const checkHome = async (deps: DoctorDeps): Promise<Check> => {
  // The nearest folder that exists decides: Drove creates the rest.
  let dir = deps.home
  for (let i = 0; i < 64; i += 1) {
    if (await deps.isWritable(dir)) return check('drove-home', 'ok', `${deps.home} is writable`)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return check('drove-home', 'fail', `${deps.home} is not writable`, 'point DROVE_HOME at a folder this user can write')
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {})

const parseSettings = (raw: string | undefined): Record<string, unknown> => {
  try {
    return record(JSON.parse(raw ?? '{}'))
  } catch {
    return {}
  }
}

// Installed means a CLAUDE_CODE_PLUGIN_DIRS entry, in the settings env or the process env, resolves to this clone's mod.
const checkModInstalled = async (deps: DoctorDeps): Promise<Check> => {
  const settingsEntries = pluginDirEntries(record(parseSettings(await deps.readText(deps.claudeSettings)).env).CLAUDE_CODE_PLUGIN_DIRS) ?? []
  const entries = [
    ...settingsEntries.map(entry => ({ entry, from: deps.claudeSettings })),
    ...(pluginDirEntries(deps.envPluginDirs) ?? []).map(entry => ({ entry, from: 'the process env' })),
  ]
  const mine = await deps.realpath(deps.modDir)
  for (const { entry, from } of entries) {
    if (await deps.realpath(expandHome(entry, deps.userHome)) === mine) return check('mod', 'ok', `the Claude mod loads from ${entry} (CLAUDE_CODE_PLUGIN_DIRS in ${from})`)
  }
  const named = await Promise.all(entries.map(async item => ({ ...item, name: await pluginNameOfDir(expandHome(item.entry, deps.userHome), deps.readText) })))
  const other = named.find(item => item.name === DROVE_PLUGIN)
  return other
    ? check('mod', 'warn', `the Claude mod loads from another clone: ${other.entry} (CLAUDE_CODE_PLUGIN_DIRS in ${other.from}), not ${deps.modDir}`, 'run drove setup mod from this clone to point it here')
    : check('mod', 'warn', `the Claude mod is not installed: no CLAUDE_CODE_PLUGIN_DIRS entry is ${deps.modDir}`, 'run drove setup mod')
}

// The mod keeps its settings in Claude Code's user settings, under the plugin's key. Not installed is not a problem.
const checkModNode = async (deps: DoctorDeps): Promise<Check | undefined> => {
  const raw = await deps.readText(deps.claudeSettings)
  if (raw === undefined) return undefined
  const unread = check('mod-node', 'warn', "nodePath not checked (could not read the mod's options)", `fix or remove ${deps.claudeSettings}, then run drove doctor again`)
  let settings: unknown
  try {
    settings = JSON.parse(raw)
  } catch {
    return unread
  }
  const enabled = record(record(settings).enabledPlugins)
  const configs = record(record(settings).pluginConfigs)
  const name = Object.keys({ ...enabled, ...configs }).find(key => key.startsWith('orchestrator@'))
  if (name === undefined) return undefined
  const configured = record(record(configs[name]).options).nodePath
  const nodePath = typeof configured === 'string' && configured !== '' ? configured : 'node'
  const result = await attempt(deps.exec, [nodePath, '--version'])
  const version = result.code === 0 ? versionOf(result.stdout) : undefined
  if (version === undefined) return check('mod-node', 'fail', `the mod's node (${nodePath}) does not run`, "set the mod's nodePath to a Node 22.18 or newer, or put one on PATH")
  return atLeast(version, NODE_MIN)
    ? check('mod-node', 'ok', `the mod's node (${nodePath}) is ${version}`)
    : check('mod-node', 'fail', `the mod's node (${nodePath}) is ${version}, older than ${NODE_MIN}`, "set the mod's nodePath to a Node 22.18 or newer")
}

export const runDoctor = async (deps: DoctorDeps): Promise<DoctorReport> => {
  const agentChecks = checkAgents(deps)
  const [git, herdr, agents, gh, cairn, home, mod, modNode] = await Promise.all([
    checkGit(deps), checkHerdr(deps), agentChecks, checkGh(deps), agentChecks.then(({ kind }) => checkCairn(deps, kind)), checkHome(deps), checkModInstalled(deps), checkModNode(deps),
  ])
  const root = await toplevel(deps.exec, deps.cwd) ?? deps.cwd
  const policy = await loadPolicy(deps.home, root, deps.readText)
  const checks = [check('spawn-policy', policy.errors.length ? 'fail' : 'ok', policy.errors.length ? policy.errors.join('; ') : 'spawn policy valid'), checkNode(deps), ...git, ...herdr, ...agents.checks, gh, cairn, home, mod, ...(modNode ? [modNode] : [])]
  return { ok: checks.every(item => item.status !== 'fail'), checks }
}

export const formatReport = (report: DoctorReport): string => {
  const width = Math.max(...report.checks.map(item => item.id.length))
  const lines = report.checks.flatMap(item => [
    `${item.status.padEnd(4)}  ${item.id.padEnd(width)}  ${item.detail}`,
    ...(item.fix !== undefined && item.status !== 'ok' ? [`${' '.repeat(6 + width)}fix: ${item.fix}`] : []),
  ])
  const failed = report.checks.filter(item => item.status === 'fail').length
  const warned = report.checks.filter(item => item.status === 'warn').length
  return [...lines, '', failed > 0 ? `${failed} failed, ${warned} warning${warned === 1 ? '' : 's'}` : warned > 0 ? `ready, ${warned} warning${warned === 1 ? '' : 's'}` : 'ready'].join('\n')
}

export const nodeDoctorDeps = (exec: Exec, home: string, cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): DoctorDeps => ({
  exec,
  cwd,
  home,
  claudeSettings: join(userClaudeDir(env), 'settings.json'),
  nodeVersion: process.version,
  userHome: homedir(),
  modDir: CLONE_MOD_DIR,
  ...(env.CLAUDE_CODE_PLUGIN_DIRS === undefined ? {} : { envPluginDirs: env.CLAUDE_CODE_PLUGIN_DIRS }),
  realpath: async path => {
    try {
      return await realpath(path)
    } catch {
      return resolve(path)
    }
  },
  isWritable: async path => {
    try {
      await access(path, constants.W_OK)
      return true
    } catch {
      return false
    }
  },
  readText: async path => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  },
})
