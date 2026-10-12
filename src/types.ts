export type AgentKind = 'claude' | 'codex'
export type HostAgent = { version: string; model?: string; effort?: string }
export type HostAgents = { claude?: HostAgent; codex?: HostAgent; at: string }
export type Role = 'planner' | 'worker'
// What a worker seat is for (DROVE-91): absent means an implementer. A reviewer reads another seat's work and reports; a tester writes tests only.
export type SeatRole = 'implementer' | 'reviewer' | 'tester'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ReportKind = 'done' | 'question' | 'blocked' | 'progress' | 'promote'
export type Expects = 'review' | 'answer' | 'none'
export type ControlKind = 'brief' | 'message' | 'answer' | 'verdict' | 'promote' | 'demote' | 'nudge'
export type Verdict = 'approve' | 'changes'

export type HerdrStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
export type SeatState = 'starting' | 'working' | 'idle' | 'done' | 'blocked' | 'needs-input' | 'unknown' | 'gone' | 'closing' | 'closed' | 'down'

export type Identity = {
  home: string
  run: string
  role: Role
  seat: string
  token?: string
  owns?: string[]
  seatRole?: SeatRole
}

export type DroveConfig = {
  humanName: string
  plannerModel: Record<AgentKind, string>
  plannerEffort: Effort
  workerModel: Record<AgentKind, string>
  workerKind?: 'auto' | 'claude' | 'codex'
  workerEffort: Effort
  promotedModel: Record<AgentKind, string>
  budget: number
  codexBypassHookTrust: boolean
  codexWorkerSandbox: 'bypass' | 'workspace-write'
  claudeChannel: boolean
  briefVia: 'prompt' | 'launch-arg'
  labInstance: string
  workerEnv: Record<string, string>
  workerPorts?: { base: number; stride: number }
  workerCopy?: string[]
  workerMcp?: string[]
  workerSkills?: string[]
  workerAgents?: string[]
  workerPlugins?: string[]
  workerUserMemory?: boolean
  workerUserHooks?: boolean
  maxTurns?: number
  reviewLoopLimit?: number
  otlpEndpoint?: string
  runMaxCost?: number
  // One seat's denials of one rule that make the planner hear of it (defaults 3 in 10 minutes).
  guardThrash?: { count: number; minutes: number }
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
  cairn?: string
  tabId?: string
  workspace?: string
  budget: number
  planner: PlannerMeta
  agents?: HostAgents
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
  reason: 'dialog' | 'permission' | 'trust' | 'hook-trust' | 'channel-confirm' | 'codex-version-mismatch' | 'usage-limit' | 'stalled' | 'idle-without-report' | 'gone' | 'budget' | 'review-loop' | 'run-budget' | 'pending-delivery' | 'guard-thrash'
  detail: string
  at: string
}

export type MergeGate = { result: 'passed' | 'refused' | 'pending'; at: string; detail: string }

// A seat's last check run (DROVE-122), kept on the roster for the boards; the ledger holds every run. `stale` is set by the
// watcher once the worktree's HEAD is no longer `sha`.
export type SeatChecks = { result: 'passed' | 'failed'; sha: string; clean: boolean; at: string; failed?: string; stale?: boolean }

export type Seat = {
  name: string
  kind: AgentKind
  cairn?: string
  model: string
  effort: Effort
  paneId?: string
  sessionId?: string
  codexHome?: string
  mcp?: string[]
  plugins?: string[]
  skills?: string[]
  agents?: string[]
  userMemory?: boolean
  role?: SeatRole
  target?: string
  userHooks?: boolean
  owns?: string[]
  acceptance?: string[]
  maxTurns?: number
  maxTokens?: number
  maxMinutes?: number
  maxCost?: number
  budgetNoticed?: boolean
  reviewChanges?: number
  slot?: number
  worktree: string
  branch: string
  state: SeatState
  stateAt: string
  spawnedAt: string
  lastWorkingAt?: string
  lastReport?: LastReport
  lastSentAt?: string
  gate?: MergeGate
  checks?: SeatChecks
  owes: Expects
  hasNudged?: boolean
  pendingPromote?: { model: string; effort: Effort; reason?: string }
  restartingSince?: string
  migratedFrom?: { kind: AgentKind; sessionId?: string; model: string; at: string; reason?: string }
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
  criteria?: Criterion[]
  acceptance?: number
  at: string
}

// One acceptance criterion of a seat, as the worker's done report answers it (DROVE-123). `acceptance` on a Report is the
// number of criteria Drove had written into the seat's brief when the report was stamped.
export type Criterion = { id: string; met: boolean; evidence: string }

export type ReportInput = {
  kind: ReportKind
  expects?: Expects
  for?: 'human'
  summary: string
  details?: string
  criteria?: Criterion[]
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
  | 'run.recovered'
  | 'goal.set'
  | 'seat.spawn'
  | 'seat.start_failed'
  | 'seat.relaunch'
  | 'seat.migrate'
  | 'seat.owns'
  | 'seat.state'
  | 'seat.close'
  | 'report'
  | 'report.delivered'
  | 'report.pending'
  | 'control.queued'
  | 'control.sent'
  | 'control.failed'
  | 'attention'
  | 'guard.denied'
  | 'merge.passed'
  | 'merge.refused'
  | 'merge.pending'
  | 'checks.ran'

export type DroveEvent = {
  at: string
  type: DroveEventType
  seat?: string
  id?: string
  data?: Record<string, unknown>
}

export type HookEventName = 'session-start' | 'user-prompt-submit' | 'pre-tool-use' | 'stop' | 'stop-failure' | 'notification' | 'permission-request'

export type HookRecord = {
  at: string
  agent: AgentKind
  event: HookEventName
  sessionId?: string
  detail?: string
  transcript?: string
}

export type HookInput = {
  agent: AgentKind
  event: HookEventName
  sessionId?: string
  cwd?: string
  tool?: string
  toolInput?: Record<string, unknown>
  detail?: string
  transcript?: string
}

export type GuardInput = {
  agent: AgentKind
  role: Role
  tool: string
  input: Record<string, unknown>
  cwd: string
  writableRoots: readonly string[]
  openSeats: readonly string[]
  owns?: readonly string[]
  seatRole?: SeatRole
}

// Why the guard said no, as a stable id: the ledger (`guard.denied`), the thrash escalation and the run report group by it.
export type GuardRule =
  | 'owns'
  | 'reviewer-readonly'
  | 'planner-edit'
  | 'planner-shell'
  | 'push'
  | 'production'
  | 'herdr'
  | 'merge-gate'
  | 'agent-launch'
  | 'drove-cli'
  | 'github'
  | 'run-state'
  | 'unreadable'
  | 'guard-error'

export type GuardDecision = { allow: true } | { allow: false; reason: string; rule: GuardRule }

export type ExecResult = { code: number; stdout: string; stderr: string }
export type ExecOptions = { timeoutMs?: number; input?: string; env?: Record<string, string>; cwd?: string }
export type Exec = (argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>

export type Clock = { now: () => Date }

export type Deps = {
  exec: Exec
  clock: Clock
  home: string
  codexUserHome?: string
  claudeUserConfig?: string
  claudeUserDir?: string
  // Waits between gh retries (merge --pr); tests pass a no-op.
  sleep?: (ms: number) => Promise<void>
}

export type HerdrAgent = {
  name?: string
  paneId: string
  status: HerdrStatus
  sessionId?: string
  title?: string
}

export type LaunchFile = { path: string; content: string; mode: number }

export type LaunchLink = { path: string; target: string }

export type LaunchSpec = {
  kind: AgentKind
  role: Role
  cwd: string
  env: Record<string, string>
  argv: string[]
  files: LaunchFile[]
  links?: LaunchLink[]
  unlinks?: string[]
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
  inWorktree?: boolean
  roleText: string
  initialPrompt?: string
  droveEntry: string
  bypassHookTrust?: boolean
  channel?: boolean
  workerEnv?: Record<string, string>
  mcpAllow?: string[]
  userMcp?: Record<string, unknown>
  pluginAllow?: string[]
  userPlugins?: UserPlugins
  skillAllow?: string[]
  userSkills?: string[]
  agentAllow?: string[]
  userAgents?: string[]
  userMemory?: boolean
  userHooks?: boolean
  userSettings?: Record<string, unknown>
  claudeDir?: string
}

// What Drove read from the user's Claude settings.json, read only: the plugins it enables, and the dirs of
// env.CLAUDE_CODE_PLUGIN_DIRS as written there, each with the plugin name it holds.
export type UserPlugins = {
  enabled: string[]
  dirs?: { entry: string; name: string }[]
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
  kind?: AgentKind
  cairn?: string
  brief: string
  model?: string
  effort?: Effort
  base?: string
  mcp?: string[]
  plugins?: string[]
  skills?: string[]
  agents?: string[]
  userMemory?: boolean
  role?: SeatRole
  target?: string
  userHooks?: boolean
  owns?: string[]
  acceptance?: string[]
  maxTurns?: number
  maxTokens?: number
  maxMinutes?: number
  maxCost?: number
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

export type MergeRequest = {
  seat: string
  pr?: boolean
  squash?: boolean
  message?: string
  noChecks?: boolean
  fresh?: boolean
}

export type MigrateRequest = {
  seat: string
  kind: AgentKind
  model?: string
  effort?: Effort
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

// DROVE-96: one thing in a run that waits on a person. `id` is stable for as long as the item is open and is never
// reused by a later episode; `kind` is an Attention reason, the kind of a report addressed to the human, `asking` or
// `pane-budget`.
export type AttentionKind = Attention['reason'] | 'question' | 'blocked' | 'promote' | 'asking' | 'pane-budget'

export type AttentionAnswer =
  | { type: 'command'; command: string; note?: string }
  | { type: 'pane'; pane?: string; inspect?: string; note: string }
  | { type: 'planner'; note: string; command?: string }

export type AttentionItem = {
  id: string
  run: string
  seat: string
  kind: AttentionKind
  text: string
  since: string
  answer: AttentionAnswer
}

export type PlannerState = HerdrStatus | 'gone' | 'unreachable' | 'down'

// What drove plan --detached and drove up --detached return with --json (DROVE-95).
export type DetachedStart = {
  run: string
  repo: string
  status: RunMeta['status']
  workspace: string
  tab?: string
  planner: { kind: AgentKind; pane: string; name: string; model: string; effort: Effort; state: SeatState; sessionId?: string; attention?: { reason: Attention['reason']; detail: string } }
  goal?: string
  cairn?: string
  resumed?: string[]
  lost?: string[]
}

export type McpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>
}
