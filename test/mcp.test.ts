import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { handleMessage, notify, serveMcp, PROTOCOL_VERSION, SERVER_NAME } from '../src/mcp.ts'
import type { McpTool } from '../src/types.ts'
import { fakePorts, setup } from './p4-helpers.ts'

const echo: McpTool = { name: 'echo', description: 'echoes', inputSchema: { type: 'object' }, call: async (args) => ({ text: `echo ${JSON.stringify(args)}` }) }
const boom: McpTool = {
  name: 'boom',
  description: 'throws',
  inputSchema: { type: 'object' },
  call: async () => {
    throw new Error('kaput')
  },
}
const sad: McpTool = { name: 'sad', description: 'fails', inputSchema: { type: 'object' }, call: async () => ({ text: 'nope', isError: true }) }
const tools = [echo, boom, sad]

test('initialize echoes the client protocol version and names the server', async () => {
  const reply = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, tools)
  assert.equal(reply?.id, 1)
  assert.deepEqual(reply?.result, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: '0.1.0' } })
  const fallback = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize' }, tools, { capabilities: { experimental: { x: {} } }, instructions: 'hi' })
  assert.equal((fallback?.result as { protocolVersion: string }).protocolVersion, PROTOCOL_VERSION)
  assert.deepEqual((fallback?.result as { capabilities: unknown }).capabilities, { tools: {}, experimental: { x: {} } })
  assert.equal((fallback?.result as { instructions: string }).instructions, 'hi')
})

test('notifications and responses get no reply, ping and unknown methods do', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools), undefined)
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'tools/list' }, tools), undefined)
  assert.deepEqual((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, tools))?.result, {})
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 4, method: 'nope' }, tools))?.error?.code, -32601)
  const seen: unknown[] = []
  assert.equal(await handleMessage({ jsonrpc: '2.0', id: 'x', result: { ok: 1 } }, tools, { onResponse: (message) => void seen.push(message.result) }), undefined)
  assert.deepEqual(seen, [{ ok: 1 }])
})

test('tools/list hides the call function', async () => {
  const reply = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tools)
  assert.deepEqual((reply?.result as { tools: unknown[] }).tools[0], { name: 'echo', description: 'echoes', inputSchema: { type: 'object' } })
})

test('tools/call returns text content, tool failures as isError, unknown tools as a protocol error', async () => {
  const call = (name: string, args?: unknown) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args as Record<string, unknown> } }, tools)
  assert.deepEqual((await call('echo', { a: 1 }))?.result, { content: [{ type: 'text', text: 'echo {"a":1}' }] })
  assert.deepEqual((await call('echo'))?.result, { content: [{ type: 'text', text: 'echo {}' }] })
  assert.deepEqual((await call('boom'))?.result, { content: [{ type: 'text', text: 'boom failed: kaput' }], isError: true })
  assert.deepEqual((await call('sad'))?.result, { content: [{ type: 'text', text: 'nope' }], isError: true })
  assert.equal((await call('ghost'))?.error?.code, -32602)
  assert.equal(((await call('echo', [1]))?.result as { isError?: boolean }).isError, true)
})

test('afterCall decorates results, including errors, and a throwing hook never loses the result', async () => {
  const call = (name: string, afterCall: (text: string) => Promise<string>) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }, tools, { afterCall })
  assert.deepEqual((await call('sad', async (text) => `${text} +pending`))?.result, { content: [{ type: 'text', text: 'nope +pending' }], isError: true })
  const broken = await call('echo', async () => {
    throw new Error('x')
  })
  assert.deepEqual(broken?.result, { content: [{ type: 'text', text: 'echo {}' }] })
})

test('notify writes a JSON-RPC notification to the served output', async () => {
  const ctx = await setup()
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.on('data', (chunk) => chunks.push(String(chunk)))
  const served = serveMcp('worker', input, output, { identity: { home: ctx.home, run: ctx.run.id, role: 'worker', seat: 'w-api', token: 't' }, deps: ctx.deps, watchPorts: fakePorts().ports })
  notify('notifications/claude/channel', { content: 'hi', meta: { kind: 'report' } })
  input.end()
  await served
  assert.deepEqual(JSON.parse(chunks.join('')), { jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: 'hi', meta: { kind: 'report' } } })
})

test('serveMcp refuses to start without an identity', async () => {
  const saved = { ...process.env }
  for (const key of ['DROVE_RUN', 'DROVE_ROLE', 'DROVE_SEAT']) delete process.env[key]
  try {
    await assert.rejects(() => serveMcp('worker', new PassThrough(), new PassThrough()), /DROVE_RUN/)
  } finally {
    Object.assign(process.env, saved)
  }
})
