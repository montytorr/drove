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

export type FakeAgent = { name: string; paneId: string; tabId: string; status: HerdrStatus; sessionId?: string }

export type FakeHerdrOptions = { git?: boolean; startFails?: string; screen?: string; startSession?: string; startStatus?: HerdrStatus; busyStarts?: number }

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
  queueFails = false
  private counter = 0

  constructor(options: FakeHerdrOptions = {}) {
    this.screen = options.screen ?? ''
    this.startFails = options.startFails
    this.startSession = options.startSession
    this.startStatus = options.startStatus ?? 'working'
    this.busyStarts = options.busyStarts ?? 0
  }

  exec: Exec = async argv => {
    this.calls.push([...argv])
    const [bin, group, action] = argv
    if (bin === 'git') return nodeExec(argv)
    if (bin === 'codex' && group === 'queue') return this.codexQueue(argv)
    if (bin !== 'herdr') return result('', 127, `unexpected ${bin}`)
    if (group === 'tab') return this.tab(action, argv)
    if (group === 'pane') return this.pane(action, argv)
    if (group === 'agent') return this.agent(action, argv)
    return herdrFail('unknown_command')
  }

  herdrCalls = (): string[] => this.calls.filter(call => call[0] === 'herdr').map(call => call.slice(1, 3).join(' '))
  find = (...parts: string[]): string[] | undefined => this.calls.find(call => parts.every((part, index) => call[index] === part))
  setStatus = (name: string, status: HerdrStatus) => {
    const agent = this.agents.get(name)
    if (agent) agent.status = status
  }

  private json = (value: unknown): ExecResult => result(JSON.stringify(value))

  private tab(action: string | undefined, argv: readonly string[]): ExecResult {
    if (action === 'create') {
      const id = ++this.counter
      const tabId = `w1:t${id}`
      this.tabs.add(tabId)
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
      return this.json({ result: { pane: { pane_id: `w1:p${id}` } } })
    }
    if (action === 'close') {
      const paneId = argv[3] ?? ''
      for (const [name, agent] of this.agents) if (agent.paneId === paneId) this.agents.delete(name)
      return this.json({ result: {} })
    }
    return herdrFail('unknown_command')
  }

  private lookup = (target: string): FakeAgent | undefined => this.agents.get(target) ?? [...this.agents.values()].find(agent => agent.paneId === target)

  private wire = (agent: FakeAgent) => ({
    agent: 'claude',
    ...(agent.sessionId ? { agent_session: { value: agent.sessionId } } : {}),
    agent_status: agent.status,
    name: agent.name,
    pane_id: agent.paneId,
    tab_id: agent.tabId,
    terminal_title_stripped: agent.name,
  })

  private agent(action: string | undefined, argv: readonly string[]): ExecResult {
    const target = argv[3] ?? ''
    if (action === 'list') return this.json({ result: { agents: [...this.agents.values()].map(this.wire) } })
    if (action === 'get') {
      const agent = this.lookup(target)
      return agent ? this.json({ result: { agent: this.wire(agent) } }) : herdrFail('agent_not_found')
    }
    if (action === 'read') return this.json({ result: { text: this.screen } })
    if (action === 'start') return this.start(argv)
    if (action === 'prompt') {
      const agent = this.lookup(target)
      if (!agent) return herdrFail('agent_not_found')
      if (agent.status === 'blocked') return herdrFail('agent_blocked')
      const text = argv[4] ?? ''
      this.prompts.push({ target, text })
      if (text === '/exit' || text === '/quit') this.agents.delete(agent.name)
      else agent.status = 'working'
      return this.json({ result: {} })
    }
    return herdrFail('unknown_command')
  }

  private start(argv: readonly string[]): ExecResult {
    if (this.busyStarts > 0) {
      this.busyStarts -= 1
      return herdrFail('agent_pane_busy')
    }
    const name = argv[3] ?? ''
    const paneId = argv[argv.indexOf('--pane') + 1] ?? ''
    if (this.startFails) {
      if (this.startFails === 'agent_not_ready') this.agents.set(name, { name, paneId, tabId: `w1:t${this.counter}`, status: 'blocked' })
      return herdrFail(this.startFails)
    }
    const tabId = [...this.tabs].at(-1) ?? 'w1:t1'
    this.agents.set(name, { name, paneId, tabId, status: this.startStatus, ...(this.startSession ? { sessionId: this.startSession } : {}) })
    return this.json({ result: { agent: this.wire(this.agents.get(name) as FakeAgent) } })
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

export const makeDeps = async (fake: FakeHerdr, prefix = 'deps'): Promise<Deps & { clock: ReturnType<typeof makeClock> }> => ({
  exec: fake.exec,
  clock: makeClock(),
  home: await tmp(prefix),
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
