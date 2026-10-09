import type { AgentKind, DroveConfig, RunMeta, Seat } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: prompts.${name}`)
}

export const plannerRole = (run: RunMeta, config: DroveConfig, kind: AgentKind): string => todo('plannerRole')
export const workerRole = (seat: Seat, run: RunMeta, config: DroveConfig): string => todo('workerRole')
export const briefFooter = (seat: string, cairn?: string): string => todo('briefFooter')
export const approvedText = (): string => todo('approvedText')
export const nudgeText = (): string => todo('nudgeText')
export const resumedText = (): string => todo('resumedText')
