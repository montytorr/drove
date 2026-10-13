import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeExec } from '../src/commands.ts'
import { seatDir } from '../src/paths.ts'
import { saveRun, updateRoster } from '../src/roster.ts'
import { writeToken } from '../src/store.ts'
import type { Deps, Exec, ExecResult, HerdrStatus, RunMeta, Seat } from '../src/types.ts'

export const FIXTURES = join(import.meta.dirname, 'fixtures', 'p3')

export const assertGolden = (name: string, value: unknown) => {
  const path = join(FIXTURES, `${name}.json`)
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) writeFileSync(path, text)
  assert.equal(text, readFileSync(path, 'utf8'), `golden ${name}.json differs (UPDATE_GOLDEN=1 rewrites it)`)
}

export const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

export const tmp = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), `drove-p3-${prefix}-`))

export const makeClock = (start = '2026-10-09T10:00:00.000Z') => {
  let now = new Date(start).getTime()
  return { now: () => new Date(now), advance: (ms: number) => void (now += ms) }
}

export const result = (stdout = '', code = 0, stderr = ''): ExecResult => ({ code, stdout, stderr })
export const herdrFail = (code: string, message = code): ExecResult => result('', 1, JSON.stringify({ error: { code, message } }))

const UNSAFE_AGENT_ARG = /[\u0000-\u001f\u007f]/

export type FakeAgent = { name: string; paneId: string; tabId: string; status: HerdrStatus; sessionId?: string; kind?: string }

export type FakeHerdrOptions = { git?: boolean; agentReadFails?: boolean | string; paneReadFails?: string; startFails?: string; screen?: string; startSession?: string; startStatus?: HerdrStatus; busyStarts?: number; startLeavesAgent?: boolean; promptTimesOut?: boolean; promptStalls?: 'pasted' | 'empty'; stallsFor?: number }

export class FakeHerdr {
  calls: string[][] = []
  agents = new Map<string, FakeAgent>()
  tabs = new Set<string>()
  prompts: { target: string; text: string }[] = []
  queued: { thread: string; text: string }[] = []
  screen = ''
  startFails: string | undefined
  startSession: string | undefined
  startStatus: HerdrStatus = 'working'
  busyStarts = 0
  startLeavesAgent = false
  promptTimesOut = false
  // herdr typed the text and answered agent_prompt_stalled: the input holds a paste placeholder ('pasted') or nothing ('empty'), and the agent stays as it was.
  promptStalls: 'pasted' | 'empty' | undefined
  // How many prompts stall (the rest are taken); all of them when unset.
  stallsFor = Infinity
  keys: { target: string; keys: string[] }[] = []
  sendKeysFails = ''
  enterSubmits = true
  queueFails = false
  onStart: ((name: string) => Promise<void>) | undefined
  agentReadFails: boolean | string = false
  paneReadFails = ''
  paneCwds = new Map<string, string>()
  // What `herdr pane get` reports as foreground_cwd; a Claude start with --worktree moves it into the worktree it made.
  foregroundCwds = new Map<string, string>()
  closedPanes = new Set<string>()
  foregroundOverride: string | undefined
  // A Claude that never gets past the folder-trust prompt makes no worktree (DROVE-147).
  claudeSkipsWorktree = false
  claudeWorktrees: { path: string; branch: string }[] = []
  claudeWorktreeFrom = 'HEAD'
  private counter = 0

  constructor(options: FakeHerdrOptions = {}) {
    this.screen = options.screen ?? ''
    this.startFails = options.startFails
    this.startSession = options.startSession
    this.startStatus = options.startStatus ?? 'working'
    this.busyStarts = options.busyStarts ?? 0
    this.startLeavesAgent = options.startLeavesAgent ?? false
    this.promptTimesOut = options.promptTimesOut ?? false
    this.promptStalls = options.promptStalls
    this.stallsFor = options.stallsFor ?? Infinity
    this.agentReadFails = options.agentReadFails ?? false
    this.paneReadFails = options.paneReadFails ?? ''
  }

  exec: Exec = async argv => {
    this.calls.push([...argv])
    const [bin, group, action] = argv
    if (group === '--version' && bin === 'claude') return result('2.1.296 (Claude Code)')
    if (group === '--version' && bin === 'codex') return result('codex-cli 0.162.0')
    if (bin === 'git') return nodeExec(argv)
    if (bin === 'codex' && group === 'queue') return this.codexQueue(argv)
    if (bin !== 'herdr') return result('', 127, `unexpected ${bin}`)
    if (this.serverDown) return result('', 1, 'herdr: cannot reach the server (connect ENOENT /tmp/herdr.sock): server is not running')
    if (group === 'workspace') return this.workspace(action, argv)
    if (group === 'tab') return this.tab(action, argv)
    if (group === 'pane') return this.pane(action, argv)
    if (group === 'agent') return this.agent(action, argv)
    return herdrFail('unknown_command')
  }

  herdrCalls = (): string[] => this.calls.filter(call => call[0] === 'herdr').map(call => call.slice(1, 3).join(' '))
  find = (...parts: string[]): string[] | undefined => this.calls.find(call => parts.every((part, index) => call[index] === part))
  // A seat name resolves to its agent whether herdr holds it under the bare name or `<seat>-<run tag>`.
  seatAgent = (seat: string): FakeAgent | undefined =>
    this.agents.get(seat) ?? [...this.agents.values()].find(agent => agent.paneId === seat || (agent.name.startsWith(`${seat}-`) && /^[0-9a-f]{4}$/.test(agent.name.slice(seat.length + 1))))
  setStatus = (seat: string, status: HerdrStatus) => {
    const agent = this.seatAgent(seat)
    if (agent) agent.status = status
  }

  private json = (value: unknown): ExecResult => result(JSON.stringify(value))

  // A herdr whose server is not running: every call fails the way the CLI does when it cannot reach the socket.
  serverDown = false
  workspaces = new Set<string>()

  private workspace(action: string | undefined, argv: readonly string[]): ExecResult {
    if (action === 'list') return this.json({ result: { workspaces: [...this.workspaces].map(workspace_id => ({ workspace_id })) } })
    if (action === 'create') {
      const id = ++this.counter
      const workspace = `w${this.workspaces.size + 2}`
      const tabId = `${workspace}:t${id}`
      this.workspaces.add(workspace)
      this.tabs.add(tabId)
      this.paneCwds.set(`${workspace}:p${id}`, argv[argv.indexOf('--cwd') + 1] ?? '')
      return this.json({ result: { workspace: { workspace_id: workspace }, tab: { tab_id: tabId }, root_pane: { pane_id: `${workspace}:p${id}` } } })
    }
    if (action === 'close') {
      const workspace = argv[3] ?? ''
      this.workspaces.delete(workspace)
      for (const [name, agent] of this.agents) if (agent.paneId.startsWith(`${workspace}:`)) this.agents.delete(name)
      return this.json({ result: {} })
    }
    return herdrFail('unknown_command')
  }

  private tab(action: string | undefined, argv: readonly string[]): ExecResult {
    if (action === 'create') {
      const id = ++this.counter
      const tabId = `w1:t${id}`
      this.tabs.add(tabId)
      this.paneCwds.set(`w1:p${id}`, argv[argv.indexOf('--cwd') + 1] ?? '')
      return this.json({ result: { tab: { tab_id: tabId }, root_pane: { pane_id: `w1:p${id}` } } })
    }
    const tabId = argv[3] ?? ''
    if (action === 'get') return this.tabs.has(tabId) ? this.json({ result: { tab: { tab_id: tabId } } }) : herdrFail('tab_not_found')
    if (action === 'close') {
      this.tabs.delete(tabId)
      for (const [name, agent] of this.agents) if (agent.tabId === tabId) this.agents.delete(name)
      return this.json({ result: {} })
    }
    return herdrFail('unknown_command')
  }

  private pane(action: string | undefined, argv: readonly string[]): ExecResult {
    if (action === 'split') {
      const id = ++this.counter
      this.paneCwds.set(`w1:p${id}`, argv[argv.indexOf('--cwd') + 1] ?? '')
      return this.json({ result: { pane: { pane_id: `w1:p${id}` } } })
    }
    if (action === 'close') {
      const paneId = argv[3] ?? ''
      this.closedPanes.add(paneId)
      for (const [name, agent] of this.agents) if (agent.paneId === paneId) this.agents.delete(name)
      return this.json({ result: {} })
    }
    if (action === 'get') {
      const paneId = argv[3] ?? ''
      if (this.closedPanes.has(paneId) || !this.paneCwds.has(paneId)) return herdrFail('pane_not_found')
      const cwd = this.paneCwds.get(paneId) ?? ''
      return this.json({ result: { pane: { pane_id: paneId, cwd, foreground_cwd: this.foregroundOverride ?? this.foregroundCwds.get(paneId) ?? cwd } } })
    }
    if (action === 'read') return this.paneReadFails ? herdrFail(this.paneReadFails) : this.json({ result: { text: this.screen } })
    return herdrFail('unknown_command')
  }

  private lookup = (target: string): FakeAgent | undefined => this.agents.get(target) ?? [...this.agents.values()].find(agent => agent.paneId === target)

  private wire = (agent: FakeAgent) => ({
    agent: agent.kind ?? 'claude',
    ...(agent.sessionId ? { agent_session: { value: agent.sessionId } } : {}),
    agent_status: agent.status,
    name: agent.name,
    pane_id: agent.paneId,
    tab_id: agent.tabId,
    terminal_title_stripped: agent.name,
  })

  private async agent(action: string | undefined, argv: readonly string[]): Promise<ExecResult> {
    const target = argv[3] ?? ''
    if (action === 'list') return this.json({ result: { agents: [...this.agents.values()].map(this.wire) } })
    if (action === 'get') {
      const agent = this.lookup(target)
      return agent ? this.json({ result: { agent: this.wire(agent) } }) : herdrFail('agent_not_found')
    }
    if (action === 'read') return this.agentReadFails ? herdrFail(typeof this.agentReadFails === 'string' ? this.agentReadFails : 'agent_not_found') : this.json({ result: { text: this.screen } })
    if (action === 'start') return this.start(argv)
    if (action === 'send-keys') {
      const agent = this.lookup(target)
      if (!agent) return herdrFail('agent_not_found')
      if (this.sendKeysFails) return herdrFail(this.sendKeysFails)
      this.keys.push({ target, keys: argv.slice(4) })
      if (this.enterSubmits) agent.status = 'working'
      return this.json({ result: {} })
    }
    if (action === 'prompt') {
      const agent = this.lookup(target)
      if (!agent) return herdrFail('agent_not_found')
      if (agent.status === 'blocked') return herdrFail('agent_blocked')
      const text = argv[4] ?? ''
      this.prompts.push({ target, text })
      if (this.promptStalls && this.stallsFor > 0 && text !== '/exit' && text !== '/quit') {
        this.stallsFor -= 1
        this.screen = this.promptStalls === 'pasted' ? '● Ready\n\n──────\n❯ [Pasted text #1 +70 lines]\n──────\n  ? for shortcuts' : '● Ready\n\n──────\n❯ \n──────\n  ? for shortcuts'
        return herdrFail('agent_prompt_stalled', 'herdr typed the text but saw no activity')
      }
      if (text === '/exit' || text === '/quit') this.agents.delete(agent.name)
      else agent.status = 'working'
      return this.promptTimesOut && text !== '/exit' && text !== '/quit' ? herdrFail('timeout') : this.json({ result: {} })
    }
    return herdrFail('unknown_command')
  }

  private async start(argv: readonly string[]): Promise<ExecResult> {
    if (this.busyStarts > 0) {
      this.busyStarts -= 1
      return herdrFail('agent_pane_busy')
    }
    const name = argv[3] ?? ''
    const paneId = argv[argv.indexOf('--pane') + 1] ?? ''
    const holder = this.agents.get(name)
    if (holder && holder.paneId !== paneId) return herdrFail('agent_name_taken', `an agent named ${name} is already live in ${holder.paneId}`)
    if (argv.slice(argv.indexOf('--') + 1).some(arg => UNSAFE_AGENT_ARG.test(arg))) return herdrFail('invalid_agent_argument', 'agent arguments cannot be encoded safely for the target shell')
    if (this.startFails) {
      if (this.startFails === 'agent_not_ready') this.agents.set(name, { name, paneId, tabId: `w1:t${this.counter}`, status: 'blocked' })
      else if (this.startLeavesAgent) this.agents.set(name, { name, paneId, tabId: `w1:t${this.counter}`, status: this.startStatus, kind: argv[argv.indexOf('--kind') + 1] ?? 'claude' })
      // A Claude that got past startup made its worktree even though herdr's start failed; one at the trust prompt has not.
      const isPastStartup = this.startLeavesAgent ? this.startStatus !== 'blocked' : /Claude Code v\d/.test(this.screen)
      if (isPastStartup && !/trust/i.test(this.screen)) await this.claudeCreatesWorktree(paneId, argv)
      return herdrFail(this.startFails)
    }
    const tabId = [...this.tabs].at(-1) ?? 'w1:t1'
    await this.onStart?.(name)
    const failure = await this.claudeCreatesWorktree(paneId, argv)
    if (failure) return failure
    this.agents.set(name, { name, paneId, tabId, status: this.startStatus, kind: argv[argv.indexOf('--kind') + 1] ?? 'claude', ...(this.startSession ? { sessionId: this.startSession } : {}) })
    return this.json({ result: { agent: this.wire(this.agents.get(name) as FakeAgent) } })
  }

  private async claudeCreatesWorktree(paneId: string, argv: readonly string[]): Promise<ExecResult | undefined> {
    const flag = argv.indexOf('--worktree')
    if (flag < 0 || this.claudeSkipsWorktree) return undefined
    const name = argv[flag + 1] ?? ''
    const cwd = this.paneCwds.get(paneId) ?? ''
    const path = join(cwd, '.claude', 'worktrees', name)
    const branch = `worktree-${name}`
    if (!existsSync(path)) {
      const added = await nodeExec(['git', '-C', cwd, 'worktree', 'add', '--no-track', '-b', branch, path, this.claudeWorktreeFrom])
      if (added.code !== 0) return herdrFail('agent_start_failed', added.stderr)
    }
    this.claudeWorktrees.push({ path, branch })
    this.foregroundCwds.set(paneId, path)
    return undefined
  }

  private codexQueue(argv: readonly string[]): ExecResult {
    if (this.queueFails) return result('', 1, 'Error: No active session found')
    this.queued.push({ thread: argv[argv.indexOf('--thread') + 1] ?? '', text: argv[argv.indexOf('--message') + 1] ?? '' })
    return result('Queued message abc for thread t.')
  }
}

export const RUN = 'drove-20261009-1042-a3f1'

export const makeRun = (repo: string, overrides: Partial<RunMeta> = {}): RunMeta => ({
  v: 1,
  id: RUN,
  repo,
  base: 'main',
  hasRemote: false,
  createdAt: '2026-10-09T09:00:00.000Z',
  status: 'up',
  budget: 5,
  planner: { kind: 'claude', paneId: 'w1:p0', sessionId: 'planner-session', model: 'claude-opus-5-5', effort: 'high', viaMod: false },
  ...overrides,
})

export const makeSeat = (name: string, overrides: Partial<Seat> = {}): Seat => ({
  name,
  kind: 'claude',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  paneId: `w1:p-${name}`,
  worktree: `/repo/.claude/worktrees/${name}`,
  branch: `drove/${name}`,
  state: 'idle',
  stateAt: '2026-10-09T09:30:00.000Z',
  spawnedAt: '2026-10-09T09:10:00.000Z',
  owes: 'none',
  attention: [],
  ...overrides,
})

export const seedRun = async (deps: Deps, repo: string, seats: Seat[] = [], overrides: Partial<RunMeta> = {}): Promise<RunMeta> => {
  const run = makeRun(repo, overrides)
  await saveRun(deps.home, run)
  await updateRoster(deps.home, run.id, roster => ({ ...roster, seats }))
  for (const seat of seats) {
    await mkdir(seatDir(deps.home, run.id, seat.name), { recursive: true })
    await writeToken(join(seatDir(deps.home, run.id, seat.name), 'token'), `token-${seat.name}`)
  }
  return run
}

// codexUserHome points at an empty folder, so no test reads the real ~/.codex.
export const makeDeps = async (fake: FakeHerdr, prefix = 'deps'): Promise<Deps & { clock: ReturnType<typeof makeClock> }> => ({
  exec: fake.exec,
  clock: makeClock(),
  home: await tmp(prefix),
  codexUserHome: await tmp(`${prefix}-codex-user`),
})

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
}
Object.assign(process.env, GIT_ENV)

export const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const ran = await nodeExec(['git', '-C', cwd, ...args])
  assert.equal(ran.code, 0, `git ${args.join(' ')}: ${ran.stderr}`)
  return ran.stdout.trim()
}

export const makeRepo = async (prefix = 'repo'): Promise<string> => {
  const repo = await tmp(prefix)
  await git(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'README.md'), 'hello\n')
  await git(repo, 'add', 'README.md')
  await git(repo, 'commit', '-q', '-m', 'init')
  return repo
}
