import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectAgents, modelLabelOf, type AgentDeps } from '../src/agents.ts'
import type { ExecResult } from '../src/types.ts'

const at = '2026-10-12T10:00:00.000Z'
const result = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: '' })
const depsWith = (config?: string, overrides: Record<string, ExecResult> = {}): AgentDeps => ({
  exec: async argv => overrides[argv[0] as string] ?? result(argv[0] === 'claude' ? '2.1.296 (Claude Code)' : 'codex-cli 0.162.0'),
  readText: async () => config,
  home: '/user', env: {}, now: () => new Date(at),
})

test('detectAgents probes both CLIs in parallel and reads top-level Codex defaults', async () => {
  const calls: string[][] = []
  const reads: string[] = []
  let release: () => void = () => undefined
  const pending = new Promise<void>(resolve => { release = resolve })
  const deps = depsWith('model = "gpt-6.1-sol" # default\nmodel_reasoning_effort = \'high\'\n[profiles.other]\nmodel = "other"\nmodel_reasoning_effort = "low"')
  const detection = detectAgents({ ...deps,
    exec: async (argv, options) => {
      calls.push([...argv])
      assert.equal(options?.timeoutMs, 10_000)
      await pending
      return deps.exec(argv, options)
    },
    readText: async path => { reads.push(path); return deps.readText(path) },
  })
  assert.deepEqual(calls, [['claude', '--version'], ['codex', '--version']])
  release()
  assert.deepEqual(await detection, { at, claude: { version: '2.1.296' }, codex: { version: '0.162.0', model: 'gpt-6.1-sol', effort: 'high' } })
  assert.deepEqual(reads, ['/user/.codex/config.toml'])
})

test('missing, failed and unparseable versions are absent, even when a failed probe prints a version', async () => {
  for (const missing of [result('', 127), result('codex-cli 0.162.0', 1), result('unknown')]) {
    const agents = await detectAgents(depsWith('model = "gpt-6.1-sol"', { codex: missing }))
    assert.equal(agents.codex, undefined)
    assert.deepEqual(agents.claude, { version: '2.1.296' })
  }
  const onlyCodex = await detectAgents(depsWith(undefined, { claude: result('', 127) }))
  assert.equal(onlyCodex.claude, undefined)
  assert.deepEqual(onlyCodex.codex, { version: '0.162.0' })
  const throws = await detectAgents({ ...depsWith(), exec: async () => { throw new Error('ENOENT') } })
  assert.deepEqual(throws, { at })
})

test('missing, unreadable and model-free config keep Codex present without inventing a model', async () => {
  for (const config of [undefined, '', '# model = "comment"\n[profiles.fast]\nmodel = "profile"', 'model = false', 'model = ""']) {
    assert.deepEqual((await detectAgents(depsWith(config))).codex, { version: '0.162.0' })
  }
  const agents = await detectAgents({ ...depsWith(), readText: async () => { throw new Error('EACCES') } })
  assert.deepEqual(agents.codex, { version: '0.162.0' })
  assert.deepEqual((await detectAgents(depsWith('model_reasoning_effort = "high"'))).codex, { version: '0.162.0', effort: 'high' })
})

test('CODEX_HOME and an injected Codex home select the config path, and empty CODEX_HOME uses the default', async () => {
  for (const [codexHome, envHome, expected] of [[undefined, '/custom', '/custom/config.toml'], ['/injected', '/custom', '/injected/config.toml'], [undefined, '', '/user/.codex/config.toml']] as const) {
    const reads: string[] = []
    await detectAgents({ ...depsWith(), env: { CODEX_HOME: envHome }, codexHome, readText: async path => { reads.push(path); return 'model = "custom"' } })
    assert.deepEqual(reads, [expected])
  }
})

test('the selected Codex profile overrides model and effort independently, with root defaults for missing keys', async () => {
  const root = 'profile = "work"\nmodel = "root-model"\nmodel_reasoning_effort = "medium"\n'
  for (const [profile, expected] of [
    ['model = "profile-model"\nmodel_reasoning_effort = "high"', { model: 'profile-model', effort: 'high' }],
    ['model = \'profile-model\'', { model: 'profile-model', effort: 'medium' }],
    ['model_reasoning_effort = "low"', { model: 'root-model', effort: 'low' }],
    ['', { model: 'root-model', effort: 'medium' }],
  ] as const) {
    const config = `${root}[profiles.other]\nmodel = "ignored"\n[profiles.work]\n${profile}\n[mcp_servers.other]\nmodel = "ignored-again"\n`
    assert.deepEqual((await detectAgents(depsWith(config))).codex, { version: '0.162.0', ...expected })
  }
  assert.deepEqual((await detectAgents(depsWith(`${root}[profiles.other]\nmodel = "ignored"`))).codex, { version: '0.162.0', model: 'root-model', effort: 'medium' })
})

test('profile headers can quote names, and nested or unrelated tables do not override them', async () => {
  const config = 'profile = "work.fast"\nmodel = "root"\n[ profiles . "work.fast" ] # selected\nmodel = "selected"\n[profiles."work.fast".nested]\nmodel = "nested"\n[profiles.work]\nmodel = "other"\n'
  assert.deepEqual((await detectAgents(depsWith(config))).codex, { version: '0.162.0', model: 'selected' })
})

test('modelLabelOf falls back only for a default Codex model, keeping legacy labels and explicit overrides', () => {
  const agents = { at, codex: { version: '0.162.0', model: 'gpt-6.1-sol' } }
  assert.equal(modelLabelOf('codex', '', agents), 'gpt-6.1-sol')
  assert.equal(modelLabelOf('codex', 'override', agents), 'override')
  assert.equal(modelLabelOf('claude', '', agents), '')
  assert.equal(modelLabelOf('codex', ''), '')
  assert.equal(modelLabelOf('codex', '', { at }), '')
})
