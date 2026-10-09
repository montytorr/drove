import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as prompts from '../src/prompts.ts'
import type { DroveConfig, RunMeta, Seat } from '../src/types.ts'

const config: DroveConfig = {
  humanName: 'Cal',
  plannerModel: { claude: 'claude-opus-5-5', codex: 'gpt-5' },
  plannerEffort: 'high',
  workerModel: { claude: 'claude-sonnet-5-5', codex: 'gpt-5' },
  workerEffort: 'medium',
  promotedModel: { claude: 'claude-opus-5-5', codex: 'gpt-5' },
  budget: 5,
  codexBypassHookTrust: false,
  claudeChannel: false,
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
    assert.match(text, /Cal started this session as the planner of Drove run drove-20261009-1042-a3f1 for this goal: ship P1/)
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

test('worker role covers rules, cairn, questions and reporting', () => {
  const text = prompts.workerRole(seat, run, config)
  assert.match(text, /worker `w-api` of Drove run drove-20261009-1042-a3f1/)
  assert.match(text, /Never push\./)
  assert.match(text, /cairn claim <ref>/)
  assert.match(text, /`for: human` when only Cal can decide/)
  assert.match(text, /`done`/)
  assert.match(text, /`progress`/)
  assert.doesNotMatch(text, /mcp__orchestrator__|\bcal\b/)
})

test('brief footer names the seat and the cairn task', () => {
  assert.match(prompts.briefFooter('w-api', 'DROVE-7'), /worker `w-api`\. Your Cairn task is DROVE-7: claim it first\. Report with the drove report tool/)
  assert.doesNotMatch(prompts.briefFooter('w-api'), /Cairn task/)
})

test('canned control texts', () => {
  assert.match(prompts.approvedText(), /^Approved\. Commit only your own paths/)
  assert.match(prompts.approvedText(), /Do not push/)
  assert.match(prompts.approvedText(), /expects none/)
  assert.match(prompts.nudgeText(), /done, question or blocked/)
  assert.match(prompts.resumedText(), /Resumed by Drove/)
})
