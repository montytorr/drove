import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { seatDir } from '../src/paths.ts'
import { readJsonlFrom } from '../src/store.ts'
import { defaultToolPorts, plannerTools, workerTools, PLANNER_TOOL_NAMES, WORKER_TOOL_NAMES } from '../src/tools.ts'
import type { ToolPorts } from '../src/tools.ts'
import type { CommandResult, Report } from '../src/types.ts'
import { setup } from './p4-helpers.ts'
import { seatOf } from './p4-helpers.ts'
import * as realCommands from '../src/commands.ts'
import { loadRun, updateRoster } from '../src/roster.ts'

const fakeCommands = () => {
  const calls: { name: string; args: unknown[] }[] = []
  const reply: CommandResult = { ok: true, text: 'done' }
  const record = (name: string, skip = 1) => async (...args: unknown[]): Promise<CommandResult> => {
    calls.push({ name, args: args.slice(skip) })
    return reply
  }
  const commands = {
    spawn: record('spawn', 2),
    send: record('send', 2),
    prompt: record('prompt', 2),
    promote: record('promote', 2),
    migrate: record('migrate', 2),
    roster: record('roster'),
    capture: record('capture'),
    close: record('close', 2),
    down: record('down'),
    raiseBudget: record('raiseBudget'),
  } as unknown as ToolPorts['commands']
  return { commands, calls }
}

const outboxOf = async (ctx: Awaited<ReturnType<typeof setup>>, seat = 'w-api') =>
  (await readJsonlFrom<Report>(join(seatDir(ctx.home, ctx.run.id, seat), 'outbox.jsonl'), { offset: 0 })).items

test('the tool name lists match the registered tools', async () => {
  const ctx = await setup()
  const identity = { home: ctx.home, run: ctx.run.id, role: 'planner' as const, seat: 'planner' }
  assert.deepEqual(plannerTools(ctx.deps, identity).map((tool) => tool.name), [...PLANNER_TOOL_NAMES])
  assert.deepEqual(workerTools(ctx.deps, { ...identity, role: 'worker', seat: 'w-api', token: 't' }).map((tool) => tool.name), [...WORKER_TOOL_NAMES])
})

test('report validates, stamps id, run, seat and token, and appends to the seat outbox', async () => {
  const ctx = await setup()
  const identity = { home: ctx.home, run: ctx.run.id, role: 'worker' as const, seat: 'w-api', token: ctx.tokens['w-api'] }
  const [report] = workerTools(ctx.deps, identity)
  const result = await report?.call({ kind: 'done', summary: 'all green', details: 'branch drove/w-api, 12 tests pass' })
  assert.equal(result?.isError, undefined)
  assert.match(result?.text ?? '', /expects review/)
  assert.match(result?.text ?? '', /wait for the planner's verdict/)
  const [line] = await outboxOf(ctx)
  assert.equal(line?.v, 1)
  assert.match(line?.id ?? '', /^r-w-api-\d+-[0-9a-f]{4}$/)
  assert.equal(line?.run, ctx.run.id)
  assert.equal(line?.seat, 'w-api')
  assert.equal(line?.token, 'token-w-api')
  assert.equal(line?.kind, 'done')
  assert.equal(line?.expects, 'review')
  assert.equal(line?.at, ctx.clock.now().toISOString())
})

test('report refuses invalid input and writes nothing', async () => {
  const ctx = await setup()
  const identity = { home: ctx.home, run: ctx.run.id, role: 'worker' as const, seat: 'w-api', token: ctx.tokens['w-api'] }
  const [report] = workerTools(ctx.deps, identity)
  for (const args of [{ kind: 'nope', summary: 'x' }, { kind: 'done' }, { kind: 'done', summary: 'x', expects: 'later' }, { kind: 'done', summary: 'x', for: 'cal' }]) {
    assert.equal((await report?.call(args))?.isError, true, JSON.stringify(args))
  }
  assert.deepEqual(await outboxOf(ctx), [])
})

test('report without a token is an error, and progress tells the worker to keep going', async () => {
  const ctx = await setup()
  const base = { home: ctx.home, run: ctx.run.id, role: 'worker' as const, seat: 'w-api' }
  const noToken = await workerTools(ctx.deps, base)[0]?.call({ kind: 'done', summary: 'x' })
  assert.equal(noToken?.isError, true)
  assert.match(noToken?.text ?? '', /DROVE_TOKEN/)
  const progress = await workerTools(ctx.deps, { ...base, token: 't' })[0]?.call({ kind: 'progress', summary: 'half' })
  assert.match(progress?.text ?? '', /Keep working/)
  const confirm = await workerTools(ctx.deps, { ...base, token: 't' })[0]?.call({ kind: 'done', expects: 'none', summary: 'committed abc123' })
  assert.match(confirm?.text ?? '', /stop now/)
  const question = await workerTools(ctx.deps, { ...base, token: 't' })[0]?.call({ kind: 'question', for: 'human', summary: 'prod?' })
  assert.match(question?.text ?? '', /Do not guess/)
})

test('the report tool description tells the worker what to do after each kind', async () => {
  const ctx = await setup()
  const [report] = workerTools(ctx.deps, { home: ctx.home, run: ctx.run.id, role: 'worker', seat: 'w-api', token: 't' })
  for (const kind of ['done', 'question', 'blocked', 'promote', 'progress']) assert.match(report?.description ?? '', new RegExp(`- ${kind}:`))
  assert.match(report?.description ?? '', /stop and wait/)
  assert.deepEqual((report?.inputSchema as { required: string[] }).required, ['kind', 'summary'])
})

const plannerWith = async (extra: Partial<ToolPorts> = {}) => {
  const ctx = await setup()
  const fake = fakeCommands()
  const identity = { home: ctx.home, run: ctx.run.id, role: 'planner' as const, seat: 'planner' }
  const tools = plannerTools(ctx.deps, identity, { ...defaultToolPorts, commands: fake.commands, ...extra })
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name)
    assert.ok(found, name)
    return found
  }
  return { ctx, fake, tool }
}

test('planner tools map their arguments onto the commands', async () => {
  const { ctx, fake, tool } = await plannerWith()
  await tool('spawn').call({ seat: 'w-ui', kind: 'claude', cairn: 'DROVE-9', brief: 'build it', effort: 'high' })
  await tool('spawn').call({ seat: 'w-db', kind: 'codex', brief: 'migrate', mcp: ['mongodb', ' '] })
  await tool('send').call({ seat: 'w-ui', kind: 'answer', body: 'use postgres', expects: 'none' })
  await tool('verdict').call({ seat: 'w-ui', verdict: 'approve' })
  await tool('verdict').call({ seat: 'w-ui', verdict: 'changes', notes: 'rename x' })
  await tool('prompt').call({ seat: 'w-ui', text: 'hello' })
  await tool('promote').call({ seat: 'w-ui', model: 'opus', effort: 'max', reason: 'hard' })
  await tool('migrate').call({ seat: 'w-ui', kind: 'codex', reason: 'usage limit' })
  await tool('close').call({ seat: 'w-ui', removeWorktree: true })
  await tool('roster').call({ json: true })
  await tool('capture').call({ seat: 'w-ui', lines: 20 })
  await tool('down').call({})
  const ref = { run: ctx.run.id, repo: ctx.run.repo }
  assert.deepEqual(fake.calls, [
    { name: 'spawn', args: [{ seat: 'w-ui', kind: 'claude', brief: 'build it', cairn: 'DROVE-9', model: undefined, effort: 'high', base: undefined }] },
    { name: 'spawn', args: [{ seat: 'w-db', kind: 'codex', brief: 'migrate', cairn: undefined, model: undefined, effort: undefined, base: undefined, mcp: ['mongodb'] }] },
    { name: 'send', args: [{ seat: 'w-ui', kind: 'answer', body: 'use postgres', expects: 'none' }] },
    { name: 'send', args: [{ seat: 'w-ui', kind: 'verdict', verdict: 'approve', body: '', expects: 'none' }] },
    { name: 'send', args: [{ seat: 'w-ui', kind: 'verdict', verdict: 'changes', body: 'rename x', expects: 'review' }] },
    { name: 'prompt', args: ['w-ui', 'hello'] },
    { name: 'promote', args: [{ seat: 'w-ui', model: 'opus', effort: 'max', reason: 'hard' }] },
    { name: 'migrate', args: [{ seat: 'w-ui', kind: 'codex', model: undefined, effort: undefined, reason: 'usage limit' }] },
    { name: 'close', args: ['w-ui', true] },
    { name: 'roster', args: [ref, true] },
    { name: 'capture', args: [ref, 'w-ui', 20] },
    { name: 'down', args: [ref] },
  ])
})

test('the spawn tool passes owns, maxTurns and maxTokens through, and checks their shape', async () => {
  const { fake, tool } = await plannerWith()
  await tool('spawn').call({ seat: 'w-ui', kind: 'claude', brief: 'x', owns: ['src/ui/**', ' ', '{README,DESIGN}.md'], maxTurns: 30, maxTokens: 2_000_000 })
  assert.deepEqual(fake.calls, [
    { name: 'spawn', args: [{ seat: 'w-ui', kind: 'claude', brief: 'x', cairn: undefined, model: undefined, effort: undefined, base: undefined, owns: ['src/ui/**', '{README,DESIGN}.md'], maxTurns: 30, maxTokens: 2_000_000 }] },
  ])
  const schema = tool('spawn').inputSchema as { properties: Record<string, { type: string }> }
  assert.deepEqual([schema.properties.owns?.type, schema.properties.maxTurns?.type, schema.properties.maxTokens?.type], ['array', 'integer', 'integer'])
  for (const args of [{ owns: 'src/**' }, { owns: [1] }, { maxTurns: 0 }, { maxTurns: '5' }, { maxTokens: 1.5 }]) {
    assert.equal((await tool('spawn').call({ seat: 'w-db', kind: 'claude', brief: 'x', ...args })).isError, true, JSON.stringify(args))
  }
  assert.equal(fake.calls.length, 1)
})

test('the spawn tool passes plugins and userMemory through, and says what they do and default to', async () => {
  const { fake, tool } = await plannerWith()
  await tool('spawn').call({ seat: 'w-ui', kind: 'claude', brief: 'x', plugins: ['context7', ' '], userMemory: false })
  await tool('spawn').call({ seat: 'w-db', kind: 'claude', brief: 'x', plugins: [], userMemory: true })
  assert.deepEqual(fake.calls, [
    { name: 'spawn', args: [{ seat: 'w-ui', kind: 'claude', brief: 'x', cairn: undefined, model: undefined, effort: undefined, base: undefined, plugins: ['context7'], userMemory: false }] },
    { name: 'spawn', args: [{ seat: 'w-db', kind: 'claude', brief: 'x', cairn: undefined, model: undefined, effort: undefined, base: undefined, plugins: [], userMemory: true }] },
  ])
  const schema = tool('spawn').inputSchema as { properties: Record<string, { type: string; description: string }> }
  assert.deepEqual([schema.properties.plugins?.type, schema.properties.userMemory?.type], ['array', 'boolean'])
  assert.match(schema.properties.plugins?.description ?? '', /Claude workers only.*Left out.*workerPlugins/)
  assert.match(schema.properties.userMemory?.description ?? '', /Claude workers only.*Left out.*workerUserMemory/)
  for (const args of [{ plugins: 'context7' }, { plugins: [1] }, { userMemory: 'false' }]) {
    assert.equal((await tool('spawn').call({ seat: 'w-x', kind: 'claude', brief: 'x', ...args })).isError, true, JSON.stringify(args))
  }
  assert.equal(fake.calls.length, 2)
})

test('planner tools reject bad arguments before calling a command', async () => {
  const { fake, tool } = await plannerWith()
  const bad: [string, Record<string, unknown>][] = [
    ['spawn', { seat: 'W Bad', kind: 'claude', brief: 'x' }],
    ['spawn', { seat: 'w-ui', kind: 'gemini', brief: 'x' }],
    ['spawn', { seat: 'w-ui', kind: 'claude' }],
    ['spawn', { seat: 'w-ui', kind: 'claude', brief: 'x', mcp: 'mongodb' }],
    ['send', { seat: 'w-ui', kind: 'verdict', body: 'x' }],
    ['verdict', { seat: 'w-ui', verdict: 'changes' }],
    ['verdict', { seat: 'w-ui', verdict: 'maybe' }],
    ['promote', { seat: 'w-ui', model: 'm', effort: 'huge' }],
    ['migrate', { seat: 'w-ui', kind: 'gemini' }],
    ['migrate', { seat: 'w-ui' }],
    ['capture', { seat: 'w-ui', lines: -3 }],
    ['close', { seat: 'w-ui', removeWorktree: 'yes' }],
  ]
  for (const [name, args] of bad) assert.equal((await tool(name).call(args)).isError, true, `${name} ${JSON.stringify(args)}`)
  assert.deepEqual(fake.calls, [])
})

test('a failing command becomes an error result carrying its code', async () => {
  const { ctx } = await plannerWith()
  const failing = { ...fakeCommands().commands, close: async () => ({ ok: false as const, text: 'branch is not merged', code: 'UNMERGED' }) }
  const identity = { home: ctx.home, run: ctx.run.id, role: 'planner' as const, seat: 'planner' }
  const close = plannerTools(ctx.deps, identity, { ...defaultToolPorts, commands: failing }).find((tool) => tool.name === 'close')
  const result = await close?.call({ seat: 'w-api' })
  assert.deepEqual(result, { text: 'branch is not merged [UNMERGED]', isError: true })
})

test('planner tool descriptions tell the model what to do next', async () => {
  const { ctx } = await plannerWith()
  const tools = plannerTools(ctx.deps, { home: ctx.home, run: ctx.run.id, role: 'planner', seat: 'planner' })
  const by = Object.fromEntries(tools.map((tool) => [tool.name, tool.description]))
  assert.match(by.spawn ?? '', /Do NOT wait, poll or sleep/)
  assert.match(by.verdict ?? '', /merge its branch and close the seat/)
  assert.match(by.send ?? '', /do not wait/)
  assert.match(by.close ?? '', /Cairn task/)
})

const fullRoster = async (ctx: Awaited<ReturnType<typeof setup>>) => {
  await updateRoster(ctx.home, ctx.run.id, (roster) => ({ ...roster, seats: ['a', 'b', 'c', 'd', 'e'].map((name) => seatOf(`w-${name}`)) }))
}

test('spawn over budget asks the human through elicitation and raises the budget on yes', async () => {
  const asked: string[] = []
  const { ctx, fake, tool } = await plannerWith({ elicit: async (message) => void asked.push(message) === undefined })
  await fullRoster(ctx)
  const result = await tool('spawn').call({ seat: 'w-six', kind: 'claude', brief: 'x' })
  assert.equal(result.isError, undefined)
  assert.equal(asked.length, 1)
  assert.deepEqual(fake.calls.map((call) => call.name), ['raiseBudget', 'spawn'])
  assert.equal((fake.calls[0]?.args[1]), 6)
})

test('an approved elicitation raises the budget and spawns even with DROVE_ROLE set; a declined one refuses', async () => {
  const saved = process.env.DROVE_ROLE
  process.env.DROVE_ROLE = 'planner'
  try {
    for (const approve of [true, false]) {
      const ctx = await setup()
      await fullRoster(ctx)
      const fake = fakeCommands()
      const commands = { ...fake.commands, raiseBudget: realCommands.raiseBudget }
      const identity = { home: ctx.home, run: ctx.run.id, role: 'planner' as const, seat: 'planner' }
      const tools = plannerTools(ctx.deps, identity, { ...defaultToolPorts, commands, elicit: async () => approve })
      const result = await tools.find((tool) => tool.name === 'spawn')?.call({ seat: 'w-six', kind: 'claude', brief: 'x' })
      assert.equal((await loadRun(ctx.home, ctx.run.id))?.budget, approve ? 6 : 5)
      assert.equal(result?.isError, approve ? undefined : true)
      assert.deepEqual(fake.calls.map((call) => call.name), approve ? ['spawn'] : [])
    }
  } finally {
    if (saved === undefined) delete process.env.DROVE_ROLE
    else process.env.DROVE_ROLE = saved
  }
})

test('spawn over budget stops when the human declines, and falls through without elicitation', async () => {
  const declined = await plannerWith({ elicit: async () => false })
  await fullRoster(declined.ctx)
  const refused = await declined.tool('spawn').call({ seat: 'w-six', kind: 'claude', brief: 'x' })
  assert.equal(refused.isError, true)
  assert.match(refused.text, /declined/)
  assert.deepEqual(declined.fake.calls, [])

  const unsupported = await plannerWith({ elicit: async () => undefined })
  await fullRoster(unsupported.ctx)
  await unsupported.tool('spawn').call({ seat: 'w-six', kind: 'claude', brief: 'x' })
  assert.deepEqual(unsupported.fake.calls.map((call) => call.name), ['spawn'])
})

test('spawn within budget never elicits', async () => {
  let asked = 0
  const { fake, tool } = await plannerWith({ elicit: async () => void asked++ === undefined })
  await tool('spawn').call({ seat: 'w-ui', kind: 'codex', brief: 'x' })
  assert.equal(asked, 0)
  assert.deepEqual(fake.calls.map((call) => call.name), ['spawn'])
})
