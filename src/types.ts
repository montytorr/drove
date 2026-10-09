export type AgentKind = 'claude' | 'codex'
export type Role = 'planner' | 'worker'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ReportKind = 'done' | 'question' | 'blocked' | 'progress' | 'promote'
export type Expects = 'review' | 'answer' | 'none'
export type ControlKind = 'brief' | 'message' | 'answer' | 'verdict' | 'promote' | 'demote' | 'nudge'
export type Verdict = 'approve' | 'changes'

export type HerdrStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
export type SeatState = 'starting' | 'working' | 'idle' | 'done' | 'blocked' | 'needs-input' | 'unknown' | 'gone' | 'closed' | 'down'

export type Identity = {
  home: string
  run: string
  role: Role
  seat: string
  token?: string
}

export type DroveConfig = {
  humanName: string
  plannerModel: Record<AgentKind, string>
  plannerEffort: Effort
  workerModel: Record<AgentKind, string>
  workerEffort: Effort
  promotedModel: Record<AgentKind, string>
  budget: number
  codexBypassHookTrust: boolean
  claudeChannel: boolean
}

export type PlannerMeta = {
  kind: AgentKind
  paneId?: string
  sessionId?: string
  model: string
  effort: Effort
  viaMod: boolean
}

export type RunMeta = {
  v: 1
  id: string
  repo: string
  base: string
  hasRemote: boolean
  createdAt: string
  status: 'up' | 'down'
  goal?: string
  tabId?: string
  budget: number
  planner: PlannerMeta
}

export type LastReport = {
  id: string
  kind: ReportKind
  expects: Expects
  summary: string
  at: string
}

export type Attention = {
  seat: string
  reason: 'dialog' | 'permission' | 'trust' | 'hook-trust' | 'channel-confirm' | 'codex-version-mismatch' | 'stalled' | 'idle-without-report' | 'gone' | 'budget' | 'pending-delivery'
  detail: string
  at: string
}

export type Seat = {
  name: string
  kind: AgentKind
  cairn?: string
  model: string
  effort: Effort
  paneId?: string
  sessionId?: string
  worktree: string
  branch: string
  state: SeatState
  stateAt: string
  spawnedAt: string
  lastWorkingAt?: string
  lastReport?: LastReport
  owes: Expects
  hasNudged?: boolean
  pendingPromote?: { model: string; effort: Effort; reason?: string }
  attention: Attention[]
}

export type Roster = {
  v: 1
  run: string
  seats: Seat[]
  updatedAt: string
}

export type Report = {
  v: 1
  id: string
  run: string
  seat: string
  token: string
  kind: ReportKind
  expects: Expects
  for?: 'human'
  summary: string
  details?: string
  at: string
}

export type ReportInput = {
  kind: ReportKind
  expects?: Expects
  for?: 'human'
  summary: string
  details?: string
}

export type Control = {
  v: 1
  id: string
  run: string
  from: 'planner'
  to: string
  kind: ControlKind
  expects: Expects
  verdict?: Verdict
  model?: string
  effort?: Effort
  body: string
  at: string
}

export type Envelope = {
  fields: Record<string, string>
  body: string
}

export type DroveEventType =
  | 'run.up'
  | 'run.down'
  | 'seat.spawn'
  | 'seat.start_failed'
  | 'seat.state'
  | 'seat.close'
  | 'report'
  | 'report.delivered'
  | 'report.pending'
  | 'control.queued'
  | 'control.sent'
  | 'control.failed'
  | 'attention'
  | 'guard.deny'

export type DroveEvent = {
  at: string
  type: DroveEventType
  seat?: string
  id?: string
  data?: Record<string, unknown>
}

export type HookEventName = 'session-start' | 'user-prompt-submit' | 'pre-tool-use' | 'stop' | 'notification' | 'permission-request'

export type HookRecord = {
  at: string
  agent: AgentKind
  event: HookEventName
  sessionId?: string
  detail?: string
}

export type HookInput = {
  agent: AgentKind
  event: HookEventName
  sessionId?: string
  cwd?: string
  tool?: string
  toolInput?: Record<string, unknown>
  detail?: string
}

export type GuardInput = {
  agent: AgentKind
  role: Role
  tool: string
  input: Record<string, unknown>
  cwd: string
  writableRoots: readonly string[]
  openSeats: readonly string[]
}

export type GuardDecision = { allow: true } | { allow: false; reason: string }

export type ExecResult = { code: number; stdout: string; stderr: string }
export type ExecOptions = { timeoutMs?: number; input?: string; env?: Record<string, string>; cwd?: string }
export type Exec = (argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>

export type Clock = { now: () => Date }

export type Deps = {
  exec: Exec
  clock: Clock
  home: string
}

export type HerdrAgent = {
  name?: string
  paneId: string
  status: HerdrStatus
  sessionId?: string
  title?: string
}

export type LaunchFile = { path: string; content: string; mode: number }

export type LaunchSpec = {
  kind: AgentKind
  role: Role
  cwd: string
  env: Record<string, string>
  argv: string[]
  files: LaunchFile[]
}

export type LaunchRequest = {
  identity: Identity
  kind: AgentKind
  repo: string
  cwd: string
  model: string
  effort: Effort
  sessionId?: string
  resumeId?: string
  roleText: string
  initialPrompt?: string
  droveEntry: string
  bypassHookTrust?: boolean
  channel?: boolean
}

export type Transport = 'launch-arg' | 'herdr-prompt' | 'codex-queue' | 'mod' | 'channel' | 'piggyback'

export type Delivery =
  | { ok: true; via: Transport }
  | { ok: false; queued: boolean; reason: string }

export type DeliveryAdapter = {
  transport: Transport
  canDeliver: (seat: Seat) => boolean
  deliver: (seat: Seat, text: string) => Promise<Delivery>
}

export type SpawnRequest = {
  seat: string
  kind: AgentKind
  cairn?: string
  brief: string
  model?: string
  effort?: Effort
  base?: string
}

export type SendRequest = {
  seat: string
  kind: Exclude<ControlKind, 'brief' | 'promote' | 'demote'>
  body: string
  expects?: Expects
  verdict?: Verdict
}

export type PromoteRequest = {
  seat: string
  model: string
  effort: Effort
  reason?: string
}

export type CommandResult = { ok: true; text: string; data?: unknown } | { ok: false; text: string; code: string }

export type SeatSignals = {
  herdr?: HerdrAgent
  hooks: readonly HookRecord[]
  lastReport?: LastReport
  screen?: string
}

export type Derived = { state: SeatState; attention: Attention[] }

export type McpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>
}
