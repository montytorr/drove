import type { AgentKind, GuardDecision, HookEventName, HookInput, HookRecord, Identity } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: hooks.${name}`)
}

export const HOOK_EVENTS: readonly HookEventName[] = ['session-start', 'user-prompt-submit', 'pre-tool-use', 'stop', 'notification', 'permission-request']
export const DENY_EXIT_CODE = 2

export const detectAgent = (raw: Record<string, unknown>, env: NodeJS.ProcessEnv): AgentKind => todo('detectAgent')
export const parseHookInput = (event: HookEventName, raw: Record<string, unknown>, agent: AgentKind): HookInput => todo('parseHookInput')
export const renderHookOutput = (agent: AgentKind, decision: GuardDecision): { stdout: string; stderr: string; code: number } => todo('renderHookOutput')
export const toRecord = (input: HookInput, at: Date): HookRecord => todo('toRecord')
export const recordHook = async (identity: Identity, record: HookRecord): Promise<void> => todo('recordHook')
export const runHook = async (event: HookEventName, stdin: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> => todo('runHook')
