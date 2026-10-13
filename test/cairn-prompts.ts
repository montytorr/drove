import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CONFIG } from '../src/commands.ts'
import * as prompts from '../src/prompts.ts'
import type { DroveConfig, HostAgents, RunMeta } from '../src/types.ts'

// The prompts a run renders, by case, for the Cairn-present snapshot (DROVE-159): test/fixtures/cairn-on-prompts.json was
// rendered from main before Cairn became optional, so with Cairn present every text must stay byte-identical.

// Typed by hand: the typecheck covers src and test, and the mod's file does not compile under it.
type ModPrompts = {
  orchestratorSection: (state: { run: string; repo: string; goal?: string; startedAt: number; budget: number }, config: { workerModel: string; promotedModel: string; humanName: string; trims?: object; agents?: HostAgents; useCairn?: boolean }) => string
  kindRulesSection: (human: string, agents?: HostAgents, workerKind?: 'auto' | 'claude' | 'codex', cairn?: boolean) => string
}

// The mod's prompts file has extensionless imports, which node cannot load: a copy with its import made absolute can.
export const loadModPrompts = async (): Promise<ModPrompts> => {
  const source = await readFile(new URL('../mod/hooks/prompts.ts', import.meta.url), 'utf8')
  const protocol = pathToFileURL(new URL('../mod/hooks/protocol.ts', import.meta.url).pathname).href
  const dir = await mkdtemp(join(tmpdir(), 'drove-mod-prompts-'))
  const file = join(dir, 'prompts.ts')
  await writeFile(file, source.replace("from './protocol'", `from '${protocol}'`))
  return import(pathToFileURL(file).href) as Promise<ModPrompts>
}

const BOTH: HostAgents = { at: '2026-10-13T09:00:00.000Z', claude: { version: '2.1.296' }, codex: { version: '0.162.0', model: 'gpt-5.5-codex' } }
const CLAUDE_ONLY: HostAgents = { at: '2026-10-13T09:00:00.000Z', claude: { version: '2.1.296' } }

const baseRun = (overrides: Partial<RunMeta> = {}): RunMeta => ({
  v: 1, id: 'repo-20261013-0900-abcd', repo: '/work/repo', base: 'main', hasRemote: true, createdAt: '2026-10-13T09:00:00.000Z', status: 'up', budget: 5,
  planner: { kind: 'claude', paneId: 'w1:p1', model: 'claude-opus-5-5', effort: 'high', viaMod: false },
  ...overrides,
})

const CONFIG: DroveConfig = { ...DEFAULT_CONFIG, humanName: 'Sam' }
const TRIMS = { mcp: ['drove', 'github'], plugins: ['drove'], skills: ['cairn'], agents: ['debugger'] }

// `cairnOn` sets the run's useCairn for every case; left out, the runs carry none, as one saved before DROVE-159.
export const renderPrompts = async (cairnOn?: Partial<RunMeta>): Promise<Record<string, string>> => {
  const mod = await loadModPrompts()
  const runs: Record<string, RunMeta> = {
    goal: baseRun({ goal: 'ship the widget', agents: BOTH, ...cairnOn }),
    task: baseRun({ goal: 'DROVE-5: ship it', cairn: 'DROVE-5', agents: CLAUDE_ONLY, ...cairnOn }),
    lab: baseRun({ goal: 'LAB-3: try it', cairn: 'LAB-3', ...cairnOn }),
  }
  const out: Record<string, string> = {}
  for (const [name, run] of Object.entries(runs)) {
    for (const kind of ['claude', 'codex'] as const) out[`planner.${name}.${kind}`] = prompts.plannerRole(run, CONFIG, kind, TRIMS)
    for (const role of ['implementer', 'reviewer', 'tester'] as const) out[`worker.${name}.${role}`] = prompts.workerRole(run, CONFIG, role)
    out[`mod.orchestrator.${name}`] = mod.orchestratorSection({ run: run.id, repo: run.repo, goal: run.goal, startedAt: 0, budget: run.budget }, { workerModel: CONFIG.workerModel.claude, promotedModel: CONFIG.promotedModel.claude, humanName: 'Sam', trims: { ...TRIMS, workerKind: 'auto' }, agents: run.agents, ...(run.useCairn !== undefined ? { useCairn: run.useCairn } : {}) })
    out[`mod.kindRules.${name}`] = mod.kindRulesSection('Sam', run.agents)
  }
  out['footer.cairn'] = prompts.briefFooter('w-api', 'DROVE-5', { branch: 'worktree-w-api', verify: ['npm test'] })
  out['footer.none'] = prompts.briefFooter('w-api', undefined, { branch: 'worktree-w-api', verify: ['npm test'] })
  out['goal.cairn'] = prompts.cairnGoalPrompt('DROVE-5', 'Ship it', 'The body.', ['kind:codex'], BOTH)
  out['goal.lab'] = prompts.labSubjectPrompt({ ref: 'LAB-3', title: 'Try it', body: 'Why.', todos: [{ ref: 'LAB-4', title: 'first', status: 'todo' }] }, 'croft')
  return out
}
