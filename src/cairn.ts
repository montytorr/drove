import type { AgentKind } from './types.ts'

// Exec merges these overrides into the inherited process environment.
export const cairnEnv = (kind?: AgentKind, env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  if (env.CAIRN_AGENT !== undefined) return { CAIRN_AGENT: env.CAIRN_AGENT }
  return kind ? { CAIRN_AGENT: kind === 'claude' ? 'claude-code' : 'codex' } : {}
}

export const cairnKeyHint = (output: string): string =>
  output.includes('CAIRN_API_KEY is not set')
    ? '; set CAIRN_AGENT=claude-code or codex (the runtime whose key the instance holds)'
    : ''
