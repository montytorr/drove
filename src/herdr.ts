import type { AgentKind, Exec, HerdrAgent } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: herdr.${name}`)
}

export type HerdrResult<T> = { ok: true; value: T } | { ok: false; code: string; output: string }

export const tabCreateArgv = (workspace: string, cwd: string, label: string, env: Record<string, string>): string[] => todo('tabCreateArgv')
export const paneSplitArgv = (anchor: string, direction: 'right' | 'down', cwd: string, env: Record<string, string>): string[] => todo('paneSplitArgv')
export const agentStartArgv = (seat: string, kind: AgentKind, paneId: string, agentArgv: readonly string[], timeoutMs?: number): string[] => todo('agentStartArgv')
export const agentPromptArgv = (target: string, text: string, timeoutMs?: number): string[] => todo('agentPromptArgv')
export const agentReadArgv = (target: string, lines: number, source?: 'recent-unwrapped' | 'detection'): string[] => todo('agentReadArgv')
export const paneCloseArgv = (paneId: string): string[] => todo('paneCloseArgv')
export const tabCloseArgv = (tabId: string): string[] => todo('tabCloseArgv')
export const herdrError = (output: string): string | undefined => todo('herdrError')
export const parseAgents = (stdout: string): HerdrAgent[] | undefined => todo('parseAgents')
export const parseAgent = (stdout: string): HerdrAgent | undefined => todo('parseAgent')
export const parseNewPane = (stdout: string): { paneId: string; tabId?: string } | undefined => todo('parseNewPane')
export const listAgents = async (exec: Exec): Promise<HerdrResult<HerdrAgent[]>> => todo('listAgents')
export const getAgent = async (exec: Exec, target: string): Promise<HerdrResult<HerdrAgent>> => todo('getAgent')
export const retryWhileBusy = async (exec: Exec, argv: readonly string[], timeoutMs: number): Promise<HerdrResult<string>> => todo('retryWhileBusy')
