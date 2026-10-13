import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cairnEnv, cairnKeyHint } from './cairn.ts'
import { userCodexHome } from './paths.ts'
import type { AgentKind, Deps, DroveConfig, Exec, HostAgent, HostAgents, RunMeta } from './types.ts'

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

export type CairnDetection = { useCairn: boolean; warning?: string }

const firstLineOf = (text: string): string => (text.split('\n').map(line => line.trim()).find(Boolean) ?? 'no output').slice(0, 160)

// Cairn is on the host when its CLI runs (DROVE-159). Its server is remote, so a failed read is a blip to warn about, never a
// reason to run without Cairn: the run keeps it, and its cairn calls degrade as they always have.
export const probeCairn = async (exec: Exec, kind?: AgentKind): Promise<CairnDetection> => {
  try {
    if ((await exec(['cairn', '--version'], { timeoutMs: 10_000, env: cairnEnv(kind) })).code !== 0) return { useCairn: false }
  } catch {
    return { useCairn: false }
  }
  try {
    const read = await exec(['cairn', 'projects'], { timeoutMs: 10_000, env: cairnEnv(kind) })
    if (read.code === 0) return { useCairn: true }
    const output = `${read.stderr}\n${read.stdout}`
    return { useCairn: true, warning: `Warning: cairn is installed but a read failed (${firstLineOf(output)}${cairnKeyHint(output)}); the run keeps Cairn.` }
  } catch (error) {
    return { useCairn: true, warning: `Warning: cairn is installed but a read failed (${firstLineOf(error instanceof Error ? error.message : String(error))}); the run keeps Cairn.` }
  }
}

// Whether a run uses Cairn, decided once: a run that saved useCairn keeps it (a later outage must not flip it mid-run), and
// only a new run or one saved before DROVE-159 is detected. on and off never run cairn; auto asks the host.
export const detectRunCairn = async (deps: Pick<Deps, 'exec'>, setting: DroveConfig['cairn'] = 'auto', kind?: AgentKind, saved?: boolean): Promise<CairnDetection> =>
  saved !== undefined ? { useCairn: saved } : setting === 'on' ? { useCairn: true } : setting === 'off' ? { useCairn: false } : probeCairn(deps.exec, kind)

// The setting wins over what a run saved: off never uses Cairn, on always does. A run saved before DROVE-159 has no useCairn and keeps it.
export const runUsesCairn = (run: Pick<RunMeta, 'useCairn'>, config?: Pick<DroveConfig, 'cairn'>): boolean =>
  config?.cairn === 'off' ? false : config?.cairn === 'on' ? true : run.useCairn !== false

// Why a run has no Cairn, for the refusals that need it.
export const noCairnReason = (config: Pick<DroveConfig, 'cairn'>): string =>
  config.cairn === 'off'
    ? 'the cairn setting is off in ~/.drove/config.json'
    : 'the cairn setting is auto and no cairn CLI was found on this host when the run started (drove doctor)'
