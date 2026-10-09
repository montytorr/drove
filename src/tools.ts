import type { Deps, Identity, McpTool } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: tools.${name}`)
}

export const PLANNER_TOOL_NAMES = ['spawn', 'send', 'verdict', 'prompt', 'promote', 'close', 'roster', 'capture'] as const
export const WORKER_TOOL_NAMES = ['report'] as const

export const plannerTools = (deps: Deps, identity: Identity): McpTool[] => todo('plannerTools')
export const workerTools = (deps: Deps, identity: Identity): McpTool[] => todo('workerTools')
