import { createInterface } from 'node:readline'
import * as commands from './commands.ts'
import { identityFromEnv } from './paths.ts'
import { loadRun } from './roster.ts'
import { defaultToolPorts, plannerTools, workerTools } from './tools.ts'
import type { ToolPorts } from './tools.ts'
import { createWatcher } from './watch.ts'
import type { WatchPorts, Watcher } from './watch.ts'
import type { Deps, Identity, McpTool, Role } from './types.ts'

export const PROTOCOL_VERSION = '2025-06-18'
export const SERVER_NAME = 'drove'
export const SERVER_VERSION = '0.1.0'
const ELICIT_TIMEOUT_MS = 10 * 60_000

export type JsonRpcMessage = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }

export type McpHooks = {
  afterCall?: (text: string) => Promise<string>
  onInitialize?: (params: Record<string, unknown>) => void
  onResponse?: (message: JsonRpcMessage) => void
  capabilities?: Record<string, unknown>
  instructions?: string
}

const ok = (id: JsonRpcMessage['id'], result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id, result })
const fail = (id: JsonRpcMessage['id'], code: number, message: string): JsonRpcMessage => ({ jsonrpc: '2.0', id, error: { code, message } })

export const handleMessage = async (message: JsonRpcMessage, tools: readonly McpTool[], hooks: McpHooks = {}): Promise<JsonRpcMessage | undefined> => {
  const { id, method, params } = message
  if (method === undefined) {
    if (id !== undefined && id !== null) hooks.onResponse?.(message)
    return undefined
  }
  if (method === 'initialize') {
    hooks.onInitialize?.(params ?? {})
    const requested = params?.protocolVersion
    return ok(id, {
      protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
      capabilities: { tools: {}, ...hooks.capabilities },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      ...(hooks.instructions ? { instructions: hooks.instructions } : {}),
    })
  }
  if (id === undefined || id === null) return undefined
  if (method === 'ping') return ok(id, {})
  if (method === 'tools/list') return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  if (method === 'tools/call') {
    const tool = tools.find((candidate) => candidate.name === params?.name)
    if (!tool) return fail(id, -32602, `unknown tool ${String(params?.name)}`)
    const args = params?.arguments ?? {}
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return ok(id, { isError: true, content: [{ type: 'text', text: 'arguments must be an object' }] })
    let outcome: { text: string; isError?: boolean }
    try {
      outcome = await tool.call(args as Record<string, unknown>)
    } catch (error) {
      outcome = { text: `${tool.name} failed: ${(error as Error).message}`, isError: true }
    }
    let text = outcome.text
    if (hooks.afterCall) {
      try {
        text = await hooks.afterCall(text)
      } catch {
        text = outcome.text
      }
    }
    return ok(id, { content: [{ type: 'text', text }], ...(outcome.isError ? { isError: true } : {}) })
  }
  return fail(id, -32601, `method not found: ${method}`)
}

let sink: NodeJS.WritableStream = process.stdout

const write = (output: NodeJS.WritableStream, message: JsonRpcMessage) => {
  output.write(`${JSON.stringify(message)}\n`)
}

export const notify = (method: string, params: Record<string, unknown>): void => {
  sink.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

export type ServeOptions = {
  deps?: Deps
  identity?: Identity
  toolPorts?: Partial<ToolPorts>
  watchPorts?: WatchPorts
  channel?: boolean
  loop?: boolean
  onError?: (error: unknown, step: string) => void
}

const PLANNER_INSTRUCTIONS = [
  'You are the Drove planner. Workers report through the drove report tool; reports reach you as messages (or at the end of your next drove tool result).',
  'Never wait, poll or sleep for a worker: after spawn or send, continue with independent work or end your turn. Review diffs read-only, answer with send or verdict, merge approved branches, then close the seat.',
].join('\n')

const CHANNEL_INSTRUCTIONS = ' Worker reports may also arrive as <channel source="drove"> events: treat each as a worker report and act on it the same way.'

const WORKER_INSTRUCTIONS = 'You are a Drove worker. The only way the planner hears from you is the report tool. After done, question, blocked or promote, stop and wait for the reply.'

const defaultDepsFrom = (identity: Identity): Deps => {
  const base = commands.defaultDeps()
  return { ...base, home: identity.home }
}

export const serveMcp = async (role: Role, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout, options: ServeOptions = {}): Promise<void> => {
  const identity = options.identity ?? identityFromEnv()
  if (!identity) throw new Error('DROVE_RUN, DROVE_ROLE and DROVE_SEAT must be set to serve the drove MCP')
  const deps = options.deps ?? defaultDepsFrom(identity)
  const onError = options.onError ?? ((error, step) => process.stderr.write(`drove mcp ${step}: ${(error as Error).message}\n`))
  sink = output

  const waiting = new Map<string, (message: JsonRpcMessage) => void>()
  let nextRequest = 1
  let clientElicits = false

  const elicit = async (message: string): Promise<boolean | undefined> => {
    if (!clientElicits) return undefined
    const id = `drove-${nextRequest++}`
    const answer = new Promise<JsonRpcMessage>((resolve) => {
      waiting.set(id, resolve)
      setTimeout(() => {
        if (waiting.delete(id)) resolve(fail(id, -32000, 'elicitation timed out'))
      }, ELICIT_TIMEOUT_MS).unref()
    })
    output.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message, requestedSchema: { type: 'object', properties: { approve: { type: 'boolean', title: 'Allow the extra pane', default: true } } } } })}\n`)
    const reply = await answer
    if (reply.error) return undefined
    const result = reply.result as { action?: string; content?: { approve?: boolean } } | undefined
    return result?.action === 'accept' && result.content?.approve !== false
  }

  let watcher: Watcher | undefined
  let tools: McpTool[]
  const hooks: McpHooks = {
    instructions: role === 'planner' ? PLANNER_INSTRUCTIONS : WORKER_INSTRUCTIONS,
    onInitialize: (params) => {
      clientElicits = (params.capabilities as { elicitation?: unknown } | undefined)?.elicitation !== undefined
    },
    onResponse: (message) => {
      const resolve = waiting.get(String(message.id))
      if (resolve && waiting.delete(String(message.id))) resolve(message)
    },
  }

  if (role === 'planner') {
    const toolPorts: ToolPorts = { ...defaultToolPorts, ...options.toolPorts, elicit }
    const run = await loadRun(deps.home, identity.run)
    tools = plannerTools(deps, identity, toolPorts, run?.agents)
    if (!run) onError(new Error(`run ${identity.run} not found under ${deps.home}`), 'startup')
    else {
      const channel = options.channel ?? process.env.DROVE_CHANNEL === '1'
      watcher = createWatcher(deps, run, {
        ports: options.watchPorts,
        onError,
        loop: options.loop,
        channel: channel ? (content, meta) => notify('notifications/claude/channel', { content, meta }) : undefined,
      })
      if (channel) {
        hooks.capabilities = { experimental: { 'claude/channel': {} } }
        hooks.instructions += CHANNEL_INSTRUCTIONS
      }
      hooks.afterCall = watcher.piggyback
    }
  } else tools = workerTools(deps, identity, { ...defaultToolPorts, ...options.toolPorts })

  const inflight = new Set<Promise<void>>()
  const handle = async (line: string) => {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch (error) {
      write(output, fail(null, -32700, `parse error: ${(error as Error).message}`))
      return
    }
    const reply = await handleMessage(message, tools, hooks)
    if (reply) write(output, reply)
  }

  await new Promise<void>((resolve) => {
    const lines = createInterface({ input })
    lines.on('line', (line) => {
      if (!line.trim()) return
      const work = handle(line).catch((error) => onError(error, 'handle'))
      inflight.add(work)
      void work.finally(() => inflight.delete(work))
    })
    lines.on('close', resolve)
  })
  while (inflight.size > 0) await Promise.all([...inflight])
  watcher?.stop()
}
