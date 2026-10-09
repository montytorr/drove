import type { Exec } from './types.ts'

const todo = (name: string): never => {
  throw new Error(`not implemented: git.${name}`)
}

export const PROTECTED_BRANCH = 'production'

export const hasRemote = async (exec: Exec, repo: string): Promise<boolean> => todo('hasRemote')
export const baseRef = async (exec: Exec, repo: string, base?: string): Promise<string> => todo('baseRef')
export const addWorktree = async (exec: Exec, repo: string, path: string, branch: string, from: string): Promise<void> => todo('addWorktree')
export const removeWorktree = async (exec: Exec, repo: string, path: string): Promise<void> => todo('removeWorktree')
export const isMerged = async (exec: Exec, repo: string, branch: string, into: string): Promise<boolean> => todo('isMerged')
export const commonGitDir = async (exec: Exec, repo: string): Promise<string> => todo('commonGitDir')
