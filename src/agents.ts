import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { userCodexHome } from './paths.ts'
import type { AgentKind, Deps, Exec, HostAgent, HostAgents } from './types.ts'

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

const stringOf = (raw: string): string | undefined => {
  try {
    return raw.startsWith('"') ? JSON.parse(raw) as string : raw.slice(1, -1)
  } catch {
    return undefined
  }
}

// Root defaults apply unless the selected profile overrides an individual setting.
const codexDefaults = (text: string): Pick<HostAgent, 'model' | 'effort'> => {
  const root: Pick<HostAgent, 'model' | 'effort'> & { profile?: string } = {}
  const profiles = new Map<string, Pick<HostAgent, 'model' | 'effort'>>()
  let settings: typeof root | undefined = root
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      const header = /^\s*\[\s*profiles\s*\.\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/.exec(line)
      const raw = header?.[1]
      const name = raw?.startsWith('"') || raw?.startsWith("'") ? stringOf(raw) : raw
      settings = name === undefined ? undefined : profiles.get(name) ?? profiles.set(name, {}).get(name)
      continue
    }
    const match = /^\s*(profile|model|model_reasoning_effort)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line)
    if (!settings || !match) continue
    const value = stringOf(match[2] as string)
    if (!value) continue
    if (match[1] === 'profile') {
      if (settings === root) root.profile = value
    } else {
      settings[match[1] === 'model' ? 'model' : 'effort'] = value
    }
  }
  const { profile, ...defaults } = root
  return { ...defaults, ...(profile ? profiles.get(profile) : {}) }
}

export const detectAgents = async (deps: AgentDeps): Promise<HostAgents> => {
  const codexHome = deps.codexHome || (deps.env ?? process.env).CODEX_HOME || join(deps.home, '.codex')
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

// An empty snapshot is a failed detection, rather than evidence that neither CLI can be used.
export const detectRunAgents = async (deps: Deps): Promise<HostAgents | undefined> => {
  const agents = await detectAgents(nodeAgentDeps(deps.exec, deps.codexUserHome ?? userCodexHome(deps.home), deps.clock.now))
  return agents.claude || agents.codex ? agents : undefined
}

// A display fallback only: stored models stay empty so a default Codex launch never gains -m.
export const modelLabelOf = (kind: AgentKind, model: string, agents?: HostAgents): string =>
  model || (kind === 'codex' ? agents?.codex?.model ?? '' : '')
