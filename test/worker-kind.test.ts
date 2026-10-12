import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelLabelOf } from '../src/agents.ts'
import { modelOf } from '../src/board.ts'
import * as prompts from '../src/prompts.ts'
import * as tools from '../src/tools.ts'
import type { Deps, DroveConfig, HostAgents, Identity, Roster, RunMeta, Seat } from '../src/types.ts'
import { payloadOf } from '../src/web.ts'

const BOTH: HostAgents = { at: '2026-10-12T10:00:00.000Z', claude: { version: '2.1.296' }, codex: { version: '0.162.0', model: 'gpt-6.1-sol', effort: 'high' } }
const CLAUDE_ONLY: HostAgents = { at: BOTH.at, claude: { version: '2.1.296' } }
const CODEX_ONLY: HostAgents = { at: BOTH.at, codex: BOTH.codex }

const config = (workerKind?: DroveConfig['workerKind']): DroveConfig => ({
  humanName: 'Sam',
  workerKind,
  workerModel: { claude: 'claude-sonnet-5-5', codex: '' },
  promotedModel: { claude: 'claude-opus-5-5', codex: '' },
} as DroveConfig)

const run = (agents?: HostAgents, plannerKind: 'claude' | 'codex' = 'claude'): RunMeta => ({
  v: 1,
  id: 'drove-20261012-1000-a3f1',
  repo: '/repo',
  base: 'main',
  hasRemote: false,
  createdAt: '2026-10-12T10:00:00.000Z',
  status: 'up',
  goal: 'ship',
  budget: 4,
  planner: { kind: plannerKind, model: plannerKind === 'codex' ? '' : 'claude-opus-5-5', effort: 'high', viaMod: false },
  ...(agents ? { agents } : {}),
})

const section = (text: string): string => /## Claude or Codex for a worker\n[\s\S]*?(?=\n\n## )/.exec(text)?.[0] ?? ''
const rulesOf = (agents: HostAgents | undefined, plannerKind: 'claude' | 'codex' = 'claude', workerKind?: DroveConfig['workerKind']): string =>
  section(prompts.plannerRole(run(agents, plannerKind), config(workerKind), plannerKind))

test('both kinds on the host: the CLI planner text has the rules and the label hint, in about 8 lines', () => {
  const text = rulesOf(BOTH)
  assert.match(text, /^## Claude or Codex for a worker\nBoth are on this host\./)
  assert.match(text, /Codex \(gpt-6\.1-sol\): a self-contained implementation with clear acceptance tests \(backend, algorithms, refactors, test suites\), and long mechanical work/)
  assert.match(text, /the reviewer of a Claude worker's branch \(and Claude for a Codex worker's\), so a review comes from another model/)
  assert.match(text, /more than 2 or 3 workers, or after a seat of the other kind hit a usage limit \(the drove migrate tool moves it\)/)
  assert.match(text, /Claude: UI and visual work that needs a Chrome check; work that relies on Sam's skills, MCP servers, plugins or agents \(a Codex seat ignores those trims\); anything that needs a back-and-forth with Sam/)
  assert.match(text, /A Cairn task labelled `kind:codex` or `kind:claude` asks for that kind\./)
  assert.ok(text.split('\n').length <= 8)
})

test('a run with no detection reads as both kinds, and does not invent a codex model', () => {
  const text = rulesOf(undefined)
  assert.match(text, /^## Claude or Codex for a worker\nBoth are on this host\./)
  assert.match(text, /- Codex: a self-contained implementation/)
  assert.doesNotMatch(text, /gpt-/)
})

test('one kind on the host: one line naming it, and no rules', () => {
  assert.equal(rulesOf(CLAUDE_ONLY), '## Claude or Codex for a worker\nOnly Claude is on this host, so every worker is Claude.')
  assert.equal(rulesOf(CODEX_ONLY, 'codex'), '## Claude or Codex for a worker\nOnly Codex is on this host, so every worker is Codex (gpt-6.1-sol).')
  assert.doesNotMatch(rulesOf(CLAUDE_ONLY), /kind:codex|UI and visual/)
  // The planner's own kind is always present, even when its probe failed.
  assert.match(rulesOf(CLAUDE_ONLY, 'codex'), /^## Claude or Codex for a worker\nBoth are on this host\./)
  assert.deepEqual(prompts.kindsOn(undefined, 'claude'), ['claude', 'codex'])
  assert.deepEqual(prompts.kindsOn(CODEX_ONLY, 'codex'), ['codex'])
  assert.deepEqual(prompts.kindsOn(CODEX_ONLY, 'claude'), ['claude', 'codex'])
})

test('workerKind words the default: auto says claude, claude or codex says it is the default and the rules are the exceptions', () => {
  assert.match(rulesOf(BOTH, 'claude', 'auto'), /left out, it is claude \(the workerKind setting is auto, which picks claude when it is there\)/)
  assert.match(rulesOf(BOTH), /the workerKind setting is auto/)
  assert.match(rulesOf(BOTH, 'claude', 'codex'), /left out, it is codex: the workerKind setting makes codex the default, and these rules are the exceptions/)
  assert.match(rulesOf(BOTH, 'codex', 'claude'), /left out, it is claude: the workerKind setting makes claude the default, and these rules are the exceptions/)
})

test('the planner text no longer calls a Claude worker the default for every spawn, and points to the rules', () => {
  const text = prompts.plannerRole(run(BOTH), config(), 'claude')
  assert.match(text, /a Claude worker runs Sonnet 5\.5 by default; see Claude or Codex for a worker, below/)
  assert.doesNotMatch(text, /one worker per piece, Sonnet 5\.5 by default/)
})

const identity: Identity = { home: '/h', run: 'r1', role: 'planner', seat: 'planner' }
const spawnTool = (seen: unknown[] = []) => {
  const ports: tools.ToolPorts = {
    ...tools.defaultToolPorts,
    commands: { ...tools.defaultToolPorts.commands, spawn: async (_deps, _identity, request) => { seen.push(request); return { ok: true, text: 'ok' } } },
  }
  const found = tools.plannerTools({ home: '/h' } as Deps, identity, ports).find(tool => tool.name === 'spawn')
  assert.ok(found)
  return found
}

test('the CLI planner spawn tool does not require kind, and passes none on when none is given', async () => {
  const seen: Array<{ kind?: string }> = []
  const tool = spawnTool(seen)
  assert.deepEqual((tool.inputSchema as { required: string[] }).required, ['seat', 'brief'])
  await tool.call({ seat: 'w-api', brief: 'x' })
  await tool.call({ seat: 'w-db', kind: 'codex', brief: 'x' })
  assert.equal('kind' in (seen[0] ?? {}), false)
  assert.equal(seen[1]?.kind, 'codex')
  const refused = await tool.call({ seat: 'w-z', kind: 'gemini', brief: 'x' })
  assert.equal(refused.isError, true)
  assert.equal(seen.length, 2)
})

test('the CLI planner tool descriptions follow workerKind and point to the rules, not to a claude default', () => {
  const spawn = spawnTool()
  const kindProp = (spawn.inputSchema as { properties: { kind: { description: string } } }).properties.kind
  assert.match(spawn.description, /kind is optional, and left out it follows the workerKind setting \(see "Claude or Codex for a worker"/)
  assert.doesNotMatch(spawn.description + kindProp.description, /default, Sonnet|claude \(default\)/)
  assert.match(kindProp.description, /^Optional: claude or codex\. Left out, the workerKind setting decides; the rules for choosing are in your instructions/)
  const migrate = tools.plannerTools({ home: '/h' } as Deps, identity, tools.defaultToolPorts).find(tool => tool.name === 'migrate')
  assert.match(migrate?.description ?? '', /"Claude or Codex for a worker"/)
})

test('modelLabelOf: the explicit model, else the detected codex model, else nothing', () => {
  assert.equal(modelLabelOf('codex', 'gpt-5', BOTH), 'gpt-5')
  assert.equal(modelLabelOf('codex', '', BOTH), 'gpt-6.1-sol')
  assert.equal(modelLabelOf('codex', '', CLAUDE_ONLY), '')
  assert.equal(modelLabelOf('codex', '', undefined), '')
  assert.equal(modelLabelOf('claude', '', BOTH), '')
  assert.equal(modelLabelOf('claude', 'claude-sonnet-5-5', BOTH), 'claude-sonnet-5-5')
})

const seat = (overrides: Partial<Seat> & Pick<Seat, 'name'>): Seat => ({
  kind: 'codex',
  model: '',
  effort: 'medium',
  worktree: `/tmp/wt/${overrides.name}`,
  branch: `drove/${overrides.name}`,
  state: 'working',
  stateAt: '2026-10-12T10:30:00.000Z',
  spawnedAt: '2026-10-12T10:00:00.000Z',
  owes: 'none',
  attention: [],
  ...overrides,
})

const dataOf = (agents?: HostAgents, plannerKind: 'claude' | 'codex' = 'claude') => {
  const roster: Roster = { v: 1, run: 'r1', updatedAt: '2026-10-12T10:31:00.000Z', seats: [seat({ name: 'w-default' }), seat({ name: 'w-pinned', model: 'gpt-5' }), seat({ name: 'w-claude', kind: 'claude', model: 'claude-sonnet-5-5' })] }
  return { run: run(agents, plannerKind), roster, status: {}, feed: [], bridgeHeld: false }
}

const NOW = Date.parse('2026-10-12T10:42:00.000Z')

test('the web payload labels a default Codex seat with the detected model, and keeps the stored model empty', () => {
  const labels = (agents?: HostAgents) => Object.fromEntries(payloadOf(dataOf(agents), NOW, 0).seats.map(({ name, model, modelLabel }) => [name, { model, modelLabel }]))
  assert.deepEqual(labels(BOTH), {
    'w-default': { model: '', modelLabel: 'gpt-6.1-sol' },
    'w-pinned': { model: 'gpt-5', modelLabel: 'gpt-5' },
    'w-claude': { model: 'claude-sonnet-5-5', modelLabel: 'Sonnet 5.5' },
  })
  assert.equal(labels(undefined)['w-default']?.modelLabel, 'default')
  assert.equal(labels(CLAUDE_ONLY)['w-default']?.modelLabel, 'default')
  assert.equal(payloadOf(dataOf(BOTH, 'codex'), NOW, 0).lead.modelLabel, 'gpt-6.1-sol')
})

test('the board model cell of a default Codex seat starts with the detected model', () => {
  const cells = (agents?: HostAgents) => {
    const model = modelOf({ ...dataOf(agents), now: NOW, frame: 0, columns: 120, rows: 30, offsetMinutes: 0 })
    return Object.fromEntries(model.workers.map(row => [row.key, row.cells.map(({ text }) => text).find(text => /^(codex|gpt|Sonnet)/.test(text)) ?? '']))
  }
  assert.equal(cells(BOTH)['w:w-default'], 'gpt-6.1-…')
  assert.equal(cells(BOTH)['w:w-pinned'], 'gpt-5·m')
  assert.equal(cells(undefined)['w:w-default'], 'codex·m')
})
