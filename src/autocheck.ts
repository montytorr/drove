import { join } from 'node:path'
import { type CheckOutcome, type CheckPlan, type CommandOutcome, checksOf, runChecks, shortSha } from './checks.ts'
import { readJson } from './store.ts'
import type { Control, Deps, Report, RunMeta, Seat } from './types.ts'

// DROVE-126: Drove runs the checks of an implementer's done report itself, before the planner is woken. A failure goes
// back to the worker as a `changes` verdict without the planner; a pass is one line on what the planner reads.

export const DEFAULT_ATTEMPTS = 2
// Seats checked at once in one run: a run's checks share the machine's cores, so the rest wait their turn.
export const MAX_RUNNING = 2

export type AutoCheckSettings = { plan: CheckPlan; attempts: number }

type RepoFile = { autoCheck?: unknown; autoChecks?: unknown; autoCheckAttempts?: unknown }

const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1

// What to run for a done report, or undefined when nothing: `autoCheck: false` in the repo's .drove.json or the home
// config.json, `autoChecks: []`, or a repo that declares no checks at all. The commands are `autoChecks` of the repo's
// .drove.json (read from the main checkout, as the merge's checks are) and fall back to the merge plan's.
export const autoCheckSettings = async (home: string, repo: string): Promise<AutoCheckSettings | undefined> => {
  const [file, config] = await Promise.all([
    readJson<RepoFile>(join(repo, '.drove.json')).catch(() => undefined),
    readJson<RepoFile>(join(home, 'config.json')).catch(() => undefined),
  ])
  if (file?.autoCheck === false || config?.autoCheck === false) return undefined
  const listed = Array.isArray(file?.autoChecks) ? file.autoChecks.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : undefined
  const plan: CheckPlan = listed ? { commands: listed, source: '.drove.json autoChecks' } : await checksOf(repo)
  if (plan.commands.length === 0) return undefined
  const attempts = [file?.autoCheckAttempts, config?.autoCheckAttempts].find(isWhole) ?? DEFAULT_ATTEMPTS
  return { plan, attempts }
}

// Only an implementer's done report that asks for a review is checked: a reviewer or a tester runs checks itself, and a
// done that confirms an approved commit (expects none) has nothing left to review.
export const isCheckable = (report: Report, seat: Seat | undefined): boolean =>
  report.kind === 'done' && report.expects === 'review' && report.for !== 'human' && seat !== undefined && (seat.role ?? 'implementer') === 'implementer'

export type AutoCheckResult =
  | { status: 'passed'; outcome: CheckOutcome }
  | { status: 'failed'; outcome: CheckOutcome; failed: CommandOutcome }
  | { status: 'error'; text: string }

export const runAutoCheck = async (deps: Deps, run: RunMeta, seat: Seat, plan: CheckPlan): Promise<AutoCheckResult> => {
  // Not `fresh`: a clean tree at a HEAD that already has a passing record is the same answer without the minutes.
  const result = await runChecks(deps, run, seat, { plan })
  if ('error' in result) return { status: 'error', text: result.error.text }
  return result.passed || !result.failed ? { status: 'passed', outcome: result } : { status: 'failed', outcome: result, failed: result.failed }
}

const treeOf = (outcome: CheckOutcome): string => (outcome.clean ? 'clean' : 'dirty')

// The line the planner reads with a done report whose checks passed.
export const passedLine = (outcome: CheckOutcome): string =>
  `Drove ran ${outcome.commands.map(entry => entry.command).join(', ')} at ${shortSha(outcome.sha)}: passed (${treeOf(outcome)})${outcome.reused ? `; recorded at ${outcome.at.slice(0, 19)}Z, not run again` : ''}`

const indented = (tail: string | undefined): string => (tail ?? '').split('\n').map(line => `  | ${line}`).join('\n') || '  | (no output)'

// The line the planner reads when the seat has used its attempts: it is the planner's to send back now.
export const exhaustedLine = (outcome: CheckOutcome, failed: CommandOutcome, attempts: number): string =>
  `Drove's checks failed ${attempts} times: ${failed.command} exited ${failed.exit} at ${shortSha(outcome.sha)} (${treeOf(outcome)}), so Drove did not send it back again. Last output:\n${indented(failed.tail)}`

export const errorLine = (text: string): string => `Drove could not run its checks on this report: ${text}`

export const unsentLine = (outcome: CheckOutcome, failed: CommandOutcome, reason: string): string =>
  `Drove's checks failed: ${failed.command} exited ${failed.exit} at ${shortSha(outcome.sha)} (${treeOf(outcome)}), and sending it back to the worker did not work (${reason}). Last output:\n${indented(failed.tail)}`

// What the worker reads: the command, its exit code and the tail, in a verdict that says it is Drove's and not the planner's.
export const failureBody = (outcome: CheckOutcome, failed: CommandOutcome, attempt: number, max: number): string =>
  [
    `Drove's checks failed on your done report (automatic check ${attempt} of ${max}; this verdict is Drove's, the planner has not seen the report).`,
    `${failed.command} exited ${failed.exit} at ${shortSha(outcome.sha)} (${outcome.clean ? 'clean tree' : 'uncommitted changes in the worktree'}). Last output:`,
    indented(failed.tail),
    ...outcome.notes,
    'Fix this, verify again, then send a done report.',
  ].join('\n')

// A deterministic id, so a delivery that already went out is not sent twice after a restart.
export const verdictFor = (run: RunMeta, seat: string, report: Report, body: string, at: string): Control => ({
  v: 1, id: `c-autocheck-${report.id}`, run: run.id, from: 'planner', to: seat, kind: 'verdict', expects: 'review', verdict: 'changes', body, at,
})

// The seat is gone or down: there is no one to send a verdict to, and its last done must still reach the planner.
export const skippedLine = (seat: string, state: string): string => `Drove did not run its checks on this report: ${seat} is ${state}.`
