import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../src/cli.ts'
import { runHook } from '../src/hooks.ts'
import { formatControl, macOf } from '../src/protocol.ts'
import type { Control } from '../src/types.ts'
import { setup } from './p4-helpers.ts'

// The mod's pure helpers run here against Drove's own code: its HMAC against node:crypto, its guard input
// against the real hook, and its parsers against what the real CLI prints. They are loaded by path so the
// repo's type-check (src, test) does not take in the mod, which is typed against Claude Code's plugin API.

type Ran = { exitCode: number; stdout: string; stderr: string }
type ModProtocol = {
  macOf: (token: string, id: string, body: string) => Promise<string>
  parseEnvelope: (text: string) => { fields: Record<string, string>; body: string; reply?: string } | undefined
  verifyEnvelope: (envelope: { fields: Record<string, string>; body: string }, token: string | undefined) => Promise<boolean>
}
type ModDrove = {
  guardStdin: (tool: string, input: Record<string, unknown>, cwd: string, sessionId: string) => string
  guardVerdictOf: (ran: Ran, entry: string) => { allow: true } | { allow: false; reason: string }
  failureOf: (ran: Ran) => { code: string; text: string }
  jsonResultOf: <T>(ran: Ran) => { ok: true; text: string; data?: T } | { ok: false; code: string; text: string }
  attachArgs: (input: { sessionId: string; paneId?: string; goal?: string; model: string; effort: string; budget?: number; run?: string }) => string[]
}

const load = async <T>(file: string): Promise<T> => (await import(new URL(`../mod/hooks/${file}`, import.meta.url).href)) as T

const capture = async (argv: string[], stdin = ''): Promise<Ran> => {
  let stdout = ''
  let stderr = ''
  const exitCode = await main(argv, { out: text => void (stdout += `${text}\n`), err: text => void (stderr += `${text}\n`), stdin: async () => stdin })
  return { exitCode, stdout, stderr }
}

test("the mod's HMAC on crypto.subtle.digest matches Drove's mac for every control", async () => {
  const mod = await load<ModProtocol>('protocol.ts')
  const cases = [
    ['tok', 'c-1', 'Approved.\n\nShip it'],
    ['a'.repeat(64), 'c-kq3-9f0a', 'x'],
    ['b'.repeat(65), 'c-2', 'ünïcødé ⟦ ⟧ and\nnew lines'],
    ['3f'.repeat(32), 'c-3', ''],
  ] as const
  for (const [token, id, body] of cases) assert.equal(await mod.macOf(token, id, body), macOf(token, id, body), `mac for ${id}`)
  const control: Control = { v: 1, id: 'c-9', run: 'r-1', from: 'planner', to: 'w-api', kind: 'promote', expects: 'none', model: 'claude-opus-5-5', effort: 'high', body: 'Promoted.\n\nCarry on.', at: 'x' }
  const parsed = mod.parseEnvelope(formatControl(control, 'seat-token'))
  assert.equal(parsed?.body, 'Promoted.\n\nCarry on.')
  assert.equal(parsed?.fields.model, 'claude-opus-5-5')
  assert.equal(await mod.verifyEnvelope(parsed!, 'seat-token'), true)
  assert.equal(await mod.verifyEnvelope(parsed!, 'other-token'), false)
})

test("the mod's guard input is read by Drove's real hook, and its verdicts parsed back", async () => {
  const mod = await load<ModDrove>('drove.ts')
  const ctx = await setup({ planner: { kind: 'claude', viaMod: true, sessionId: 's-1' } })
  const env = { DROVE_HOME: ctx.home, DROVE_RUN: ctx.run.id, DROVE_ROLE: 'planner', DROVE_SEAT: 'planner' }
  const decide = async (tool: string, input: Record<string, unknown>) => {
    const result = await runHook('pre-tool-use', mod.guardStdin(tool, { tool, tool_use_id: 't', ...input }, '/Users/cal/repo', 's-1'), env)
    return mod.guardVerdictOf({ exitCode: result.code, stdout: result.stdout, stderr: result.stderr }, '/x/src/cli.ts')
  }
  assert.deepEqual(await decide('Bash', { command: 'git status' }), { allow: true })
  assert.deepEqual(await decide('Bash', { command: "cairn add \"t\" --body - <<'EOF'\n<ref> and `herdr pane split`\nEOF" }), { allow: true })
  const denied = await decide('Bash', { command: 'npm test' })
  assert.equal(denied.allow, false)
  assert.match(denied.allow ? '' : denied.reason, /^Drove planner:/)
  const edit = await decide('Edit', { file_path: '/Users/cal/repo/src/a.ts', old_string: 'a', new_string: 'b' })
  assert.equal(edit.allow, false)
})

test("the mod reads what the real CLI prints: attach's JSON and a command's failure code", async () => {
  const mod = await load<ModDrove>('drove.ts')
  const home = await mkdtemp(join(tmpdir(), 'drove-mod-cli-'))
  const repo = await mkdtemp(join(tmpdir(), 'drove-mod-cli-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  const saved = { home: process.env.DROVE_HOME, cwd: process.cwd() }
  process.env.DROVE_HOME = home
  process.chdir(repo)
  try {
    const attached = mod.jsonResultOf<{ run: { id: string; planner: { viaMod: boolean } } }>(await capture(mod.attachArgs({ sessionId: 's-1', paneId: 'w1:p1', model: 'claude-opus-5-5', effort: 'high', budget: 5 })))
    assert.equal(attached.ok, true)
    assert.equal(attached.ok && attached.data?.run.planner.viaMod, true)
    const failed = await capture(['close', 'w-none'])
    assert.equal(failed.exitCode, 1)
    assert.equal(mod.failureOf(failed).code, 'no-seat')
    const usage = mod.jsonResultOf(await capture(['mod', 'attach']))
    assert.equal(usage.ok, false)
  } finally {
    process.chdir(saved.cwd)
    if (saved.home === undefined) delete process.env.DROVE_HOME
    else process.env.DROVE_HOME = saved.home
  }
})
