import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main } from '../src/cli.ts'
import { atLeast, CLAUDE_MIN, formatReport, runDoctor, type DoctorDeps } from '../src/doctor.ts'
import type { ExecResult } from '../src/types.ts'

const OK = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' })
const MISSING: ExecResult = { code: 127, stdout: '', stderr: 'spawn ENOENT' }
const FAIL = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr })

const healthy: Record<string, ExecResult> = {
  'git --version': OK('git version 2.50.0'),
  'git rev-parse --is-inside-work-tree': OK('true\n'),
  'git remote': OK('origin\n'),
  'herdr --version': OK('herdr 0.9.0'),
  'herdr workspace list': OK('{"result":{"workspaces":[]}}'),
  'claude --version': OK(`${CLAUDE_MIN} (Claude Code)`),
  'codex --version': OK('codex-cli 0.162.0'),
  'gh --version': OK('gh version 2.76.1'),
  'gh auth status': OK('Logged in'),
  'cairn --version': OK('cairn 0.22.3'),
  'cairn projects': OK('DROVE'),
}

const depsWith = (overrides: Record<string, ExecResult> = {}, extra: Partial<DoctorDeps> = {}): DoctorDeps => {
  const table = { ...healthy, ...overrides }
  return {
    exec: async argv => {
      const key = argv.join(' ')
      const hit = Object.keys(table).find(known => key === known || key.startsWith(`${known} `))
      return hit ? (table[hit] as ExecResult) : MISSING
    },
    cwd: '/repo',
    home: '/home/me/.drove',
    claudeSettings: '/none',
    nodeVersion: 'v22.18.0',
    isWritable: async () => true,
    readText: async () => undefined,
    userHome: '/home/me',
    modDir: '/drove/mod',
    envPluginDirs: '/drove/mod',
    realpath: async path => path,
    ...extra,
  }
}

const statusOf = (checks: { id: string; status: string }[], id: string) => checks.find(item => item.id === id)?.status

// A config.json in Drove's home with this cairn setting (DROVE-159).
const withCairnSetting = (deps: DoctorDeps, cairn: unknown): DoctorDeps => ({ ...deps, readText: async path => (path === `${deps.home}/config.json` ? JSON.stringify({ cairn }) : deps.readText(path)) })

test('a healthy machine is ready and every check is ok', async () => {
  const report = await runDoctor(depsWith())
  assert.equal(report.ok, true)
  assert.ok(report.checks.every(item => item.status === 'ok'), JSON.stringify(report.checks))
  assert.match(formatReport(report), /ready$/)
})

test('version comparison is numeric', () => {
  assert.equal(atLeast('22.18.0', '22.18.0'), true)
  assert.equal(atLeast('22.9.0', '22.18.0'), false)
  assert.equal(atLeast('23.0.0', '22.18.0'), true)
})

test('node too old fails with a fix', async () => {
  const report = await runDoctor(depsWith({}, { nodeVersion: 'v20.11.0' }))
  assert.equal(report.ok, false)
  const node = report.checks.find(item => item.id === 'node')
  assert.equal(node?.status, 'fail')
  assert.match(node?.fix ?? '', /22\.18/)
})

test('git missing fails; not a repo and no remote only warn', async () => {
  assert.equal(statusOf((await runDoctor(depsWith({ 'git --version': MISSING }))).checks, 'git'), 'fail')
  const notRepo = await runDoctor(depsWith({ 'git rev-parse --is-inside-work-tree': FAIL('not a git repository') }))
  assert.equal(statusOf(notRepo.checks, 'repo'), 'warn')
  assert.equal(notRepo.ok, true)
  const noRemote = await runDoctor(depsWith({ 'git remote': OK('') }))
  assert.equal(statusOf(noRemote.checks, 'repo'), 'warn')
})

test('herdr missing and herdr server down both fail, and the server is only listed, never started', async () => {
  assert.equal(statusOf((await runDoctor(depsWith({ 'herdr --version': MISSING }))).checks, 'herdr'), 'fail')
  const calls: string[] = []
  const base = depsWith({ 'herdr workspace list': FAIL('no server at /tmp/herdr.sock') })
  const down = await runDoctor({ ...base, exec: async (argv, options) => (calls.push(argv.join(' ')), base.exec(argv, options)) })
  assert.equal(statusOf(down.checks, 'herdr-server'), 'fail')
  assert.equal(down.ok, false)
  assert.ok(!calls.some(call => /herdr (server|workspace create|agent start)/.test(call)), calls.join('\n'))
})

test('claude too old fails; one agent missing warns; both missing fails', async () => {
  const old = await runDoctor(depsWith({ 'claude --version': OK('2.0.1 (Claude Code)') }))
  assert.equal(statusOf(old.checks, 'claude'), 'fail')
  const codexOnly = await runDoctor(depsWith({ 'claude --version': MISSING }))
  assert.equal(statusOf(codexOnly.checks, 'claude'), 'warn')
  assert.equal(codexOnly.ok, true)
  const claudeOnly = await runDoctor(depsWith({ 'codex --version': MISSING }))
  assert.equal(statusOf(claudeOnly.checks, 'codex'), 'warn')
  const none = await runDoctor(depsWith({ 'claude --version': MISSING, 'codex --version': MISSING }))
  assert.equal(none.ok, false)
  assert.equal(statusOf(none.checks, 'claude'), 'fail')
  assert.equal(statusOf(none.checks, 'codex'), 'fail')
})

test('a CLI that exits successfully with an unreadable version is on PATH in doctor diagnostics', async () => {
  for (const kind of ['claude', 'codex'] as const) {
    const calls: string[] = []
    const base = depsWith({ [`${kind} --version`]: OK('version unavailable') })
    const report = await runDoctor({ ...base, exec: async (argv, options) => { calls.push(argv.join(' ')); return base.exec(argv, options) } })
    const check = report.checks.find(item => item.id === kind)
    assert.equal(check?.detail, `${kind} is on PATH but its version could not be read`)
    assert.equal(calls.filter(call => call === `${kind} --version`).length, 1)
    assert.equal(check?.status, kind === 'claude' ? 'fail' : 'warn')
  }
})

test('gh missing or signed out warns, never fails', async () => {
  assert.equal(statusOf((await runDoctor(depsWith({ 'gh --version': MISSING }))).checks, 'gh'), 'warn')
  const out = await runDoctor(depsWith({ 'gh auth status': FAIL('not logged in') }))
  assert.equal(statusOf(out.checks, 'gh'), 'warn')
  assert.equal(out.ok, true)
})

test('cairn missing or unable to read warns, since Cairn is optional', async () => {
  const missing = await runDoctor(depsWith({ 'cairn --version': MISSING }))
  assert.equal(statusOf(missing.checks, 'cairn'), 'warn')
  assert.equal(missing.ok, true)
  assert.match(missing.checks.find(item => item.id === 'cairn')?.detail ?? '', /optional: task tracking and shared memory/)
  const unread = await runDoctor(depsWith({ 'cairn projects': FAIL('401 unauthorized') }))
  assert.equal(statusOf(unread.checks, 'cairn'), 'warn')
  assert.match(unread.checks.find(item => item.id === 'cairn')?.detail ?? '', /401/)
})

test('DROVE_HOME: the nearest existing parent decides', async () => {
  const created = await runDoctor(depsWith({}, { isWritable: async path => path === '/home/me' }))
  assert.equal(statusOf(created.checks, 'drove-home'), 'ok')
  const blocked = await runDoctor(depsWith({}, { isWritable: async () => false }))
  assert.equal(statusOf(blocked.checks, 'drove-home'), 'fail')
})

test("the mod's nodePath is checked only when the mod is installed", async () => {
  assert.equal(statusOf((await runDoctor(depsWith())).checks, 'mod-node'), undefined)
  const settings = (nodePath?: string) =>
    JSON.stringify({ enabledPlugins: { 'orchestrator@drove': true }, pluginConfigs: { 'orchestrator@drove': { options: nodePath ? { nodePath } : {} } } })
  const withMod = (text: string, exec: Record<string, ExecResult>) => runDoctor(depsWith(exec, { claudeSettings: '/s', readText: async path => path === '/s' ? text : undefined }))
  assert.equal(statusOf((await withMod(settings(), { 'node --version': OK('v22.18.0') })).checks, 'mod-node'), 'ok')
  assert.equal(statusOf((await withMod(settings('/opt/node'), { '/opt/node --version': OK('v20.1.0') })).checks, 'mod-node'), 'fail')
  const broken = await withMod('{not json', {})
  assert.equal(statusOf(broken.checks, 'mod-node'), 'warn')
  assert.match(broken.checks.find(item => item.id === 'mod-node')?.detail ?? '', /nodePath not checked \(could not read the mod's options\)/)
  assert.equal(broken.ok, true)
  const gone = await withMod(settings('/nope/node'), {})
  assert.equal(statusOf(gone.checks, 'mod-node'), 'fail')
  assert.equal(gone.ok, false)
})

test('AC6: with no mod entry the mod check warns and names drove setup mod', async () => {
  const report = await runDoctor(depsWith({}, { envPluginDirs: undefined }))
  const mod = report.checks.find(item => item.id === 'mod')
  assert.equal(mod?.status, 'warn')
  assert.match(mod?.fix ?? '', /drove setup mod/)
  assert.equal(report.ok, true)
  assert.match(formatReport(report), /fix: run drove setup mod/)
})

test('the mod check reads the settings env (with ~) and the process env, and warns on another clone', async () => {
  const settings = (dirs: string) => JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: dirs } })
  const files = (dirs: string, extra: Record<string, string> = {}) => ({ claudeSettings: '/s', envPluginDirs: undefined, readText: async (path: string) => ({ '/s': settings(dirs), ...extra })[path] })
  const fromSettings = await runDoctor(depsWith({}, { ...files('/a/plugin:~/drove/mod'), modDir: '/home/me/drove/mod' }))
  assert.equal(statusOf(fromSettings.checks, 'mod'), 'ok')
  assert.match(fromSettings.checks.find(item => item.id === 'mod')?.detail ?? '', /~\/drove\/mod \(CLAUDE_CODE_PLUGIN_DIRS in \/s\)/)
  const linked = await runDoctor(depsWith({}, { ...files('/link/mod'), realpath: async path => (path === '/link/mod' ? '/drove/mod' : path) }))
  assert.equal(statusOf(linked.checks, 'mod'), 'ok')
  const fromEnv = await runDoctor(depsWith({}, { envPluginDirs: '/x:/drove/mod' }))
  assert.match(fromEnv.checks.find(item => item.id === 'mod')?.detail ?? '', /process env/)
  const other = await runDoctor(depsWith({}, files('/old/drove/mod', { '/old/drove/mod/.claude-plugin/plugin.json': '{"name":"orchestrator"}' })))
  const otherCheck = other.checks.find(item => item.id === 'mod')
  assert.equal(otherCheck?.status, 'warn')
  assert.match(otherCheck?.detail ?? '', /another clone: \/old\/drove\/mod/)
  assert.match(otherCheck?.fix ?? '', /drove setup mod/)
})

test('a failed report prints the fix lines and a count', async () => {
  const report = await runDoctor(withCairnSetting(depsWith({ 'cairn --version': MISSING }), 'on'))
  assert.equal(report.ok, false)
  assert.match(formatReport(report), /fix: .*cairn setup/)
  assert.match(formatReport(report), /1 failed/)
})

test('drove doctor --json prints one report and exits 1 exactly when it did not pass', async () => {
  const out: string[] = []
  const code = await main(['doctor', '--json'], { out: text => out.push(text), err: () => undefined, stdin: async () => '' })
  const report = JSON.parse(out.join('\n')) as { ok: boolean; checks: unknown[] }
  assert.equal(code, report.ok ? 0 : 1)
  assert.ok(report.checks.length > 0)
})

test('spawn policy is checked at the git root and rejects empty choices from a subdirectory', async () => {
  const report = await runDoctor(depsWith({ 'git rev-parse --show-toplevel': OK('/repo\n') }, {
    cwd: '/repo/subdir',
    exec: async argv => argv.includes('--show-toplevel') ? OK('/repo\n') : depsWith().exec(argv),
    readText: async path => path === '/repo/.drove.json' ? JSON.stringify({ spawnPolicy: { model: { choice: [] } } }) : undefined,
  }))
  const policy = report.checks.find(item => item.id === 'spawn-policy')
  assert.equal(policy?.status, 'fail'); assert.match(policy!.detail, /non-empty/)
})


test('doctor Cairn calls choose a detected host runtime and name the missing-key workaround (DROVE-160)', async () => {
  const previous = process.env.CAIRN_AGENT
  delete process.env.CAIRN_AGENT
  try {
    for (const [missing, expected] of [
      [[], 'claude-code'], [['claude --version'], 'codex'], [['claude --version', 'codex --version'], undefined],
    ] as const) {
      const base = depsWith(Object.fromEntries(missing.map(command => [command, MISSING])))
      const agents: (string | undefined)[] = []
      const report = await runDoctor({ ...base, exec: async (argv, options) => {
        if (argv[0] === 'cairn') {
          agents.push(options?.env?.CAIRN_AGENT)
          if (argv[1] === 'projects') return FAIL('CAIRN_API_KEY is not set')
        }
        return base.exec(argv, options)
      } })
      assert.deepEqual(agents, [expected, expected])
      assert.match(report.checks.find(check => check.id === 'cairn')?.detail ?? '', /set CAIRN_AGENT=claude-code or codex/)
    }
  } finally {
    if (previous === undefined) delete process.env.CAIRN_AGENT
    else process.env.CAIRN_AGENT = previous
  }
})

test('AC5: no cairn and no cairn setting: the cairn check is warn and the report is ok', async () => {
  const report = await runDoctor(depsWith({ 'cairn --version': MISSING }))
  assert.equal(statusOf(report.checks, 'cairn'), 'warn')
  assert.equal(report.ok, true)
  assert.match(formatReport(report), /^ready, \d+ warnings?$/m)
  const auto = await runDoctor(withCairnSetting(depsWith({ 'cairn --version': MISSING }), 'auto'))
  assert.equal(statusOf(auto.checks, 'cairn'), 'warn')
})

test('the cairn setting on makes a missing or unreadable cairn fail', async () => {
  const missing = await runDoctor(withCairnSetting(depsWith({ 'cairn --version': MISSING }), 'on'))
  assert.equal(statusOf(missing.checks, 'cairn'), 'fail')
  assert.equal(missing.ok, false)
  assert.match(missing.checks.find(item => item.id === 'cairn')?.detail ?? '', /the cairn setting is on/)
  assert.equal(statusOf((await runDoctor(withCairnSetting(depsWith({ 'cairn projects': FAIL('401') }), 'on'))).checks, 'cairn'), 'fail')
  assert.equal(statusOf((await runDoctor(withCairnSetting(depsWith(), 'on'))).checks, 'cairn'), 'ok')
})

test('the cairn setting off is ok and never runs cairn; a bad value counts as auto and says so', async () => {
  const calls: string[] = []
  const base = withCairnSetting(depsWith(), 'off')
  const report = await runDoctor({ ...base, exec: async (argv, options) => (calls.push(argv.join(' ')), base.exec(argv, options)) })
  assert.equal(statusOf(report.checks, 'cairn'), 'ok')
  assert.match(report.checks.find(item => item.id === 'cairn')?.detail ?? '', /off/)
  assert.deepEqual(calls.filter(call => call.startsWith('cairn')), [])
  const bad = await runDoctor(withCairnSetting(depsWith(), 'yes'))
  assert.equal(statusOf(bad.checks, 'cairn'), 'warn')
  assert.match(bad.checks.find(item => item.id === 'cairn')?.detail ?? '', /"yes" is not auto, on or off/)
})
