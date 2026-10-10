export type OrchEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type OrchWorkerStatus = 'starting' | 'working' | 'idle' | 'blocked' | 'done' | 'unknown' | 'closed' | 'gone'

export type OrchReportKind = 'hello' | 'status' | 'progress' | 'done' | 'blocked' | 'question' | 'promote'

export type OrchReport = {
  kind: OrchReportKind
  summary: string
  at: number
}

export type OrchWorker = {
  name: string
  token: string
  paneId?: string
  sessionId?: string
  cwd: string
  model: string
  effort: OrchEffort
  isWorktree: boolean
  status: OrchWorkerStatus
  spawnedAt: number
  lastWorkingAt?: number
  lastReport?: OrchReport
  hasNudged?: boolean
  activity?: string
  isAsking?: boolean
  asksAt?: number
  ctx?: number
  cairnRef?: string
}

export type OrchOrchestrator = {
  goal?: string
  startedAt: number
  tabId?: string
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
  parentSessionId: string
  parentName?: string
  token: string
  model?: string
  effort?: OrchEffort
}

declare module 'claude-code' {
  interface PluginState {
    orchestrator: {
      orchestrator: OrchOrchestrator | null
      workers: OrchWorker[]
      worker: OrchWorkerSelf | null
      feed: OrchFeedEntry[]
      lead: OrchLead | null
      frame: number
      boardBg: boolean
      scrollBack: number
      expanded: string | null
    }
  }
}
