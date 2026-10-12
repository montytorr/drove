import { createHash } from 'node:crypto'
import type { AgentKind, Exec, ExecResult, HerdrAgent, HerdrStatus, Seat } from './types.ts'

export type HerdrResult<T> = { ok: true; value: T } | { ok: false; code: string; output: string }

export type ReadSource = 'visible' | 'recent-unwrapped' | 'detection'

export const BUSY_RETRY_INTERVAL_MS = 500
export const DEFAULT_START_TIMEOUT_MS = 60_000
export const DEFAULT_PROMPT_TIMEOUT_MS = 8_000
const ATTEMPT_TIMEOUT_MS = 90_000

const AGENT_NAME_MAX = 32
const TAG_LENGTH = 4

const digestOf = (text: string): string => createHash('sha1').update(text).digest('hex')

// herdr agent names are unique per herdr server, not per workspace, so two runs that both have a seat `w-core`
// would reach each other's worker by the bare name. Every name Drove gives herdr carries the run's own tag.
export const runTag = (runId: string): string => /-([0-9a-f]{4})$/.exec(runId)?.[1] ?? digestOf(runId).slice(0, TAG_LENGTH)

export const agentName = (runId: string, seat: string): string => {
  const tag = runTag(runId)
  const name = `${seat}-${tag}`
  if (name.length <= AGENT_NAME_MAX) return name
  const keep = AGENT_NAME_MAX - tag.length - TAG_LENGTH - 2
  return `${seat.slice(0, keep)}-${digestOf(seat).slice(0, TAG_LENGTH)}-${tag}`
}

// A seat with a pane is addressed by the pane id, which is unique and also reaches agents started before names
// carried a run tag. Only a seat that has no pane yet can be addressed by name.
export const agentTarget = (runId: string, seat: Pick<Seat, 'name' | 'paneId'>): string => seat.paneId ?? agentName(runId, seat.name)

const envFlags = (env: Record<string, string>): string[] => Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`])

export const tabCreateArgv = (workspace: string, cwd: string, label: string, env: Record<string, string>): string[] => [
  'herdr', 'tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--no-focus', ...envFlags(env),
]

export const paneSplitArgv = (anchor: string, direction: 'right' | 'down', cwd: string, env: Record<string, string>): string[] => [
  'herdr', 'pane', 'split', '--pane', anchor, '--direction', direction, '--cwd', cwd, '--no-focus', ...envFlags(env),
]

export const agentStartArgv = (seat: string, kind: AgentKind, paneId: string, agentArgv: readonly string[], timeoutMs = DEFAULT_START_TIMEOUT_MS): string[] => [
  'herdr', 'agent', 'start', seat, '--kind', kind, '--pane', paneId, '--timeout', String(timeoutMs), '--', ...agentArgv,
]

export const agentPromptArgv = (target: string, text: string, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS): string[] => [
  'herdr', 'agent', 'prompt', target, text, '--wait', '--timeout', String(timeoutMs),
]

export const agentTypeArgv = (target: string, text: string): string[] => ['herdr', 'agent', 'prompt', target, text]

// DROVE-124: presses keys in an agent's input. Drove uses it for one key only, Enter, to submit text herdr typed but did not submit.
export const agentSendKeysArgv = (target: string, keys: readonly string[]): string[] => ['herdr', 'agent', 'send-keys', target, ...keys]

export const agentReadArgv = (target: string, lines: number, source: ReadSource = 'recent-unwrapped'): string[] => [
  'herdr', 'agent', 'read', target, '--source', source, '--lines', String(lines),
]

export const paneReadArgv = (paneId: string, lines: number, source: ReadSource = 'recent-unwrapped'): string[] => [
  'herdr', 'pane', 'read', paneId, '--source', source, '--lines', String(lines),
]

// DROVE-95: a run started with --detached gets a workspace of its own, so it needs no pane to stand beside.
export const workspaceCreateArgv = (cwd: string, label: string, env: Record<string, string>): string[] => [
  'herdr', 'workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus', ...envFlags(env),
]
export const workspaceListArgv = (): string[] => ['herdr', 'workspace', 'list']
export const workspaceCloseArgv = (workspaceId: string): string[] => ['herdr', 'workspace', 'close', workspaceId]

export const agentListArgv =(): string[] => ['herdr', 'agent', 'list']
export const agentGetArgv = (target: string): string[] => ['herdr', 'agent', 'get', target]
export const agentExplainArgv = (target: string): string[] => ['herdr', 'agent', 'explain', target, '--json']
export const paneCloseArgv = (paneId: string): string[] => ['herdr', 'pane', 'close', paneId]
export const tabCloseArgv = (tabId: string): string[] => ['herdr', 'tab', 'close', tabId]
export const tabGetArgv = (tabId: string): string[] => ['herdr', 'tab', 'get', tabId]

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text.trim().split('\n')[0] ?? '')
  } catch {
    return undefined
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)

export const herdrError = (output: string): string | undefined => {
  const parsed = asRecord(parseJson(output))
  const error = asRecord(parsed?.error)
  if (error) return typeof error.code === 'string' ? error.code : typeof error.message === 'string' ? error.message : 'error'
  if (parsed) return undefined
  const match = /"code"\s*:\s*"([a-z_]+)"/.exec(output) ?? /\b(agent_[a-z_]+|pane_[a-z_]+|invalid_[a-z_]+|timeout)\b/.exec(output)
  return match?.[1]
}

export const isPromptUnconfirmed = (output: string): boolean => herdrError(output) === 'timeout'

const STATUSES: ReadonlySet<string> = new Set<HerdrStatus>(['idle', 'working', 'blocked', 'done', 'unknown'])

export type ListedAgent = HerdrAgent & { kind?: string }

const toAgent = (raw: unknown): ListedAgent | undefined => {
  const agent = asRecord(raw)
  if (!agent || typeof agent.pane_id !== 'string') return undefined
  const status = typeof agent.agent_status === 'string' && STATUSES.has(agent.agent_status) ? (agent.agent_status as HerdrStatus) : 'unknown'
  const session = asRecord(agent.agent_session)
  const title = typeof agent.terminal_title_stripped === 'string' ? agent.terminal_title_stripped.trim() : ''
  return {
    ...(typeof agent.name === 'string' ? { name: agent.name } : {}),
    ...(typeof agent.agent === 'string' ? { kind: agent.agent } : {}),
    paneId: agent.pane_id,
    status,
    ...(typeof session?.value === 'string' ? { sessionId: session.value } : {}),
    ...(title ? { title } : {}),
  }
}

export const parseAgents = (stdout: string): ListedAgent[] | undefined => {
  const list = asRecord(asRecord(parseJson(stdout))?.result)?.agents
  if (!Array.isArray(list)) return undefined
  return list.map(toAgent).filter((agent): agent is ListedAgent => agent !== undefined)
}

export const parseAgent = (stdout: string): ListedAgent | undefined => toAgent(asRecord(asRecord(parseJson(stdout))?.result)?.agent)

export const parseNewPane = (stdout: string): { paneId: string; tabId?: string } | undefined => {
  const result = asRecord(asRecord(parseJson(stdout))?.result)
  const pane = asRecord(result?.pane) ?? asRecord(result?.root_pane)
  const tab = asRecord(result?.tab)
  if (typeof pane?.pane_id !== 'string') return undefined
  return { paneId: pane.pane_id, ...(typeof tab?.tab_id === 'string' ? { tabId: tab.tab_id } : {}) }
}

export type NewWorkspace = { workspaceId: string; paneId: string; tabId?: string }

// `workspace create` answers with .result.workspace, .result.tab and .result.root_pane. A pane id is `<workspace>:<pane>`,
// so a reply that leaves the workspace object out still names it.
export const parseNewWorkspace = (stdout: string): NewWorkspace | undefined => {
  const result = asRecord(asRecord(parseJson(stdout))?.result)
  const pane = asRecord(result?.root_pane) ?? asRecord(result?.pane)
  const tab = asRecord(result?.tab)
  const workspace = asRecord(result?.workspace)
  if (typeof pane?.pane_id !== 'string') return undefined
  const named = typeof workspace?.workspace_id === 'string' ? workspace.workspace_id : typeof workspace?.id === 'string' ? workspace.id : undefined
  const workspaceId = named ?? pane.pane_id.split(':')[0]
  if (!workspaceId) return undefined
  return { workspaceId, paneId: pane.pane_id, ...(typeof tab?.tab_id === 'string' ? { tabId: tab.tab_id } : {}) }
}

const outputOf = (result: ExecResult): string => [result.stdout, result.stderr].filter(Boolean).join('\n')

export const run = async (exec: Exec, argv: readonly string[], timeoutMs = 20_000): Promise<HerdrResult<string>> => {
  const result = await exec(argv, { timeoutMs })
  const output = outputOf(result)
  const code = herdrError(output)
  if (result.code === 0 && code === undefined) return { ok: true, value: result.stdout }
  return { ok: false, code: code ?? `exit_${result.code}`, output }
}

// A listing changes nothing, so it is the probe for "is a herdr server there to talk to". Drove never starts one.
export const probeServer = async (exec: Exec): Promise<HerdrResult<string>> => {
  try {
    return await run(exec, workspaceListArgv(), 10_000)
  } catch (error) {
    return { ok: false, code: 'unreachable', output: error instanceof Error ? error.message : String(error) }
  }
}

export const listAgents = async (exec: Exec): Promise<HerdrResult<ListedAgent[]>> => {
  const ran = await run(exec, agentListArgv(), 10_000)
  if (!ran.ok) return ran
  const agents = parseAgents(ran.value)
  return agents ? { ok: true, value: agents } : { ok: false, code: 'unparseable', output: ran.value.slice(0, 300) }
}

export const getAgent = async (exec: Exec, target: string): Promise<HerdrResult<ListedAgent>> => {
  const ran = await run(exec, agentGetArgv(target), 10_000)
  if (!ran.ok) return ran
  const agent = parseAgent(ran.value)
  return agent ? { ok: true, value: agent } : { ok: false, code: 'unparseable', output: ran.value.slice(0, 300) }
}

const readOutput = async (exec: Exec, argv: readonly string[]): Promise<HerdrResult<string>> => {
  const ran = await run(exec, argv, 10_000)
  if (!ran.ok) return ran
  const result = asRecord(asRecord(parseJson(ran.value))?.result)
  const read = asRecord(result?.read)
  const text = [result?.text, read?.text, result?.output].find((candidate): candidate is string => typeof candidate === 'string')
  return { ok: true, value: text ?? ran.value }
}

export const readScreen = (exec: Exec, target: string, lines: number, source: ReadSource = 'recent-unwrapped'): Promise<HerdrResult<string>> =>
  readOutput(exec, agentReadArgv(target, lines, source))

export const readPane = (exec: Exec, paneId: string, lines: number, source: ReadSource = 'recent-unwrapped'): Promise<HerdrResult<string>> =>
  readOutput(exec, paneReadArgv(paneId, lines, source))

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export const retryWhileBusy = async (exec: Exec, argv: readonly string[], timeoutMs: number, wait: (ms: number) => Promise<void> = sleep): Promise<HerdrResult<string>> => {
  const attempts = Math.max(1, Math.ceil(timeoutMs / BUSY_RETRY_INTERVAL_MS))
  let last: HerdrResult<string> = { ok: false, code: 'agent_pane_busy', output: '' }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await run(exec, argv, ATTEMPT_TIMEOUT_MS)
    if (last.ok || last.code !== 'agent_pane_busy') return last
    await wait(BUSY_RETRY_INTERVAL_MS)
  }
  return last
}
