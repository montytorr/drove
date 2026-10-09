import type { LaunchRequest, LaunchSpec } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: launch.${name}`)
}

export const CLAUDE_GUARDED_TOOLS = 'Bash|Edit|Write|MultiEdit|NotebookEdit'
export const CODEX_GUARDED_TOOLS = 'Bash|shell|exec_command|apply_patch'

export const claudeWorkerSpec = (request: LaunchRequest): LaunchSpec => todo('claudeWorkerSpec')
export const codexWorkerSpec = (request: LaunchRequest): LaunchSpec => todo('codexWorkerSpec')
export const claudePlannerSpec = (request: LaunchRequest): LaunchSpec => todo('claudePlannerSpec')
export const codexPlannerSpec = (request: LaunchRequest): LaunchSpec => todo('codexPlannerSpec')
export const specFor = (request: LaunchRequest): LaunchSpec => todo('specFor')
export const claudeSettings = (droveEntry: string, role: LaunchRequest['identity']['role']): Record<string, unknown> => todo('claudeSettings')
export const claudeMcpConfig = (droveEntry: string): Record<string, unknown> => todo('claudeMcpConfig')
export const tomlString = (value: string): string => todo('tomlString')
export const redactSpec = (spec: LaunchSpec): LaunchSpec => todo('redactSpec')
export const writeLaunchFiles = async (spec: LaunchSpec): Promise<void> => todo('writeLaunchFiles')
