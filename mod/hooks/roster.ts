import type { OrchEffort, OrchFeedEntry, OrchWorker, OrchWorkerStatus } from '../types'
import { shortModel } from './protocol'

export const CLOSED: ReadonlySet<OrchWorkerStatus> = new Set(['closed', 'gone'])

export const openWorkers = (workers: readonly OrchWorker[]): OrchWorker[] => workers.filter(({ status }) => !CLOSED.has(status))

export const findWorker = (workers: readonly OrchWorker[], name: string): OrchWorker | undefined =>
  workers.find(worker => worker.name === name && !CLOSED.has(worker.status))

export const replaceWorker = (workers: readonly OrchWorker[], next: OrchWorker): OrchWorker[] =>
  workers.map(worker => (worker.name === next.name && worker.token === next.token ? next : worker))

export type WorkerEnv = {
  parentSessionId: string
  parentName?: string
  name: string
  token: string
  model: string
  effort: OrchEffort
}

// _CC_ACCT_PINNED makes Cal's zsh `claude` launcher skip its `claude-acct ensure dispofi`
// swap, so a worker runs on whichever account is live: the orchestrator's (claude or claude-cal).
export const workerEnvPairs = ({ parentSessionId, parentName, name, token, model, effort }: WorkerEnv): string[] => [
  '_CC_ACCT_PINNED=1',
  `CLAUDE_ORCH_PARENT=${parentSessionId}`,
  `CLAUDE_ORCH_PARENT_NAME=${parentName ?? ''}`,
  `CLAUDE_ORCH_WORKER=${name}`,
  `CLAUDE_ORCH_TOKEN=${token}`,
  `CLAUDE_ORCH_MODEL=${model}`,
  `CLAUDE_ORCH_EFFORT=${effort}`,
]

export const splitArgv = (sourcePane: string, direction: 'right' | 'down', cwd: string, env: readonly string[]): string[] => [
  'herdr', 'pane', 'split', '--pane', sourcePane, '--direction', direction, '--cwd', cwd, '--no-focus',
  ...env.flatMap(pair => ['--env', pair]),
]

export const startArgv = (name: string, paneId: string, model: string, effort: OrchEffort, worktree?: string): string[] => [
  'herdr', 'agent', 'start', name, '--kind', 'claude', '--pane', paneId, '--timeout', '60000', '--',
  '--dangerously-skip-permissions', '--model', model, '--effort', effort, '-n', name,
  ...(worktree ? ['--worktree', worktree] : []),
]

const BUSY_RETRY = 'for i in $(seq 1 90); do out=$("$@" 2>&1); code=$?; case "$out" in *agent_pane_busy*) sleep 0.5;; *) printf "%s" "$out"; exit $code;; esac; done; printf "%s" "$out"; exit 1'

export const retryWhileBusy = (argv: readonly string[]): string[] => ['sh', '-c', BUSY_RETRY, 'sh', ...argv]

export const promptArgv = (name: string, text: string): string[] => ['herdr', 'agent', 'prompt', name, text, '--wait', '--timeout', '8000']

export const agentStatusOf = (agents: readonly HerdrAgent[] | undefined, paneId: string): string | undefined => agents?.find(agent => agent.paneId === paneId)?.status

export const closeArgv = (paneId: string): string[] => ['herdr', 'pane', 'close', paneId]

export const LIST_ARGV = ['herdr', 'agent', 'list'] as const

export const herdrError = (output: string): string | undefined => {
  try {
    const parsed = JSON.parse(output) as { error?: { code?: string; message?: string } }
    if (parsed.error) return parsed.error.code ?? parsed.error.message ?? 'error'
  } catch {
    const match = /"code"\s*:\s*"([a-z_]+)"/.exec(output) ?? /\b(agent_[a-z_]+|pane_[a-z_]+|invalid_[a-z_]+|timeout)\b/.exec(output)
    if (match) return match[1]
  }
  return undefined
}

export const parseSplit = (stdout: string): string | undefined => {
  try {
    const parsed = JSON.parse(stdout) as { result?: { pane?: { pane_id?: string } } }
    return parsed.result?.pane?.pane_id
  } catch {
    return undefined
  }
}

export type HerdrAgent = { paneId: string; status: string; sessionId?: string; title?: string }

export const parseAgents = (stdout: string): HerdrAgent[] | undefined => {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: { agents?: { pane_id?: string; agent_status?: string; agent_session?: { value?: string }; terminal_title_stripped?: string }[] }
    }
    const agents = parsed.result?.agents
    if (!Array.isArray(agents)) return undefined
    return agents
      .filter(agent => typeof agent.pane_id === 'string')
      .map(agent => ({ paneId: agent.pane_id ?? '', status: agent.agent_status ?? 'unknown', sessionId: agent.agent_session?.value, title: agent.terminal_title_stripped?.trim() || undefined }))
  } catch {
    return undefined
  }
}

const HERDR_STATUS: Record<string, OrchWorkerStatus> = { idle: 'idle', done: 'done', working: 'working', blocked: 'blocked', unknown: 'unknown' }

export type Observation = { worker: OrchWorker; events: ('blocked' | 'gone' | 'idle-without-report')[] }

export const observe = (worker: OrchWorker, agents: readonly HerdrAgent[], now: number): Observation => {
  if (CLOSED.has(worker.status) || worker.status === 'starting' || worker.paneId === undefined) return { worker, events: [] }
  const agent = agents.find(({ paneId }) => paneId === worker.paneId)
  if (!agent) return { worker: { ...worker, status: 'gone' }, events: ['gone'] }
  const herdrStatus = HERDR_STATUS[agent.status] ?? 'unknown'
  const status: OrchWorkerStatus = worker.isAsking ? 'blocked' : herdrStatus
  const next: OrchWorker = {
    ...worker,
    status,
    sessionId: worker.sessionId ?? agent.sessionId,
    activity: agent.title && !/^claude\b/i.test(agent.title) && !agent.title.startsWith(worker.name) ? agent.title : worker.activity,
    ...(status === 'working' ? { lastWorkingAt: now, hasNudged: false } : {}),
  }
  const events: Observation['events'] = []
  if (status === 'blocked' && worker.status !== 'blocked') events.push('blocked')
  const isSettled = status === 'idle' || status === 'done'
  const reportedAt = worker.lastReport?.at ?? 0
  if (isSettled && !worker.hasNudged && worker.lastWorkingAt !== undefined && reportedAt < worker.lastWorkingAt) {
    events.push('idle-without-report')
    next.hasNudged = true
  }
  return { worker: next, events }
}

const STATUS_GLYPH: Record<OrchWorkerStatus, string> = {
  starting: '…', working: '⚙', idle: '·', blocked: '⛔', done: '✓', unknown: '?', closed: '×', gone: '×',
}

export const statusGlyph = (status: OrchWorkerStatus): string => STATUS_GLYPH[status]

export const effortLetter = (effort: OrchEffort): string => (effort === 'xhigh' ? 'xh' : effort.charAt(0))

export const rosterLines = (workers: readonly OrchWorker[], now: number): string[] => {
  const open = openWorkers(workers)
  if (open.length === 0) return ['No workers are open.']
  return open.map(worker => {
    const report = worker.lastReport ? ` · last report ${worker.lastReport.kind} ${Math.max(0, Math.round((now - worker.lastReport.at) / 60_000))}m ago: ${worker.lastReport.summary.slice(0, 120)}` : ''
    return `- ${worker.name} [${worker.status}] ${shortModel(worker.model)} ${worker.effort}${worker.isWorktree ? ' · worktree' : ''} · pane ${worker.paneId ?? '?'}${report}`
  })
}

export const makeToken = (seed: number): string => {
  const random = () => Math.floor(Math.random() * 0x100000000).toString(36)
  return `${seed.toString(36)}${random()}${random()}`
}

export const tabCreateArgv = (workspace: string, cwd: string, label: string, env: readonly string[]): string[] => [
  'herdr', 'tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--no-focus',
  ...env.flatMap(pair => ['--env', pair]),
]

export const tabGetArgv = (tabId: string): string[] => ['herdr', 'tab', 'get', tabId]

export const tabCloseArgv = (tabId: string): string[] => ['herdr', 'tab', 'close', tabId]

export const parseTab = (stdout: string): { tabId: string; paneId: string } | undefined => {
  try {
    const parsed = JSON.parse(stdout) as { result?: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } } }
    const tabId = parsed.result?.tab?.tab_id
    const paneId = parsed.result?.root_pane?.pane_id
    return tabId && paneId ? { tabId, paneId } : undefined
  } catch {
    return undefined
  }
}

// Workers fill the tab as a grid: the 2nd beside the 1st, then each one under the worker two places before it.
export const gridSlot = (open: readonly OrchWorker[]): { anchor: string; direction: 'right' | 'down' } | undefined => {
  const placed = [...open].filter(worker => worker.paneId).sort((a, b) => a.spawnedAt - b.spawnedAt)
  if (placed.length === 0) return undefined
  if (placed.length === 1) return { anchor: placed[0]?.paneId ?? '', direction: 'right' }
  const above = placed[placed.length - 2] ?? placed[placed.length - 1]
  return { anchor: above?.paneId ?? '', direction: 'down' }
}

export const FEED_MAX = 50

export const pushFeed = (feed: readonly OrchFeedEntry[], entry: OrchFeedEntry): OrchFeedEntry[] => [...feed, entry].slice(-FEED_MAX)

export const oneLine = (text: string, max = 120): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

