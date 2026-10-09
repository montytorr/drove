import type { McpTool, Role } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: mcp.${name}`)
}

export const PROTOCOL_VERSION = '2025-06-18'
export const SERVER_NAME = 'drove'

export type JsonRpcMessage = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } }

export const handleMessage = async (message: JsonRpcMessage, tools: readonly McpTool[], hooks?: { afterCall?: (text: string) => Promise<string> }): Promise<JsonRpcMessage | undefined> =>
  todo('handleMessage')
export const notify = (method: string, params: Record<string, unknown>): void => todo('notify')
export const serveMcp = async (role: Role, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): Promise<void> => todo('serveMcp')
