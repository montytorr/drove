import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as prompts from '../src/prompts.ts'
import type { DroveConfig, RunMeta, Seat } from '../src/types.ts'

const config: DroveConfig = {
  humanName: 'Sam',
  plannerModel: { claude: 'claude-opus-5-5', codex: 'gpt-5' },
  plannerEffort: 'high',
  workerModel: { claude: 'claude-sonnet-5-5', codex: 'gpt-5' },
  workerEffort: 'medium',
  promotedModel: { claude: 'claude-opus-5-5', codex: 'gpt-5' },
  budget: 5,
  codexBypassHookTrust: false,
  codexWorkerSandbox: 'bypass',
  claudeChannel: false,
  briefVia: 'prompt',
  labInstance: 'croft',
  workerEnv: {},
}

const run: RunMeta = {
  v: 1,
  id: 'drove-20261009-1042-a3f1',
  repo: '/repo',
  base: 'main',
  hasRemote: true,
  createdAt: '2026-10-09T10:42:00.000Z',
  status: 'up',
  goal: 'ship P1',
  budget: 5,
  planner: { kind: 'claude', model: 'claude-opus-5-5', effort: 'high', viaMod: false },
}

const seat: Seat = {
  name: 'w-api',
  kind: 'codex',
  model: 'gpt-5',
  effort: 'medium',
  worktree: '/repo/.claude/worktrees/w-api',
  branch: 'drove/w-api',
  state: 'starting',
  stateAt: '2026-10-09T10:42:00.000Z',
  spawnedAt: '2026-10-09T10:42:00.000Z',
  owes: 'none',
  attention: [],
}

test('planner role uses the configured human and Drove tool names', () => {
  for (const kind of ['claude', 'codex'] as const) {
    const text = prompts.plannerRole(run, config, kind)
    assert.match(text, /Sam started this session as the planner of Drove run drove-20261009-1042-a3f1 for this goal: ship P1/)
    assert.match(text, /up to 5 worker panes/)
    assert.match(text, /drove spawn tool/)
    assert.match(text, /Sonnet 5\.5/)
    assert.doesNotMatch(text, /mcp__orchestrator__|orchestrator mode/)
  }
  assert.match(prompts.plannerRole(run, config, 'claude'), /AskUserQuestion/)
  assert.doesNotMatch(prompts.plannerRole(run, config, 'codex'), /AskUserQuestion/)
})

test('planner role follows the git rules', () => {
  const text = prompts.plannerRole(run, { ...config, humanName: 'the human' }, 'claude')
  assert.match(text, /--no-track/)
  assert.match(text, /never push to a `production` branch/)
  assert.match(text, /the human's git rules/)
})

test('planner role integrates with drove merge, --pr when the repo has a remote with CI, never a plain git merge', () => {
  for (const kind of ['claude', 'codex'] as const) {
    const text = prompts.plannerRole(run, config, kind)
    assert.match(text, /integrate it with the drove merge tool \(`drove merge <seat>`\), never a plain `git merge`/)
    assert.match(text, /it runs the repo's checks in the worker's worktree first and refuses the merge if they fail/)
    assert.match(text, /remote with CI, use `pr: true` \(`drove merge <seat> --pr`/)
    assert.match(text, /"pending" carries the PR URL: call it again later, do not poll/)
    assert.doesNotMatch(text, /commit, merge, rebase/)
  }
  assert.doesNotMatch(prompts.workerRole(run, config), /drove merge/)
})

test('worker role covers rules, cairn, questions and reporting', () => {
  const text = prompts.workerRole(run, config)
  assert.match(text, /You are a worker of Drove run drove-20261009-1042-a3f1/)
  assert.match(text, /Never push\./)
  assert.match(text, /cairn claim <ref>/)
  assert.match(text, /`for: human` when only Sam can decide/)
  assert.match(text, /`done`/)
  assert.match(text, /`progress`/)
  assert.doesNotMatch(text, /mcp__orchestrator__|\bcal\b/)
})

test('worker role says the worker is already on its own branch and must not switch', () => {
  const text = prompts.workerRole(run, config)
  assert.match(text, /already on your own branch \(the brief names it\) in your own worktree\. Commit there\. Do not create, switch or rebase branches unless the planner asks\./)
  assert.doesNotMatch(text, /switch -c/)
  assert.doesNotMatch(prompts.plannerRole(run, config, 'claude'), /branch with --no-track from main/)
})

test('planner files one task per worker with --no-start and never hands over a task it holds', () => {
  const text = prompts.plannerRole(run, config, 'claude')
  assert.match(text, /one Cairn task per piece \(`cairn add [^`]*--no-start/)
  assert.match(text, /Never hand a worker a task you hold yourself/)
})

test('planner role has a Lean spawns section naming the options, the defaults under the config and the names it can pick', () => {
  const open = prompts.plannerRole(run, config, 'claude')
  assert.match(open, /## Lean spawns\nA Claude worker loads, by default: all of Sam's MCP servers and Claude in Chrome; every enabled plugin; all of Sam's own CLAUDE\.md files\./)
  assert.doesNotMatch(open, /Claude servers:|Plugins:/, 'no names unless they were read')

  const lean = prompts.plannerRole(run, { ...config, workerMcp: ['notion'], workerPlugins: [], workerUserMemory: false }, 'codex', { mcp: ['mongodb', 'notion'], codexMcp: [], plugins: ['context7'] })
  assert.match(lean, /by default: only notion of Sam's MCP servers, and no Claude in Chrome unless it is listed; only Drove's own mod; none of Sam's own CLAUDE\.md files\./)
  assert.match(lean, /Claude servers: mongodb, notion\./)
  assert.match(lean, /Codex servers: none found\./)
  assert.match(lean, /Plugins: context7\./)
  assert.match(lean, /`mcp: \["claude-in-chrome"\]`.*`userMemory: true`.*fully lean/)
  assert.match(lean, /A Codex worker takes `mcp` and follows workerUserMemory only\./)
})

test('the Lean spawns names are the planner\'s only: the worker role is untouched by them', () => {
  assert.doesNotMatch(prompts.workerRole(run, config), /Lean spawns|claude-in-chrome/)
  assert.equal(prompts.workerRole(run, { ...config, workerMcp: ['notion'], workerPlugins: ['x'], workerUserMemory: false }), prompts.workerRole(run, config))
})

test('worker reports a refused claim once', () => {
  assert.match(prompts.workerRole(run, config), /claim is refused[^.]*send one `blocked` report[^.]*do not repeat it/)
})

test('brief footer names the seat and the cairn task', () => {
  assert.match(prompts.briefFooter('w-api', 'DROVE-7'), /worker `w-api`\. Your Cairn task is DROVE-7: claim it first\. Report with the drove report tool/)
  assert.doesNotMatch(prompts.briefFooter('w-api'), /Cairn task/)
})

test('the worker role is the same text for every seat of a run, so the prompt prefix caches', () => {
  assert.equal(prompts.workerRole(run, config), prompts.workerRole({ ...run }, { ...config }))
  assert.doesNotMatch(prompts.workerRole(run, config), new RegExp(`${seat.name}|${seat.branch}`))
})

test('brief footer names the branch and the verify commands, on one line', () => {
  const footer = prompts.briefFooter('w-api', 'DROVE-7', { branch: 'worktree-w-api', verify: ['npm run typecheck', 'npm test'] })
  assert.match(footer, /\(You are worker `w-api` on branch `worktree-w-api`\. Your Cairn task is DROVE-7: claim it first\. Verify with `npm run typecheck`, `npm test`\. Report with the drove report tool/)
  assert.ok(!footer.trimStart().includes('\n'))
  assert.doesNotMatch(prompts.briefFooter('w-api', undefined, { verify: [] }), /Verify/)
})

test('verifyCommands reads package.json scripts with the repo package manager, or else Makefile targets', () => {
  const scripts = JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest', typecheck: 'tsc', build: 'tsc -b' } })
  assert.deepEqual(prompts.verifyCommands({ packageJson: scripts }), ['npm run typecheck', 'npm run lint', 'npm test'])
  assert.deepEqual(prompts.verifyCommands({ packageJson: scripts, lockfiles: ['yarn.lock'] }), ['yarn typecheck', 'yarn lint', 'yarn test'])
  assert.deepEqual(prompts.verifyCommands({ packageJson: JSON.stringify({ packageManager: 'pnpm@9.1.0', scripts: { test: 'x' } }) }), ['pnpm test'])
  assert.deepEqual(prompts.verifyCommands({ packageJson: scripts, lockfiles: ['bun.lock'] }), ['bun run typecheck', 'bun run lint', 'bun run test'])
  const makefile = 'VAR := 1\nbuild:\n\tgo build\ntest: build\n\tgo test ./...\nlint:\n\tgolangci-lint run\n'
  assert.deepEqual(prompts.verifyCommands({ packageJson: '{"scripts":{"build":"x"}}', makefile }), ['make lint', 'make test'])
  assert.deepEqual(prompts.verifyCommands({ packageJson: 'not json' }), [])
  assert.deepEqual(prompts.verifyCommands({}), [])
})

test('canned control texts', () => {
  assert.match(prompts.approvedText(), /^Approved\. Commit only your own paths/)
  assert.match(prompts.approvedText(), /Do not push/)
  assert.match(prompts.approvedText(), /expects none/)
  assert.match(prompts.nudgeText(), /done, question or blocked/)
  assert.match(prompts.resumedText(), /Resumed by Drove/)
})
