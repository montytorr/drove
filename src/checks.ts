import { existsSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recordEvent } from './deliver.ts'
import * as git from './git.ts'
import { runDir } from './paths.ts'
import { verifyCommands } from './prompts.ts'
import { updateRoster } from './roster.ts'
import { appendJsonl, LINE_MAX_BYTES, readJson, readJsonlFrom } from './store.ts'
import type { Deps, RunMeta, Seat, SeatChecks } from './types.ts'

// DROVE-122: the checks of a seat's worktree, run on their own (the planner's run_checks, the merge gate) and recorded
// by commit, so what passed at which HEAD is evidence and not a claim. One line per command in <run>/checks.jsonl.

export const CHECK_TIMEOUT_MS = 15 * 60_000
const TAIL_LINES = 40
export const TAIL_BYTES = 2048
// The checks run for the planner's repo, not as the planner: Drove's own identity must not leak into a test run.
const NO_IDENTITY_ENV = { DROVE_RUN: '', DROVE_ROLE: '', DROVE_SEAT: '', DROVE_TOKEN: '', DROVE_OWNS: '' }
const LOCKFILES = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'] as const

// The merge gate fills in what the checks vouch for: `reused` is what it says about evidence that stood in for a run, and
// `sha` the commit the checks ran at (what is then merged, pinned to that exact commit).
export type CheckPlan = { commands: string[]; source: string; reused?: string; sha?: string }

export type CheckRecord = {
  seat: string
  command: string
  cwd: string
  sha: string
  clean: boolean
  exit: number
  durationMs: number
  at: string
  tail: string
}

export const repoVerifyCommands = async (repo: string): Promise<string[]> => {
  const read = (name: string): Promise<string | undefined> => readFile(join(repo, name), 'utf8').catch(() => undefined)
  return verifyCommands({
    packageJson: await read('package.json'),
    makefile: (await read('Makefile')) ?? (await read('makefile')),
    lockfiles: LOCKFILES.filter(name => existsSync(join(repo, name))),
  })
}

// The base is the source of truth for what the checks are, so a branch cannot loosen its own gate by editing them:
// `checks` in the repo's .drove.json (an empty list declares there are none), else the detected typecheck, lint and test.
export const checksOf = async (repo: string): Promise<CheckPlan> => {
  const configured = await readJson<{ checks?: unknown }>(join(repo, '.drove.json')).catch(() => undefined)
  if (Array.isArray(configured?.checks)) return { commands: configured.checks.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== ''), source: '.drove.json' }
  return { commands: await repoVerifyCommands(repo), source: 'package.json scripts or Makefile targets' }
}

export const ledgerPath = (home: string, run: string): string => join(runDir(home, run), 'checks.jsonl')

const isRecord = (value: unknown): value is CheckRecord => {
  const item = value as Partial<CheckRecord> | null
  return typeof item === 'object' && item !== null && typeof item.seat === 'string' && typeof item.command === 'string' && typeof item.sha === 'string' && typeof item.exit === 'number' && typeof item.at === 'string' && typeof item.clean === 'boolean'
}

export const readLedger = async (home: string, run: string): Promise<CheckRecord[]> =>
  (await readJsonlFrom<unknown>(ledgerPath(home, run), { offset: 0 }).catch(() => ({ items: [] as unknown[] }))).items.filter(isRecord)

// The ledger as evidence: `intact` is false when any line fails to parse (a torn write, a hand edit) or lacks its
// last newline, because a newer failing record that cannot be read must not let an older pass win.
export const readLedgerStrict = async (home: string, run: string): Promise<{ records: CheckRecord[]; intact: boolean }> => {
  const text = await readFile(ledgerPath(home, run), 'utf8').catch(() => '')
  const records: CheckRecord[] = []
  let intact = text === '' || text.endsWith('\n')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed)) records.push(parsed)
      else intact = false
    } catch {
      intact = false
    }
  }
  return { records, intact }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

const bytes = (text: string): number => Buffer.byteLength(text)

// The last output of a check: at most TAIL_LINES lines and TAIL_BYTES bytes, cut at a character, ANSI colours removed.
export const tailOf = (text: string, max = TAIL_BYTES): string => {
  const lines = text.replace(ANSI, '').split('\n').map(line => line.trimEnd())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let tail = lines.slice(-TAIL_LINES).join('\n')
  if (bytes(tail) <= max) return tail
  tail = Buffer.from(tail).subarray(-max).toString('utf8')
  return tail.replace(/^�+/, '')
}

// A ledger line must fit the jsonl cap once escaped, so the tail is cut further when its JSON is longer than it looks.
const fitted = (record: CheckRecord): CheckRecord => {
  let next = record
  while (bytes(JSON.stringify(next)) + 1 > LINE_MAX_BYTES && next.tail.length > 0) next = { ...next, tail: tailOf(next.tail, Math.floor(bytes(next.tail) / 2)) }
  if (bytes(JSON.stringify(next)) + 1 > LINE_MAX_BYTES) next = { ...next, command: next.command.slice(0, 512), cwd: next.cwd.slice(-512) }
  return next
}

export type CommandOutcome = {
  command: string
  status: 'passed' | 'failed' | 'skipped'
  exit?: number
  durationMs?: number
  tail?: string
}

export type CheckOutcome = {
  seat: string
  sha: string
  // True when the tree was clean before the first command and every command left it clean.
  clean: boolean
  // What to tell the planner besides pass or fail: a check that changed the worktree, a ledger that cannot be trusted.
  notes: string[]
  passed: boolean
  // True when no command was run: every one had a passing record at this HEAD on a clean tree.
  reused: boolean
  // When the evidence was recorded: the last of this run's commands, or of the records reused.
  at: string
  source: string
  commands: CommandOutcome[]
  failed?: CommandOutcome
}

export type CheckFailure = { error: { code: string; text: string } }

export type CheckOptions = {
  // Run every command even when the ledger has a passing record for this HEAD.
  fresh?: boolean
  // The commands to run; by default the checks of the run's repo (checksOf).
  plan?: CheckPlan
}

// The newest record of a command at this sha, in this worktree: a later failure beats an earlier pass.
const latestAt = (ledger: readonly CheckRecord[], seat: Seat, command: string, sha: string): CheckRecord | undefined =>
  ledger.findLast(record => record.seat === seat.name && record.command === command && record.sha === sha && record.cwd === seat.worktree)

const evidenceFor = (ledger: readonly CheckRecord[], seat: Seat, plan: CheckPlan, sha: string): CheckRecord[] | undefined => {
  if (plan.commands.length === 0) return undefined
  const found: CheckRecord[] = []
  for (const command of plan.commands) {
    const record = latestAt(ledger, seat, command, sha)
    if (!record || record.exit !== 0 || !record.clean) return undefined
    found.push(record)
  }
  return found
}

const seatChecksOf = (outcome: CheckOutcome): SeatChecks => ({
  result: outcome.passed ? 'passed' : 'failed',
  sha: outcome.sha,
  clean: outcome.clean,
  at: outcome.at,
  ...(outcome.failed ? { failed: outcome.failed.command } : {}),
})

// Runs the checks of `plan` in the seat's worktree, in order, and stops at the first that fails; records each command in
// the run's ledger, the seat's last result on the roster and a checks.ran event. Reuses a passing record at this HEAD on
// a clean tree instead, unless `fresh`: a dirty tree, a new commit, a missing or failing record all mean a run.
// Never writes to the repo itself.
export const runChecks = async (deps: Deps, run: RunMeta, seat: Seat, options: CheckOptions = {}): Promise<CheckOutcome | CheckFailure> => {
  if (!existsSync(seat.worktree)) return { error: { code: 'no-worktree', text: `${seat.name}'s worktree ${seat.worktree} is gone, so its checks cannot run` } }
  const plan = options.plan ?? (await checksOf(run.repo))
  let sha: string
  let clean: boolean
  try {
    const head = await deps.exec(['git', '-C', seat.worktree, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })
    if (head.code !== 0) throw new Error(`git rev-parse HEAD failed: ${(head.stderr || head.stdout).trim().slice(0, 300)}`)
    sha = head.stdout.trim()
    clean = (await git.dirtyLines(deps.exec, seat.worktree)).length === 0
  } catch (error) {
    return { error: { code: 'git', text: `could not read ${seat.name}'s worktree ${seat.worktree}: ${error instanceof Error ? error.message : String(error)}` } }
  }
  const base = { seat: seat.name, sha, source: plan.source }
  const notes: string[] = []

  const ledger = await readLedgerStrict(deps.home, run.id)
  if (!ledger.intact) notes.push('checks.jsonl has a line that does not parse, so no evidence is reused in this run: the checks ran again.')
  if (!options.fresh && clean && ledger.intact) {
    const evidence = evidenceFor(ledger.records, seat, plan, sha)
    if (evidence) {
      const at = evidence.map(record => record.at).sort().at(-1) ?? deps.clock.now().toISOString()
      const outcome: CheckOutcome = { ...base, clean, notes, passed: true, reused: true, at, commands: evidence.map(record => ({ command: record.command, status: 'passed', exit: 0, durationMs: record.durationMs, tail: record.tail })) }
      await markSeat(deps, run, seat, outcome)
      return outcome
    }
  }

  // A torn last line would swallow the next record's start: end it first.
  if (!ledger.intact) await healLedger(ledgerPath(deps.home, run.id))
  const commands: CommandOutcome[] = []
  let treeClean = clean
  let dirtiedBy: string | undefined
  let failed: CommandOutcome | undefined
  let ranMs = 0
  let at = deps.clock.now().toISOString()
  for (const command of plan.commands) {
    if (failed) {
      commands.push({ command, status: 'skipped' })
      continue
    }
    const started = Date.now()
    const ran = await deps.exec(['sh', '-c', command], { cwd: seat.worktree, timeoutMs: CHECK_TIMEOUT_MS, env: NO_IDENTITY_ENV })
    const durationMs = Date.now() - started
    ranMs += durationMs
    at = deps.clock.now().toISOString()
    const tail = tailOf(`${ran.stdout}\n${ran.stderr}`)
    // A check that edits files (lint --fix, snapshots, codegen) leaves the tree it vouched for: its record is not evidence.
    if (treeClean) {
      const after = await git.dirtyLines(deps.exec, seat.worktree).catch(() => ['(git status failed)'])
      if (after.length > 0) {
        treeClean = false
        dirtiedBy = command
        notes.push(`"${command}" left the worktree changed (${after.slice(0, 5).join('; ')}), so this run is not evidence a merge reuses.`)
      }
    }
    await appendJsonl(ledgerPath(deps.home, run.id), fitted({ seat: seat.name, command, cwd: seat.worktree, sha, clean: treeClean, exit: ran.code, durationMs, at, tail }))
    const outcome: CommandOutcome = { command, status: ran.code === 0 ? 'passed' : 'failed', exit: ran.code, durationMs, tail }
    commands.push(outcome)
    if (ran.code !== 0) failed = outcome
  }
  const outcome: CheckOutcome = { ...base, clean: treeClean, notes, passed: failed === undefined, reused: false, at, commands, ...(failed ? { failed } : {}) }
  if (plan.commands.length === 0) return outcome
  await markSeat(deps, run, seat, outcome)
  await recordEvent(deps, run.id, {
    type: 'checks.ran',
    seat: seat.name,
    data: { sha, clean: treeClean, ...(dirtiedBy ? { dirtiedBy } : {}), passed: outcome.passed, commands: plan.commands.length, ran: commands.filter(entry => entry.status !== 'skipped').length, durationMs: ranMs, source: plan.source, ...(failed ? { failed: failed.command, exit: failed.exit } : {}) },
  })
  return outcome
}

const healLedger = async (path: string): Promise<void> => {
  const text = await readFile(path, 'utf8').catch(() => '')
  if (text !== '' && !text.endsWith('\n')) await appendFile(path, '\n')
}

const markSeat = async (deps: Deps, run: RunMeta, seat: Seat, outcome: CheckOutcome): Promise<void> => {
  const checks = seatChecksOf(outcome)
  await updateRoster(deps.home, run.id, roster => ({ ...roster, seats: roster.seats.map(entry => (entry.name === seat.name ? { ...entry, checks } : entry)) }))
}

// ---------- what the boards and the roster say ----------

export const shortSha = (sha: string): string => sha.slice(0, 7)

export const reusedText = (outcome: Pick<CheckOutcome, 'sha' | 'at'>): string => `passed at ${shortSha(outcome.sha)} ${outcome.at.slice(0, 19)}Z`

const seconds = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`)

export const renderOutcome = (outcome: CheckOutcome): string => {
  const tree = outcome.clean ? 'clean tree' : outcome.notes.some(note => /left the worktree changed/.test(note)) ? 'a check changed the worktree' : 'uncommitted changes in the worktree'
  const head = `${outcome.seat}: checks ${outcome.passed ? 'passed' : 'FAILED'} at ${shortSha(outcome.sha)} (${tree}).`
  const how = outcome.reused ? `Reused the evidence recorded ${outcome.at}: no command was run again (fresh reruns them).` : outcome.commands.length === 0 ? `No checks are defined (${outcome.source}).` : `Ran ${outcome.commands.filter(entry => entry.status !== 'skipped').length} of ${outcome.commands.length} (${outcome.source}).`
  const lines = outcome.commands.map(entry => {
    if (entry.status === 'skipped') return `- skipped  ${entry.command} (not run: an earlier check failed)`
    const timing = entry.durationMs === undefined || outcome.reused ? '' : `, ${seconds(entry.durationMs)}`
    const row = `- ${entry.status === 'passed' ? 'passed ' : 'FAILED '} ${entry.command} (exit ${entry.exit}${timing})`
    return entry.status === 'failed' ? `${row}\n  last output:\n${(entry.tail || '(no output)').split('\n').map(line => `  | ${line}`).join('\n')}` : row
  })
  const note = outcome.clean ? '' : 'The tree is not clean, so this result is recorded but is not evidence a merge reuses: the worker must commit, or the check must stop changing files.'
  return [head, how, ...lines, ...outcome.notes, ...(note ? [note] : [])].join('\n')
}
