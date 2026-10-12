import type { AgentKind, Effort, Expects, RunMeta, SeatRole } from '../types'

// The mod reaches Drove only through its CLI (`node <drove>/src/cli.ts ...`): the plugin runtime has no Node.

export type Ran = { exitCode: number; stdout: string; stderr: string }
export type Failure = { code: string; text: string }

export const entryOf = (pluginRoot: string, configured: string): string => configured.trim() || `${pluginRoot.replace(/\/+$/, '')}/../src/cli.ts`

export const plannerEnv = (run: string, home?: string): Record<string, string> => ({
  ...(home ? { DROVE_HOME: home } : {}),
  DROVE_RUN: run,
  DROVE_ROLE: 'planner',
  DROVE_SEAT: 'planner',
})

export const attachArgs = (input: { sessionId: string; paneId?: string; goal?: string; model: string; effort: Effort; budget?: number; run?: string }): string[] => [
  'mod', 'attach', '--session', input.sessionId,
  ...(input.paneId ? ['--pane', input.paneId] : []),
  ...(input.goal ? ['--goal', input.goal] : []),
  '--model', input.model, '--effort', input.effort,
  ...(input.budget ? ['--budget', String(input.budget)] : []),
  ...(input.run ? ['--run', input.run] : []),
]

export const bridgeArgs = (run: string, sessionId: string): string[] => ['mod', 'bridge', '--run', run, '--session', sessionId]

export const spawnArgs = (input: { name: string; kind?: AgentKind; effort: Effort; model?: string; cairn?: string; mcp?: readonly string[]; plugins?: readonly string[]; skills?: readonly string[]; agents?: readonly string[]; userMemory?: boolean; userHooks?: boolean; role?: SeatRole; target?: string; owns?: readonly string[]; acceptance?: readonly string[]; maxTurns?: number; maxTokens?: number; maxMinutes?: number; maxCost?: number }): string[] => [
  'spawn', input.name,
  ...(input.kind ? ['--kind', input.kind] : []),
  '--brief', '-', '--effort', input.effort,
  ...(input.model ? ['--model', input.model] : []),
  ...(input.cairn ? ['--cairn', input.cairn] : []),
  ...(input.mcp ? ['--mcp', input.mcp.join(',')] : []),
  ...(input.plugins ? ['--plugins', input.plugins.join(',')] : []),
  ...(input.skills ? ['--skills', input.skills.join(',')] : []),
  ...(input.agents ? ['--agents', input.agents.join(',')] : []),
  ...(input.userMemory !== undefined ? ['--user-memory', input.userMemory ? 'on' : 'off'] : []),
  ...(input.role && input.role !== 'implementer' ? ['--role', input.role] : []),
  ...(input.target ? ['--target', input.target] : []),
  ...(input.userHooks !== undefined ? ['--user-hooks', input.userHooks ? 'on' : 'off'] : []),
  ...(input.owns && input.owns.length > 0 ? ['--owns', input.owns.join(',')] : []),
  ...(input.acceptance ?? []).map(item => `--acceptance=${item}`),
  ...(input.maxTurns ? ['--max-turns', String(input.maxTurns)] : []),
  ...(input.maxTokens ? ['--max-tokens', String(input.maxTokens)] : []),
  ...(input.maxMinutes !== undefined ? ['--max-minutes', String(input.maxMinutes)] : []),
  ...(input.maxCost !== undefined ? ['--max-cost', String(input.maxCost)] : []),
]

export const messageArgs = (name: string, expects: Expects): string[] => ['send', name, '--kind', 'message', '--expects', expects, '-']

export const verdictArgs = (name: string, verdict: 'approve' | 'changes'): string[] => ['send', name, '--kind', 'verdict', '--verdict', verdict, '-']

export const promoteArgs = (name: string, model: string | undefined, effort: Effort, reason?: string): string[] => ['promote', name, ...(model ? ['--model', model] : []), '--effort', effort, ...(reason ? ['--reason', reason] : [])]

export const migrateArgs = (input: { name: string; kind: AgentKind; model?: string; effort?: Effort; reason?: string }): string[] => [
  'migrate', input.name, '--kind', input.kind,
  ...(input.model ? ['--model', input.model] : []),
  ...(input.effort ? ['--effort', input.effort] : []),
  ...(input.reason ? ['--reason', input.reason] : []),
]

export const closeArgs = (name: string, removeWorktree: boolean): string[] => ['close', name, ...(removeWorktree ? ['--remove-worktree'] : [])]

// --no-checks is the human's, so no builder here can produce it.
export const mergeArgs = (input: { name: string; pr?: boolean; squash?: boolean; fresh?: boolean; message?: string }): string[] => [
  'merge', input.name,
  ...(input.pr ? ['--pr'] : []),
  ...(input.squash ? ['--squash'] : []),
  ...(input.fresh ? ['--fresh'] : []),
  ...(input.message ? ['-m', input.message] : []),
]

// A call that ran past its timeoutMs: $.process.run aborts it, and the mod reports that as drove-unavailable (exit -1).
export const isCutOff = (ran: Ran): boolean => ran.exitCode === -1 && /aborted: still running after/.test(ran.stderr)

export const checksArgs = (name: string, fresh?: boolean): string[] => ['checks', name, ...(fresh ? ['--fresh'] : [])]

export const rosterArgs = (run: string): string[] => ['roster', '--run', run]

export const reportsArgs = (run: string, seat?: string, all?: boolean): string[] => ['reports', ...(seat ? [seat] : []), ...(all ? ['--all'] : []), '--run', run]

// The text goes on stdin (`-`), so a goal that starts with a dash or holds quotes reaches Drove whole.
export const goalArgs = (run: string, cairn?: string): string[] => ['goal', '--run', run, ...(cairn ? ['--cairn', cairn] : []), '-']

// --add widens a seat's owns, --set replaces them; the globs are comma-separated, as spawn's --owns is.
export const ownsArgs = (run: string, name: string, mode: 'add' | 'set', globs: readonly string[]): string[] => ['owns', name, `--${mode}`, globs.join(','), '--run', run]

export const budgetArgs = (run: string, size: number): string[] => ['budget', String(size), '--run', run]

export const downArgs = (run: string): string[] => ['down', '--run', run]

// A failed drove command prints `<code>: <text>` on stderr and exits 1 (src/cli.ts print); any other exit
// (127, a crash, a signal) is not Drove's, so its text is kept whole.
export const failureOf = (ran: Ran): Failure => {
  const text = (ran.stderr.trim() || ran.stdout.trim() || `exit code ${ran.exitCode}`).split('\n\nUsage')[0] ?? ''
  const match = ran.exitCode === 1 ? /^([a-z][a-z-]*): ([\s\S]*)$/.exec(text) : null
  return match ? { code: match[1] ?? 'error', text: (match[2] ?? '').trim() } : { code: 'error', text }
}

export type JsonResult<T> = { ok: true; text: string; data?: T } | { ok: false; code: string; text: string }

// `drove mod attach` and `drove mod report` print one JSON CommandResult line.
export const jsonResultOf = <T>(ran: Ran): JsonResult<T> => {
  const line = ran.stdout.trim().split('\n').at(-1) ?? ''
  try {
    const parsed = JSON.parse(line) as JsonResult<T>
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.ok === 'boolean') return parsed
  } catch {
    // not JSON: a crash before the command ran
  }
  const failure = failureOf(ran)
  return { ok: false, code: failure.code, text: failure.text }
}

export const runOf = (result: JsonResult<{ run: RunMeta }>): RunMeta | undefined => (result.ok ? result.data?.run : undefined)

// ---------- the planner guard: `drove guard pre-tool-use`, fed the Claude PreToolUse hook JSON ----------

const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

export const guardStdin = (tool: string, input: Record<string, unknown>, cwd: string, sessionId: string): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd,
    tool_name: tool,
    tool_input: Object.fromEntries(Object.entries(input).filter(([key]) => !RESERVED.has(key))),
  })

export type GuardVerdict = { allow: true } | { allow: false; reason: string }

export const brokenGuard = (detail: string, entry: string): string =>
  `Orchestrator mode: Drove's guard could not run, so this call is refused (fail closed). ${detail.trim().slice(0, 300)} — check that node 22.18 or newer is on PATH and that ${entry} exists (the mod's droveEntry setting), then retry.`

// A spawn inherits the session's directory; once that is a removed worktree the failure reads like a missing node.
export const isSpawnCwdGone = (ran: Ran): boolean => ran.exitCode === -1 && /ENOENT/.test(ran.stderr)

export const missingCwdReason = (cwd: string, repo: string): string =>
  `Orchestrator mode: the session's working directory ${cwd} no longer exists (a removed worktree?): cd back to the repo (${repo}), then retry.`

export const isInsideDir = (path: string, dir: string): boolean => dir !== '' && (path === dir || path.startsWith(`${dir.replace(/\/+$/, '')}/`))

export const cwdInWorktreeReason = (name: string, worktree: string, cwd: string, repo: string): string =>
  `Orchestrator mode: your working directory ${cwd} is inside ${name}'s worktree ${worktree}, which remove_worktree would delete: cd to the repo (${repo}) first, then close it.`

export const guardVerdictOf = (ran: Ran, entry: string): GuardVerdict => {
  if (ran.exitCode === 0) return { allow: true }
  if (ran.exitCode === 2) {
    try {
      const parsed = JSON.parse(ran.stdout.trim()) as { hookSpecificOutput?: { permissionDecisionReason?: string } }
      const reason = parsed.hookSpecificOutput?.permissionDecisionReason
      if (reason) return { allow: false, reason }
    } catch {
      // the reason is on stderr instead
    }
    if (ran.stderr.trim()) return { allow: false, reason: ran.stderr.trim() }
  }
  return { allow: false, reason: brokenGuard(`drove guard exited ${ran.exitCode}: ${ran.stderr || ran.stdout}`, entry) }
}

export const GUARDED_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
