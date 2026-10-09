import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as herdr from '../src/herdr.ts'
import type { Exec } from '../src/types.ts'
import { fixture, herdrFail, result } from './p3-helpers.ts'

test('argv builders match the herdr CLI', () => {
  assert.deepEqual(herdr.tabCreateArgv('w1', '/wt', 'workers · drove', { A: '1', B: 'x y' }), [
    'herdr', 'tab', 'create', '--workspace', 'w1', '--cwd', '/wt', '--label', 'workers · drove', '--no-focus', '--env', 'A=1', '--env', 'B=x y',
  ])
  assert.deepEqual(herdr.paneSplitArgv('w1:p1', 'down', '/wt', { A: '1' }), ['herdr', 'pane', 'split', '--pane', 'w1:p1', '--direction', 'down', '--cwd', '/wt', '--no-focus', '--env', 'A=1'])
  assert.deepEqual(herdr.agentStartArgv('w-api', 'codex', 'w1:p2', ['-s', 'workspace-write']), ['herdr', 'agent', 'start', 'w-api', '--kind', 'codex', '--pane', 'w1:p2', '--timeout', '60000', '--', '-s', 'workspace-write'])
  assert.deepEqual(herdr.agentPromptArgv('w-api', 'hi', 5000), ['herdr', 'agent', 'prompt', 'w-api', 'hi', '--wait', '--timeout', '5000'])
  assert.deepEqual(herdr.agentTypeArgv('w-api', '/exit'), ['herdr', 'agent', 'prompt', 'w-api', '/exit'])
  assert.deepEqual(herdr.agentReadArgv('w-api', 40, 'detection'), ['herdr', 'agent', 'read', 'w-api', '--source', 'detection', '--lines', '40'])
  assert.deepEqual(herdr.paneCloseArgv('w1:p2'), ['herdr', 'pane', 'close', 'w1:p2'])
  assert.deepEqual(herdr.tabCloseArgv('w1:t1'), ['herdr', 'tab', 'close', 'w1:t1'])
})

test('parseAgents reads the real agent list shape', () => {
  const agents = herdr.parseAgents(fixture('agent-list.json'))
  assert.equal(agents?.length, 4)
  assert.deepEqual(agents?.[1], { name: 'w-core', paneId: 'w1T:pF', status: 'working', sessionId: '196b963a-f82c-4a36-a453-1f70fb6678d1', title: 'w-core' })
  assert.equal(agents?.[0]?.status, 'blocked')
  assert.equal(agents?.[0]?.name, undefined)
  assert.equal(agents?.[3]?.sessionId, undefined)
  assert.equal(herdr.parseAgents('not json'), undefined)
})

test('parseAgent reads agent get, and maps unknown statuses to unknown', () => {
  const got = herdr.parseAgent(JSON.stringify({ result: { agent: { pane_id: 'w1:p1', agent_status: 'weird', name: 'x' } } }))
  assert.deepEqual(got, { name: 'x', paneId: 'w1:p1', status: 'unknown' })
  assert.equal(herdr.parseAgent('{}'), undefined)
})

test('parseNewPane handles pane split and tab create responses', () => {
  assert.deepEqual(herdr.parseNewPane('{"result":{"pane":{"pane_id":"w1:p9"}}}'), { paneId: 'w1:p9' })
  assert.deepEqual(herdr.parseNewPane('{"result":{"tab":{"tab_id":"w1:t3"},"root_pane":{"pane_id":"w1:p10"}}}\n'), { paneId: 'w1:p10', tabId: 'w1:t3' })
  assert.equal(herdr.parseNewPane('{"error":{"code":"x"}}'), undefined)
})

test('herdrError extracts codes from JSON and from loose text', () => {
  assert.equal(herdr.herdrError('{"error":{"code":"agent_blocked","message":"m"}}'), 'agent_blocked')
  assert.equal(herdr.herdrError('{"result":{}}'), undefined)
  assert.equal(herdr.herdrError('boom: agent_prompt_stalled somewhere'), 'agent_prompt_stalled')
  assert.equal(herdr.herdrError(''), undefined)
})

test('listAgents and getAgent go through exec and surface errors', async () => {
  const exec: Exec = async argv => (argv[2] === 'list' ? result(fixture('agent-list.json')) : herdrFail('agent_not_found'))
  const listed = await herdr.listAgents(exec)
  assert.ok(listed.ok && listed.value.length === 4)
  const missing = await herdr.getAgent(exec, 'ghost')
  assert.deepEqual(missing.ok, false)
  assert.equal(!missing.ok && missing.code, 'agent_not_found')
})

test('retryWhileBusy retries agent_pane_busy and then succeeds', async () => {
  let calls = 0
  const waits: number[] = []
  const exec: Exec = async () => (++calls < 4 ? herdrFail('agent_pane_busy') : result('{"result":{}}'))
  const ran = await herdr.retryWhileBusy(exec, ['herdr', 'agent', 'start'], 45_000, async ms => void waits.push(ms))
  assert.equal(ran.ok, true)
  assert.equal(calls, 4)
  assert.deepEqual(waits, [500, 500, 500])
})

test('retryWhileBusy gives up after the window and does not retry other errors', async () => {
  let calls = 0
  const busy: Exec = async () => (calls++, herdrFail('agent_pane_busy'))
  const gaveUp = await herdr.retryWhileBusy(busy, ['herdr'], 2_000, async () => undefined)
  assert.equal(!gaveUp.ok && gaveUp.code, 'agent_pane_busy')
  assert.equal(calls, 4)
  calls = 0
  const blocked: Exec = async () => (calls++, herdrFail('agent_not_ready'))
  const stopped = await herdr.retryWhileBusy(blocked, ['herdr'], 45_000, async () => undefined)
  assert.equal(!stopped.ok && stopped.code, 'agent_not_ready')
  assert.equal(calls, 1)
})

test('run reports a non-zero exit without a herdr code', async () => {
  const ran = await herdr.run(async () => result('', 127, 'herdr: command not found'), ['herdr', 'agent', 'list'])
  assert.equal(!ran.ok && ran.code, 'exit_127')
})

test('readScreen returns the text field, or the raw output when the shape is unknown', async () => {
  const withText = await herdr.readScreen(async () => result('{"result":{"text":"hello screen"}}'), 'x', 10)
  assert.equal(withText.ok && withText.value, 'hello screen')
  const raw = await herdr.readScreen(async () => result('{"result":{"weird":"Background server has incompatible feature settings"}}'), 'x', 10)
  assert.match(raw.ok ? raw.value : '', /Background server/)
})
