import type { GuardDecision, GuardInput, Role } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: guard.${name}`)
}

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'shell', 'exec_command'])

export const decide = (input: GuardInput): GuardDecision => todo('decide')
export const bashReason = (command: string, role: Role, context: Pick<GuardInput, 'writableRoots' | 'openSeats'>): string | undefined => todo('bashReason')
export const isInside = (path: string, roots: readonly string[]): boolean => todo('isInside')
export const denyText = (role: Role, reason: string): string => todo('denyText')
