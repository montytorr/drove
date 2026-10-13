// Drove's run-state shapes, copied from drove/src/types.ts because the mod runtime cannot import across the
// plugin folder. test/mod-types.test.ts in the drove repo fails when a copied declaration drifts.
// ---- copied from src/types.ts ----
export type AgentKind = 'claude' | 'codex'
export type HostAgent = { version: string; model?: string; effort?: string }
export type HostAgents = { claude?: HostAgent; codex?: HostAgent; at: string }
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type SeatRole = 'implementer' | 'reviewer' | 'tester'

export type ReportKind = 'done' | 'question' | 'blocked' | 'progress' | 'promote'
export type Expects = 'review' | 'answer' | 'none'
export type ControlKind = 'brief' | 'message' | 'answer' | 'verdict' | 'promote' | 'demote' | 'nudge'

export type SeatState = 'starting' | 'working' | 'idle' | 'done' | 'blocked' | 'needs-input' | 'unknown' | 'gone' | 'closing' | 'closed' | 'down'

export type SpawnPolicyKey = 'kind' | 'model' | 'effort' | 'mcp' | 'plugins' | 'skills' | 'agents' | 'userMemory' | 'userHooks' | 'owns' | 'maxTurns' | 'maxTokens' | 'maxMinutes' | 'maxCost' | 'role' | 'bound'
export type SpawnPolicyRule = { fixed?: unknown; choice?: unknown[]; required?: true; max?: number }
export type SpawnPolicy = Partial<Record<SpawnPolicyKey, SpawnPolicyRule>>

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
  for?: 'human'
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
  // Failed auto-checks of its done reports since its last pass (DROVE-126).
  autoCheckAttempts?: number
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
  | 'steer.nudged'
  | 'autocheck.passed'
  | 'autocheck.failed'

export type DroveEvent = {
  at: string
  type: DroveEventType
  seat?: string
  id?: string
  data?: Record<string, unknown>
}
// ---- end of the copy ----

// What a Claude worker's mod writes to seats/<seat>/mod.json and the bridge streams back (src/modhost.ts ModStatus).
export type OrchModStatus = { at?: string; ctx?: number; asking?: string; activity?: string }

export type OrchOrchestrator = {
  run: string
  repo: string
  goal?: string
  startedAt: number
  budget: number
}

export type OrchBridge = {
  state: 'starting' | 'up' | 'busy' | 'failed' | 'stopped'
  detail?: string
  since: number
}

export type OrchFeedEntry = {
  id?: string
  full?: string
  at: number
  from: string
  to: string
  kind: string
  summary: string
  isHidden?: boolean
}

export type OrchLead = {
  activity: string
  since: number
}

export type OrchWorkerSelf = {
  name: string
  run: string
  home: string
  model?: string
  effort?: Effort
}

declare module 'claude-code' {
  interface PluginState {
    orchestrator: {
      orchestrator: OrchOrchestrator | null
      view: OrchOrchestrator | null
      seats: Seat[]
      status: Record<string, OrchModStatus>
      asksAt: Record<string, number>
      bridge: OrchBridge | null
      worker: OrchWorkerSelf | null
      feed: OrchFeedEntry[]
      lead: OrchLead | null
      frame: number
      boardBg: boolean
      scrollBack: number
      expanded: string | null
      pendingGoal: string | null
      pendingWakes: string[]
    }
  }
}
