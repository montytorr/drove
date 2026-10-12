import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentKind, CommandResult, Exec, SpawnPolicy, SpawnPolicyKey, SpawnPolicyRule } from './types.ts'

const numbers: readonly SpawnPolicyKey[] = ['maxTurns', 'maxTokens', 'maxMinutes', 'maxCost']
const arrays: readonly SpawnPolicyKey[] = ['mcp', 'plugins', 'skills', 'agents', 'owns']
export const POLICY_KEYS: readonly SpawnPolicyKey[] = ['kind', 'model', 'effort', ...arrays, 'userMemory', 'userHooks', ...numbers, 'role', 'bound']
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
type Normalize = (key: SpawnPolicyKey, value: unknown) => unknown
const identity: Normalize = (_key, value) => value
const validValue = (key: SpawnPolicyKey, value: unknown): boolean => {
  if (numbers.includes(key)) return typeof value === 'number' && Number.isFinite(value) && value > 0 && (!['maxTurns', 'maxTokens'].includes(key) || Number.isInteger(value))
  if (arrays.includes(key)) return Array.isArray(value) && value.every(item => typeof item === 'string' && !!item.trim())
  if (['userMemory', 'userHooks'].includes(key)) return typeof value === 'boolean'
  if (key === 'kind') return value === 'claude' || value === 'codex'
  if (key === 'effort') return typeof value === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)
  if (key === 'role') return typeof value === 'string' && ['implementer', 'reviewer', 'tester'].includes(value)
  return typeof value === 'string' && !!value.trim()
}
const inChoice = (key: SpawnPolicyKey, value: unknown, choice: unknown[], normalize: Normalize): boolean =>
  arrays.includes(key) ? Array.isArray(value) && (key !== 'owns' || value.length > 0) && value.every(item => choice.some(other => same(item, other))) : choice.some(other => same(normalize(key, value), normalize(key, other)))

export const validatePolicy = (value: unknown, normalize: Normalize = identity): string[] => {
  if (value === undefined) return []
  if (!record(value)) return ['spawnPolicy must be an object']
  const errors: string[] = []
  for (const [name, rule] of Object.entries(value)) {
    const path = `spawnPolicy.${name}`
    if (!(POLICY_KEYS as readonly string[]).includes(name)) { errors.push(`${path}: unknown key`); continue }
    const key = name as SpawnPolicyKey
    if (!record(rule) || !Object.keys(rule).length) { errors.push(`${path}: expected a rule object`); continue }
    for (const field of Object.keys(rule)) if (!['fixed', 'choice', 'required', 'max'].includes(field)) errors.push(`${path}: unknown rule ${field}`)
    if (key === 'bound' && Object.keys(rule).some(field => field !== 'required')) errors.push(`${path}: only required is allowed`)
    if ('required' in rule && rule.required !== true) errors.push(`${path}.required must be true`)
    if ('fixed' in rule && !validValue(key, rule.fixed)) errors.push(`${path}.fixed has the wrong type or value`)
    if ('choice' in rule && (!Array.isArray(rule.choice) || !rule.choice.length || !rule.choice.every(item => arrays.includes(key) ? typeof item === 'string' && !!item.trim() : validValue(key, item)))) errors.push(`${path}.choice must be a non-empty list of valid values`)
    if ('max' in rule && (!numbers.includes(key) || typeof rule.max !== 'number' || !Number.isFinite(rule.max) || rule.max <= 0)) errors.push(`${path}.max requires a positive number on a numeric setting`)
    if ('fixed' in rule && Array.isArray(rule.choice) && !inChoice(key, rule.fixed, rule.choice, normalize)) errors.push(`${path}.fixed is outside choice`)
    if (typeof rule.fixed === 'number' && typeof rule.max === 'number' && rule.fixed > rule.max) errors.push(`${path}.fixed exceeds max`)
  }
  return errors
}

export type PolicyResult = { policy: SpawnPolicy; errors: string[]; kind?: AgentKind }
export const mergePolicies = (user: unknown, repo: unknown, normalize: Normalize = identity): PolicyResult => {
  const errors = [...validatePolicy(user, normalize), ...validatePolicy(repo, normalize)]
  if (errors.length) return { policy: {}, errors }
  const policy: SpawnPolicy = {}
  for (const key of POLICY_KEYS) {
    const a = (user as SpawnPolicy | undefined)?.[key]
    const b = (repo as SpawnPolicy | undefined)?.[key]
    if (!a && !b) continue
    const rule: SpawnPolicyRule = { ...a, ...b }
    if (a?.choice && b?.choice) rule.choice = a.choice.filter(item => b.choice!.some(other => same(normalize(key, item), normalize(key, other))))
    if (a?.max !== undefined && b?.max !== undefined) rule.max = Math.min(a.max, b.max)
    if (a?.required || b?.required) rule.required = true
    if (a && b && 'fixed' in a && 'fixed' in b && !same(normalize(key, a.fixed), normalize(key, b.fixed))) errors.push(`spawnPolicy.${key}.fixed conflicts between user and repo`)
    policy[key] = rule
  }
  return { policy, errors: [...errors, ...validatePolicy(policy, normalize)] }
}

const fileText = async (path: string): Promise<string | undefined> => {
  try { return await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
export const readPolicyConfig = async (path: string, readText = fileText): Promise<{ value?: unknown; error?: string }> => {
  try {
    const raw = await readText(path)
    if (raw === undefined) return {}
    const config: unknown = JSON.parse(raw)
    if (!record(config)) return { error: `${path}: config must be an object` }
    return { value: config.spawnPolicy }
  } catch (error) { return { error: `${path}: cannot read spawnPolicy: ${String(error)}` } }
}
const committedPolicy = async (exec: Exec, repo: string, base: string): Promise<{ value?: unknown; error?: string }> => {
  try {
    const listed = await exec(['git', '-C', repo, 'ls-tree', '--name-only', base, '--', '.drove.json'])
    if (listed.code !== 0) return { error: `spawnPolicy: cannot read committed base ${base}: ${listed.stderr.trim()}` }
    if (!listed.stdout.trim()) return {}
    const shown = await exec(['git', '-C', repo, 'show', `${base}:.drove.json`])
    if (shown.code !== 0) return { error: `spawnPolicy: cannot read ${base}:.drove.json: ${shown.stderr.trim()}` }
    return readPolicyConfig(`${base}:.drove.json`, async () => shown.stdout)
  } catch (error) { return { error: `spawnPolicy: cannot read committed base: ${String(error)}` } }
}
export type PolicySource = { exec?: Exec; base?: string; readText?: (path: string) => Promise<string | undefined>; normalize?: Normalize }
export const loadPolicy = async (home: string, repo: string, source: PolicySource | ((path: string) => Promise<string | undefined>) = {}): Promise<PolicyResult> => {
  const options = typeof source === 'function' ? { readText: source } : source
  const [user, local] = await Promise.all([readPolicyConfig(join(home, 'config.json'), options.readText), options.exec && options.base ? committedPolicy(options.exec, repo, options.base) : readPolicyConfig(join(repo, '.drove.json'), options.readText)])
  const merged = mergePolicies(user.value, local.value, options.normalize)
  const kindRules = mergePolicies(record(user.value) && user.value.kind ? { kind: user.value.kind } : undefined, record(local.value) && local.value.kind ? { kind: local.value.kind } : undefined)
  const kind = kindRules.policy.kind?.fixed ?? (kindRules.policy.kind?.choice?.length === 1 ? kindRules.policy.kind.choice[0] : undefined)
  return { policy: merged.policy, errors: [...[user.error, local.error].filter((item): item is string => !!item), ...merged.errors], ...(kind === 'claude' || kind === 'codex' ? { kind } : {}) }
}

export type PolicyOptions = { defaults?: object; normalize?: Normalize }
export const applyPolicy = <T extends object>(policy: SpawnPolicy, request: T, keys: readonly SpawnPolicyKey[] = POLICY_KEYS, options: PolicyOptions = {}): { request: T } | { error: CommandResult } => {
  const explicit = { ...request } as Record<string, unknown>
  if (typeof explicit.model === 'string' && !explicit.model.trim()) explicit.model = undefined
  const reviewer = (policy.role?.fixed ?? explicit.role ?? (options.defaults as Record<string, unknown> | undefined)?.role) === 'reviewer'
  const result = Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== undefined)) as T & Record<string, unknown>
  for (const [key, value] of Object.entries(options.defaults ?? {})) if (policy[key as SpawnPolicyKey] && explicit[key] === undefined && !(reviewer && key === 'owns')) Object.assign(result, { [key]: value })
  for (const key of arrays) if (policy[key] && result[key] === undefined && !(reviewer && key === 'owns')) Object.assign(result, { [key]: [] })
  const normalize = options.normalize ?? identity
  const refuse = (key: string, why: string) => ({ error: { ok: false, code: 'policy', text: `spawnPolicy.${key}: ${why}` } as CommandResult })
  for (const key of keys) {
    const rule = policy[key]
    if (!rule || key === 'bound' || (reviewer && key === 'owns')) continue
    const given = explicit[key]
    if ('fixed' in rule) {
      if (given !== undefined && !same(normalize(key, given), normalize(key, rule.fixed))) return refuse(key, `fixed requires ${JSON.stringify(rule.fixed)}; got ${JSON.stringify(given)}`)
      Object.assign(result, { [key]: rule.fixed })
    }
    const value = result[key]
    if (rule.required && given === undefined && !('fixed' in rule)) return refuse(key, 'required setting was omitted')
    if (value !== undefined && rule.choice && !inChoice(key, value, rule.choice, normalize)) return refuse(key, `choice permits ${JSON.stringify(rule.choice)}; effective value is ${JSON.stringify(value)}`)
    if (value !== undefined && rule.max !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value > rule.max)) return refuse(key, `max is ${rule.max}; effective value is ${JSON.stringify(value)}`)
  }
  if (keys.includes('bound') && policy.bound?.required && !numbers.some(key => explicit[key] !== undefined || policy[key]?.fixed !== undefined)) return refuse('bound', 'required: give at least one of maxTurns, maxTokens, maxMinutes or maxCost')
  return { request: result }
}
export const enforcePolicy = async <T extends object>(home: string, repo: string, request: T, keys?: readonly SpawnPolicyKey[], options: PolicySource & PolicyOptions = {}): Promise<{ request: T } | { error: CommandResult }> => {
  const { policy, errors } = await loadPolicy(home, repo, options)
  return errors.length ? { error: { ok: false, code: 'policy', text: errors.join('; ') } } : applyPolicy(policy, request, keys, options)
}

export const policyChange = async (exec: Exec, repo: string, base: string, branch: string): Promise<string | undefined> => {
  const changed = await exec(['git', '-C', repo, 'diff', '--name-only', `${base}...${branch}`, '--', '.drove.json'])
  if (changed.code !== 0) return `cannot inspect spawnPolicy changes: ${changed.stderr.trim()}; a human must merge this branch`
  if (!changed.stdout.trim()) return undefined
  const ancestor = await exec(['git', '-C', repo, 'merge-base', base, branch])
  if (ancestor.code !== 0) return 'cannot inspect spawnPolicy base; a human must merge this branch'
  const [before, after] = await Promise.all([committedPolicy(exec, repo, ancestor.stdout.trim()), committedPolicy(exec, repo, branch)])
  return before.error || after.error || !same(before.value, after.value) ? 'this branch changes spawnPolicy in .drove.json; a human must merge it' : undefined
}

export const policyText = (policy: unknown, errors: readonly string[] = []): string => errors.length ? `Spawn policy errors (Drove refuses delegation until corrected):\n${errors.join('\n')}\n` : policy === undefined || (record(policy) && !Object.keys(policy).length) ? '' : `Spawn policy (enforced by Drove; user and committed repo constraints both apply):\n${JSON.stringify(policy)}\nChoices and maxima check effective defaults; fixed settings replace defaults. Required settings must be supplied. Refusals have code policy.\n`
