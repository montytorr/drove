import { access, constants, copyFile, lstat, mkdir, readFile, readlink, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { formatReport, type DoctorReport } from './doctor.ts'
import { DROVE_PLUGIN, expandHome, pluginDirEntries, pluginNameOfDir, userClaudeDir } from './launch.ts'
import { defaultHome } from './paths.ts'

export const SETUP_STEPS = ['cli', 'mod', 'home'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

// done: already in its end state. change: a write is needed (planned, or refused). written: applied this run.
// declined: the human said no. blocked: Drove cannot write it safely; detail says why.
export type StepStatus = 'done' | 'change' | 'written' | 'declined' | 'blocked'
export type StepResult = { step: SetupStep; status: StepStatus; path: string; before: string; after: string; detail: string; note?: string; backup?: string }
export type SetupResult = { ok: boolean; steps: StepResult[]; doctor: DoctorReport; left: string[]; error?: string }
export type SetupOptions = { steps: readonly SetupStep[]; yes: boolean; dryRun: boolean; json: boolean }

export type SetupDeps = {
  droveRoot: string
  userHome: string
  claudeDir: string
  droveHome: string
  binDir: string
  pathEnv: string
  isTTY: boolean
  ask: (question: string) => Promise<boolean>
  now: () => Date
  doctor: () => Promise<DoctorReport>
}

// This clone: the folder above src/.
export const CLONE_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

const PLUGIN_DIRS = 'CLAUDE_CODE_PLUGIN_DIRS'
const NONE = '(none)'

type Plan = StepResult & { apply?: () => Promise<string | undefined> }

const real = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

const lstatOf = async (path: string) => {
  try {
    return await lstat(path)
  } catch {
    return undefined
  }
}

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

const isExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

const firstOnPath = async (pathEnv: string, name: string): Promise<string | undefined> => {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    if (await isExecutable(join(dir, name))) return join(dir, name)
  }
  return undefined
}

const result = (step: SetupStep, status: StepStatus, path: string, before: string, after: string, detail: string): StepResult => ({ step, status, path, before, after, detail })

// With the link in binDir, does `drove` on PATH run this clone? Undefined when it does, else what the human must fix.
const pathNoteOf = async (deps: SetupDeps, mine: string): Promise<string | undefined> => {
  const bin = await real(deps.binDir)
  for (const dir of deps.pathEnv.split(delimiter).filter(Boolean)) {
    if (await real(dir) === bin) return undefined
    const candidate = join(dir, 'drove')
    if (await isExecutable(candidate)) {
      const runs = await real(candidate)
      return runs === mine ? undefined : `${candidate} comes first on PATH and runs ${runs}`
    }
  }
  return `${deps.binDir} is not on PATH`
}

const planCli = async (deps: SetupDeps): Promise<Plan> => {
  const source = join(deps.droveRoot, 'src', 'cli.ts')
  const target = join(deps.binDir, 'drove')
  const mine = await real(source)
  const onPath = await firstOnPath(deps.pathEnv, 'drove')
  if (onPath !== undefined && await real(onPath) === mine) return result('cli', 'done', onPath, source, source, `drove on PATH (${onPath}) is this clone`)
  const note = await pathNoteOf(deps, mine)
  const withNote = (text: string): string => (note ? `${text}; ${note}` : text)
  const existing = await lstatOf(target)
  if (existing?.isSymbolicLink() && await real(target) === mine) return { ...result('cli', 'done', target, source, source, withNote(`${target} links to this clone`)), ...(note ? { note } : {}) }
  if (existing !== undefined && !existing.isSymbolicLink()) {
    return result('cli', 'blocked', target, 'a file that is not a link', source, `${target} exists and is not a link; remove it or pass --bin DIR`)
  }
  const before = existing ? await readlink(target) : NONE
  return {
    ...result('cli', 'change', target, before, source, withNote(existing ? `${target} links to another clone` : `link ${target} to this clone`)),
    ...(note ? { note } : {}),
    apply: async () => {
      await mkdir(deps.binDir, { recursive: true })
      if (existing) await unlink(target)
      await symlink(source, target)
      return undefined
    },
  }
}

const recordOf = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined)

const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

// Writes through a symlinked settings.json to its target, by a rename in the target's folder, keeping its mode.
const writeSettings = async (path: string, text: string, now: Date): Promise<string | undefined> => {
  const target = await real(path)
  const before = await lstatOf(target)
  let backup: string | undefined
  if (before) {
    backup = `${target}.drove-backup-${stamp(now)}`
    await copyFile(target, backup)
  }
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.drove-${process.pid}.tmp`
  await writeFile(temp, text, { mode: before ? before.mode & 0o777 : 0o600 })
  await rename(temp, target)
  return backup
}

const planMod = async (deps: SetupDeps): Promise<Plan> => {
  const path = join(deps.claudeDir, 'settings.json')
  const modDir = join(deps.droveRoot, 'mod')
  const raw = await readText(path)
  let parsed: unknown = {}
  if (raw !== undefined && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return result('mod', 'blocked', path, 'unreadable JSON', modDir, `${path} is not valid JSON; fix it, then run drove setup mod again`)
    }
  }
  const settings = recordOf(parsed)
  if (!settings) return result('mod', 'blocked', path, 'not a JSON object', modDir, `${path} is not a JSON object; fix it, then run drove setup mod again`)
  const env = settings.env === undefined ? {} : recordOf(settings.env)
  if (!env) return result('mod', 'blocked', path, 'env is not an object', modDir, `env in ${path} is not an object; fix it, then run drove setup mod again`)
  const current = env[PLUGIN_DIRS]
  if (current !== undefined && typeof current !== 'string') return result('mod', 'blocked', path, `${PLUGIN_DIRS} is not a string`, modDir, `env.${PLUGIN_DIRS} in ${path} is not a string; fix it, then run drove setup mod again`)
  const entries = pluginDirEntries(current) ?? []
  const mine = await real(modDir)
  const kinds = await Promise.all(entries.map(async entry => {
    const dir = expandHome(entry, deps.userHome)
    if (await real(dir) === mine) return 'mine'
    return await pluginNameOfDir(dir) === DROVE_PLUGIN ? 'other' : 'keep'
  }))
  const next: string[] = []
  let placed = false
  entries.forEach((entry, index) => {
    const kind = kinds[index]
    if (kind === 'keep') next.push(entry)
    else if (!placed) {
      next.push(kind === 'mine' ? entry : modDir)
      placed = true
    }
  })
  if (!placed) next.push(modDir)
  const before = current ?? NONE
  const after = next.join(delimiter)
  if (after === current) return result('mod', 'done', path, before, after, `env.${PLUGIN_DIRS} loads this clone's mod`)
  const replaced = entries.filter((_, index) => kinds[index] === 'other')
  return {
    ...result('mod', 'change', path, before, after, replaced.length ? `replace another clone's mod (${replaced.join(', ')}) with ${modDir}` : `add ${modDir} to env.${PLUGIN_DIRS}`),
    apply: async () => {
      const updated = { ...settings, env: { ...env, [PLUGIN_DIRS]: after } }
      return writeSettings(path, `${JSON.stringify(updated, null, 2)}\n`, deps.now())
    },
  }
}

const planHome = async (deps: SetupDeps): Promise<Plan> => {
  const found = await lstatOf(deps.droveHome)
  if (found) {
    const isDir = found.isDirectory() || (found.isSymbolicLink() && (await stat(deps.droveHome).catch(() => undefined))?.isDirectory() === true)
    return isDir
      ? result('home', 'done', deps.droveHome, 'folder', 'folder', `${deps.droveHome} exists`)
      : result('home', 'blocked', deps.droveHome, 'not a folder', 'folder', `${deps.droveHome} exists and is not a folder; move it or point DROVE_HOME elsewhere`)
  }
  return {
    ...result('home', 'change', deps.droveHome, NONE, 'folder', `create ${deps.droveHome}`),
    apply: async () => {
      await mkdir(deps.droveHome, { recursive: true })
      return undefined
    },
  }
}

const PLANNERS: Record<SetupStep, (deps: SetupDeps) => Promise<Plan>> = { cli: planCli, mod: planMod, home: planHome }

// What only the human can do; a doctor check that already passes drops its line.
const leftFor = (doctor: DoctorReport, steps: StepResult[]): string[] => {
  const ok = (id: string) => doctor.checks.find(item => item.id === id)?.status === 'ok'
  const cli = steps.find(step => step.step === 'cli')
  return [
    ...(cli?.note ? [`${cli.note}: put ${dirname(cli.path)} first on PATH (shell profile), so drove runs this clone`] : []),
    ...(ok('herdr') && ok('herdr-server') ? [] : ['install herdr 0.9 or newer and start it (Drove never starts it)']),
    'sign in to Claude Code (claude, then /login) or Codex (codex login)',
    ...(ok('cairn') ? [] : [doctor.checks.find(item => item.id === 'cairn')?.status === 'fail' ? 'cairn setup --url <instance>' : 'optional, recommended: install Cairn and run cairn setup --url <instance>, for task tracking and shared memory']),
    ...(ok('gh') ? [] : ['gh auth login']),
    ...(steps.some(step => step.step === 'mod' && step.status === 'written') ? ['restart open Claude sessions so they load the mod'] : []),
    'trust each repo folder in Claude Code once: open claude in the repo and accept the folder-trust prompt',
  ]
}

const describe = (step: StepResult): string => (step.status === 'done' ? step.detail : `${step.path}: ${step.before} -> ${step.after} (${step.detail})`)

export const formatSetup = (setup: SetupResult): string => {
  const width = Math.max(...setup.steps.map(step => step.status.length))
  const lines = setup.steps.map(step => `${step.step.padEnd(4)}  ${step.status.padEnd(width)}  ${describe(step)}${step.backup ? `\n${' '.repeat(8 + width)}backup: ${step.backup}` : ''}`)
  return [...lines, '', formatReport(setup.doctor), '', 'Left for you:', ...setup.left.map(item => `  - ${item}`)].join('\n')
}

export type SetupIo = { out: (text: string) => void; err: (text: string) => void }

export const runSetup = async (deps: SetupDeps, options: SetupOptions, io: SetupIo): Promise<number> => {
  const order = SETUP_STEPS.filter(step => options.steps.length === 0 || options.steps.includes(step))
  const plans: Plan[] = []
  for (const step of order) plans.push(await PLANNERS[step](deps))
  const pending = plans.filter(plan => plan.status === 'change')
  const interactive = !options.yes && !options.dryRun && !options.json && deps.isTTY
  const refused = pending.length > 0 && !options.yes && !options.dryRun && !interactive
  if (!options.json && pending.length > 0) io.out(['Plan:', ...pending.map(plan => `  ${plan.step}: ${plan.path}: ${plan.before} -> ${plan.after}`), ''].join('\n'))
  const steps: StepResult[] = []
  for (const { apply, ...plan } of plans) {
    if (plan.status !== 'change' || !apply || options.dryRun || refused) {
      steps.push(plan)
      continue
    }
    if (interactive && !(await deps.ask(`${plan.step}: write ${plan.path}? [y/N] `))) {
      steps.push({ ...plan, status: 'declined' })
      continue
    }
    try {
      const backup = await apply()
      steps.push({ ...plan, status: 'written', ...(backup ? { backup } : {}) })
    } catch (error) {
      steps.push({ ...plan, status: 'blocked', detail: `${plan.detail}; write failed: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  const doctor = await deps.doctor()
  const error = refused ? 'not a terminal and no --yes: nothing written. Run drove setup --yes to apply the plan, or --dry-run to only print it' : undefined
  const ok = !refused && steps.every(step => step.status === 'done' || step.status === 'written' || (options.dryRun && step.status === 'change'))
  const setup: SetupResult = { ok, steps, doctor, left: leftFor(doctor, steps), ...(error ? { error } : {}) }
  io.out(options.json ? JSON.stringify(setup, null, 2) : formatSetup(setup))
  if (error) io.err(error)
  return ok ? 0 : 1
}

export const parseSteps = (names: readonly string[]): SetupStep[] => {
  const unknown = names.filter(name => !(SETUP_STEPS as readonly string[]).includes(name))
  if (unknown.length > 0) throw new Error(`unknown setup step ${unknown.join(', ')}; valid steps: ${SETUP_STEPS.join(', ')}`)
  return names as SetupStep[]
}

const askOnTty = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

export const nodeSetupDeps = (doctor: () => Promise<DoctorReport>, bin: string | undefined, env: NodeJS.ProcessEnv = process.env): SetupDeps => ({
  droveRoot: CLONE_ROOT,
  userHome: homedir(),
  claudeDir: userClaudeDir(env),
  droveHome: defaultHome(env),
  binDir: bin === undefined ? join(homedir(), '.local', 'bin') : resolve(expandHome(bin)),
  pathEnv: env.PATH ?? '',
  isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
  ask: askOnTty,
  now: () => new Date(),
  doctor,
})
