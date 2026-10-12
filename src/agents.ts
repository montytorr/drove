import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentKind, Exec, HostAgent, HostAgents } from './types.ts'

export type AgentDeps = {
  exec: Exec
  readText: (path: string) => Promise<string | undefined>
  home: string
  codexHome?: string
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

const probe = async (exec: Exec, kind: AgentKind): Promise<HostAgent | undefined> => {
  try {
    const result = await exec([kind, '--version'], { timeoutMs: 10_000 })
    const version = /\b\d+\.\d+\.\d+\b/.exec(result.stdout)?.[0]
    return result.code === 0 && version ? { version } : undefined
  } catch {
    return undefined
  }
}

// Only root settings apply to Codex's default. Everything after a table header belongs to that table.
const codexDefaults = (text: string): Pick<HostAgent, 'model' | 'effort'> => {
  const defaults: Pick<HostAgent, 'model' | 'effort'> = {}
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break
    const match = /^\s*(model|model_reasoning_effort)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line)
    if (!match) continue
    const raw = match[2] as string
    let value: string
    try {
      value = raw.startsWith('"') ? JSON.parse(raw) as string : raw.slice(1, -1)
    } catch {
      continue
    }
    if (value) defaults[match[1] === 'model' ? 'model' : 'effort'] = value
  }
  return defaults
}

export const detectAgents = async (deps: AgentDeps): Promise<HostAgents> => {
  const codexHome = deps.codexHome ?? (deps.env ?? process.env).CODEX_HOME ?? join(deps.home, '.codex')
  const [claude, codex, config] = await Promise.all([
    probe(deps.exec, 'claude'),
    probe(deps.exec, 'codex'),
    deps.readText(join(codexHome, 'config.toml')).catch(() => undefined),
  ])
  return {
    at: (deps.now?.() ?? new Date()).toISOString(),
    ...(claude ? { claude } : {}),
    ...(codex ? { codex: { ...codex, ...codexDefaults(config ?? '') } } : {}),
  }
}

export const nodeAgentDeps = (exec: Exec, codexHome?: string, now?: () => Date): AgentDeps => ({
  exec, home: homedir(), codexHome, now,
  readText: path => readFile(path, 'utf8').catch(() => undefined),
})

// A display fallback only: stored models stay empty so a default Codex launch never gains -m.
export const modelLabelOf = (kind: AgentKind, model: string, agents?: HostAgents): string =>
  model || (kind === 'codex' ? agents?.codex?.model ?? '' : '')
