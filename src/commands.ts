import type { AgentKind, CommandResult, Deps, Effort, Identity, PromoteRequest, SendRequest, SpawnRequest } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: commands.${name}`)
}

export type PlanRequest = { repo: string; kind: AgentKind; model?: string; effort?: Effort; goal?: string; run?: string }
export type RunRef = { run?: string; repo: string }

export const defaultDeps = (env: NodeJS.ProcessEnv = process.env): Deps => todo('defaultDeps')
export const identityOrPlanner = (env: NodeJS.ProcessEnv = process.env): Identity => todo('identityOrPlanner')

export const plan = async (deps: Deps, request: PlanRequest): Promise<CommandResult> => todo('plan')
export const spawn = async (deps: Deps, identity: Identity, request: SpawnRequest): Promise<CommandResult> => todo('spawn')
export const send = async (deps: Deps, identity: Identity, request: SendRequest): Promise<CommandResult> => todo('send')
export const prompt = async (deps: Deps, identity: Identity, seat: string, text: string): Promise<CommandResult> => todo('prompt')
export const promote = async (deps: Deps, identity: Identity, request: PromoteRequest): Promise<CommandResult> => todo('promote')
export const roster = async (deps: Deps, ref: RunRef, asJson: boolean): Promise<CommandResult> => todo('roster')
export const capture = async (deps: Deps, ref: RunRef, seat: string, lines: number): Promise<CommandResult> => todo('capture')
export const close = async (deps: Deps, identity: Identity, seat: string, removeWorktree: boolean): Promise<CommandResult> => todo('close')
export const down = async (deps: Deps, ref: RunRef): Promise<CommandResult> => todo('down')
export const up = async (deps: Deps, ref: RunRef, seat?: string): Promise<CommandResult> => todo('up')
export const budget = async (deps: Deps, ref: RunRef, size: number): Promise<CommandResult> => todo('budget')
