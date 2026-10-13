import assert from 'node:assert/strict'
import { test } from 'node:test'
import { saveRun } from '../src/roster.ts'
import { CLAIM_BEAT_EVERY_MS, defaultToolPorts, plannerTools } from '../src/tools.ts'
import type { ToolPorts } from '../src/tools.ts'
import type { ExecResult } from '../src/types.ts'
import { setup } from './p4-helpers.ts'

const reply = { ok: true as const, text: 'roster lines' }
const ports: ToolPorts = { ...defaultToolPorts, commands: { ...defaultToolPorts.commands, roster: async () => reply } }

const plannerWith = async (cairn: string | undefined, respond?: (argv: readonly string[]) => Partial<ExecResult>) => {
  const ctx = await setup({ respond })
  if (cairn) await saveRun(ctx.home, { ...ctx.run, cairn })
  const identity = { home: ctx.home, run: ctx.run.id, role: 'planner' as const, seat: 'planner' }
  const roster = plannerTools(ctx.deps, identity, ports).find(tool => tool.name === 'roster')!
  const beats = () => ctx.calls.filter(argv => argv.includes('beat'))
  return { ctx, roster, beats }
}

test('the first planner tool call beats the run\'s Cairn task (DROVE-143)', async () => {
  const { roster, beats } = await plannerWith('DROVE-9')
  assert.deepEqual(await roster.call({}), { text: 'roster lines' })
  assert.deepEqual(beats(), [['cairn', 'beat', 'DROVE-9']])
})

test('a second call within 10 minutes sends no beat; one after 10 minutes does', async () => {
  const { ctx, roster, beats } = await plannerWith('DROVE-9')
  await roster.call({})
  ctx.clock.advance(CLAIM_BEAT_EVERY_MS - 1)
  await roster.call({})
  assert.equal(beats().length, 1)
  ctx.clock.advance(1)
  await roster.call({})
  assert.equal(beats().length, 2)
})

test('a failing or throwing beat leaves the tool result unchanged', async () => {
  const failing = await plannerWith('DROVE-9', argv => (argv.includes('beat') ? { code: 1, stderr: 'cairn: unreachable' } : {}))
  assert.deepEqual(await failing.roster.call({}), { text: 'roster lines' })
  assert.equal(failing.beats().length, 1)

  const ctx = await setup()
  await saveRun(ctx.home, { ...ctx.run, cairn: 'DROVE-9' })
  const deps = { ...ctx.deps, exec: async () => { throw new Error('timed out after 5000ms') } }
  const roster = plannerTools(deps, { home: ctx.home, run: ctx.run.id, role: 'planner', seat: 'planner' }, ports).find(tool => tool.name === 'roster')!
  assert.deepEqual(await roster.call({}), { text: 'roster lines' })
})

test('two planner tool calls at once send one beat', async () => {
  const { roster, beats } = await plannerWith('DROVE-9')
  await Promise.all([roster.call({}), roster.call({})])
  assert.equal(beats().length, 1)
})

test('a run with no Cairn ref sends no beat', async () => {
  const { ctx, roster, beats } = await plannerWith(undefined)
  await roster.call({})
  ctx.clock.advance(CLAIM_BEAT_EVERY_MS)
  await roster.call({})
  assert.deepEqual(beats(), [])
})

test('a Lab ref sends no beat: a subject holds no claim', async () => {
  const { ctx, roster, beats } = await plannerWith('LAB-21')
  await roster.call({})
  ctx.clock.advance(CLAIM_BEAT_EVERY_MS)
  await roster.call({})
  assert.deepEqual(beats(), [])
})


test('claim beats use the run planner kind and preserve CAIRN_AGENT (DROVE-160)', async () => {
  const previous = process.env.CAIRN_AGENT
  try {
    for (const [kind, explicit, expected] of [
      ['claude', undefined, 'claude-code'], ['codex', undefined, 'codex'], ['claude', 'maintenance', 'maintenance'],
    ] as const) {
      if (explicit === undefined) delete process.env.CAIRN_AGENT
      else process.env.CAIRN_AGENT = explicit
      const ctx = await setup()
      await saveRun(ctx.home, { ...ctx.run, cairn: 'DROVE-160', planner: { ...ctx.run.planner, kind } })
      let agent: string | undefined
      const base = ctx.deps.exec
      const deps = { ...ctx.deps, exec: async (argv: readonly string[], options?: import('../src/types.ts').ExecOptions) => {
        if (argv[0] === 'cairn') agent = options?.env?.CAIRN_AGENT
        return base(argv, options)
      } }
      const roster = plannerTools(deps, { home: ctx.home, run: ctx.run.id, role: 'planner', seat: 'planner' }, ports).find(tool => tool.name === 'roster')!
      assert.deepEqual(await roster.call({}), { text: 'roster lines' })
      assert.equal(agent, expected)
    }
  } finally {
    if (previous === undefined) delete process.env.CAIRN_AGENT
    else process.env.CAIRN_AGENT = previous
  }
})
