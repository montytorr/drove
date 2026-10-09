import type { AgentKind, Exec, ExecResult, HerdrAgent, HerdrStatus } from './types.ts'

export type HerdrResult<T> = { ok: true; value: T } | { ok: false; code: string; output: string }

export const BUSY_RETRY_INTERVAL_MS = 500
export const DEFAULT_START_TIMEOUT_MS = 60_000
export const DEFAULT_PROMPT_TIMEOUT_MS = 8_000
const ATTEMPT_TIMEOUT_MS = 90_000

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

export const agentReadArgv = (target: string, lines: number, source: 'recent-unwrapped' | 'detection' = 'recent-unwrapped'): string[] => [
  'herdr', 'agent', 'read', target, '--source', source, '--lines', String(lines),
]

export const agentListArgv = (): string[] => ['herdr', 'agent', 'list']
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

const STATUSES: ReadonlySet<string> = new Set<HerdrStatus>(['idle', 'working', 'blocked', 'done', 'unknown'])

const toAgent = (raw: unknown): HerdrAgent | undefined => {
  const agent = asRecord(raw)
  if (!agent || typeof agent.pane_id !== 'string') return undefined
  const status = typeof agent.agent_status === 'string' && STATUSES.has(agent.agent_status) ? (agent.agent_status as HerdrStatus) : 'unknown'
  const session = asRecord(agent.agent_session)
  const title = typeof agent.terminal_title_stripped === 'string' ? agent.terminal_title_stripped.trim() : ''
  return {
    ...(typeof agent.name === 'string' ? { name: agent.name } : {}),
    paneId: agent.pane_id,
    status,
    ...(typeof session?.value === 'string' ? { sessionId: session.value } : {}),
    ...(title ? { title } : {}),
  }
}

export const parseAgents = (stdout: string): HerdrAgent[] | undefined => {
  const list = asRecord(asRecord(parseJson(stdout))?.result)?.agents
  if (!Array.isArray(list)) return undefined
  return list.map(toAgent).filter((agent): agent is HerdrAgent => agent !== undefined)
}

export const parseAgent = (stdout: string): HerdrAgent | undefined => toAgent(asRecord(asRecord(parseJson(stdout))?.result)?.agent)

export const parseNewPane = (stdout: string): { paneId: string; tabId?: string } | undefined => {
  const result = asRecord(asRecord(parseJson(stdout))?.result)
  const pane = asRecord(result?.pane) ?? asRecord(result?.root_pane)
  const tab = asRecord(result?.tab)
  if (typeof pane?.pane_id !== 'string') return undefined
  return { paneId: pane.pane_id, ...(typeof tab?.tab_id === 'string' ? { tabId: tab.tab_id } : {}) }
}

const outputOf = (result: ExecResult): string => [result.stdout, result.stderr].filter(Boolean).join('\n')

export const run = async (exec: Exec, argv: readonly string[], timeoutMs = 20_000): Promise<HerdrResult<string>> => {
  const result = await exec(argv, { timeoutMs })
  const output = outputOf(result)
  const code = herdrError(output)
  if (result.code === 0 && code === undefined) return { ok: true, value: result.stdout }
  return { ok: false, code: code ?? `exit_${result.code}`, output }
}

export const listAgents = async (exec: Exec): Promise<HerdrResult<HerdrAgent[]>> => {
  const ran = await run(exec, agentListArgv(), 10_000)
  if (!ran.ok) return ran
  const agents = parseAgents(ran.value)
  return agents ? { ok: true, value: agents } : { ok: false, code: 'unparseable', output: ran.value.slice(0, 300) }
}

export const getAgent = async (exec: Exec, target: string): Promise<HerdrResult<HerdrAgent>> => {
  const ran = await run(exec, agentGetArgv(target), 10_000)
  if (!ran.ok) return ran
  const agent = parseAgent(ran.value)
  return agent ? { ok: true, value: agent } : { ok: false, code: 'unparseable', output: ran.value.slice(0, 300) }
}

export const readScreen = async (exec: Exec, target: string, lines: number, source: 'recent-unwrapped' | 'detection' = 'recent-unwrapped'): Promise<HerdrResult<string>> => {
  const ran = await run(exec, agentReadArgv(target, lines, source), 10_000)
  if (!ran.ok) return ran
  const result = asRecord(asRecord(parseJson(ran.value))?.result)
  const read = asRecord(result?.read)
  const text = [result?.text, read?.text, result?.output].find((candidate): candidate is string => typeof candidate === 'string')
  return { ok: true, value: text ?? ran.value }
}

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
