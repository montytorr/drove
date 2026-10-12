import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readLedger } from './checks.ts'
import { runDir } from './paths.ts'
import { verdictOf } from './report.ts'
import { loadRoster, loadRun } from './roster.ts'
import type { Deps, DroveEvent, Report, Seat } from './types.ts'

// DROVE-131: deterministic detectors over a run's records. They say why the run needed rework and where the fix belongs,
// the way a failure detector sorts a trace; none of them calls a model. The evidence of each is in DESIGN.md.

export type FixWhere = 'brief' | 'role text' | 'config' | 'repo' | 'planning' | 'Drove'
export type Category =
  | 'scope-too-narrow'
  | 'checks-failed-at-done'
  | 'review-loop'
  | 'no-acceptance'
  | 'merge-conflict'
  | 'ci-only-failure'
  | 'brief-not-delivered'
  | 'budget-hit'
  | 'usage-limit'
  | 'guard-thrash'
  | 'steering'

export type Finding = {
  category: Category
  seat: string
  confidence: 'high' | 'medium'
  evidence: string
  fix: { where: FixWhere; text: string }
  // The other seats a finding involves (a merge conflict's counterparts).
  with?: string[]
}

export type Diagnosis = { run: string; findings: Finding[]; summary: string }

const ORDER: Category[] = ['scope-too-narrow', 'no-acceptance', 'review-loop', 'checks-failed-at-done', 'ci-only-failure', 'merge-conflict', 'brief-not-delivered', 'budget-hit', 'usage-limit', 'guard-thrash', 'steering']

const STEER_RULES: [string, string, Finding['fix']][] = [
  ['R1', 'repeated failure', { where: 'role text', text: 'say in the brief or the role text what to do when the same call keeps failing (stop and report blocked, or try another approach)' }],
  ['R2', 'done without a check', { where: 'config', text: 'set autoChecks, or add the check command to the role text so the seat verifies before it reports done' }],
]

const RUN_SEAT = 'planner'
const MAX_SHOWN = 3

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const firstLine = (value: string, max = 100): string => {
  const line = value.split('\n').map(item => item.trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`
const listed = (items: readonly string[], max = MAX_SHOWN): string => `${items.slice(0, max).join(', ')}${items.length > max ? `, +${items.length - max} more` : ''}`
const uniq = <T>(items: readonly T[]): T[] => [...new Set(items)]

const readJsonl = async <T>(path: string): Promise<T[]> => {
  const raw = await readFile(path, 'utf8').catch(() => '')
  const items: T[] = []
  for (const row of raw.split('\n')) {
    if (!row.trim()) continue
    try {
      items.push(JSON.parse(row) as T)
    } catch {
      // a line cut by a crash
    }
  }
  return items
}

const kindOf = (event: DroveEvent): string => event.type as string

type LedgerRecord = Awaited<ReturnType<typeof readLedger>>[number]

type SeatRecords = { name: string; events: DroveEvent[]; reports: Report[]; hasAcceptance: boolean }

// A seat has acceptance criteria when its roster entry keeps them, its brief carries the section, or a report was stamped with a count.
const hasAcceptance = (seat: Seat | undefined, brief: string, reports: readonly Report[]): boolean =>
  (seat?.acceptance?.length ?? 0) > 0 || /^## Acceptance\b/m.test(brief) || reports.some(report => (report.acceptance ?? 0) > 0)

// ---------- git: what a seat's branch touched ----------

const gitOut = async (deps: Deps, repo: string, args: string[]): Promise<string | undefined> => {
  try {
    const ran = await deps.exec(['git', '-C', repo, ...args], { timeoutMs: 30_000 })
    return ran.code === 0 ? ran.stdout : undefined
  } catch {
    return undefined
  }
}

const lines = (out: string | undefined): string[] => (out ?? '').split('\n').map(line => line.trim()).filter(Boolean)

// The files a branch changed against the base. A branch already merged has nothing left against the base, so its merge commit is read instead.
const touched = async (deps: Deps, repo: string, base: string, branch: string): Promise<string[] | undefined> => {
  if ((await gitOut(deps, repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])) === undefined) return undefined
  const tip = (await gitOut(deps, repo, ['rev-parse', `refs/heads/${branch}`]))?.trim()
  const merged = (await gitOut(deps, repo, ['merge-base', '--is-ancestor', branch, base])) !== undefined
  if (!merged) return lines(await gitOut(deps, repo, ['diff', '--name-only', `${base}...${branch}`]))
  const merges = lines(await gitOut(deps, repo, ['log', '--first-parent', '--merges', '--format=%H %P', base]))
  const found = merges.map(row => row.split(' ')).find(parts => parts[3] === undefined && parts[2] === tip)
  return found?.[0] ? lines(await gitOut(deps, repo, ['diff', '--name-only', `${found[0]}^1`, found[0]])) : []
}

// ---------- detectors ----------

type Context = {
  deps: Deps
  repo: string
  base: string
  seats: SeatRecords[]
  roster: readonly Seat[]
  events: readonly DroveEvent[]
  ledger: readonly LedgerRecord[]
}

const scopeTooNarrow = (seat: SeatRecords): Finding[] => {
  const denied = seat.events.filter(event => kindOf(event) === 'guard.denied' && event.data?.rule === 'owns')
  const widened = seat.events.filter(event => {
    if (kindOf(event) !== 'seat.owns') return false
    const given = (event.data?.owns as unknown[] | undefined) ?? []
    const previous = event.data?.previous as unknown[] | undefined
    return event.data?.mode === 'add' || (previous !== undefined && given.some(item => !previous.includes(item)))
  })
  if (denied.length === 0 && widened.length === 0) return []
  const paths = uniq(denied.map(event => text(event.data?.path)).filter(Boolean))
  const added = uniq(widened.flatMap(event => ((event.data?.owns as unknown[] | undefined) ?? []).filter((item): item is string => typeof item === 'string')))
  const first = denied[0] ? Date.parse(denied[0].at) : Number.NaN
  const isAfter = widened.some(event => Number.isNaN(first) || Date.parse(event.at) >= first)
  const parts = [
    ...(denied.length > 0 ? [`${plural(denied.length, 'owns denial')}${paths.length ? ` (${listed(paths)})` : ''}`] : []),
    ...(widened.length > 0 ? [`${denied.length > 0 && isAfter ? 'then ' : ''}owns widened${added.length ? ` (${listed(added)})` : ''}`] : []),
  ]
  return [{
    category: 'scope-too-narrow',
    seat: seat.name,
    confidence: denied.length > 0 && widened.length > 0 ? 'high' : 'medium',
    evidence: parts.join(', '),
    fix: { where: 'brief', text: `give the seat the mirror paths up front${paths.length ? ` (${listed(paths, 2)} and the files that mirror them)` : ', e.g. mod/types/index.d.ts with src/types.ts'}` },
  }]
}

const reviewLoop = (seat: SeatRecords): Finding[] => {
  const changes = seat.events.flatMap((event, index) => (kindOf(event) === 'control.sent' && event.data?.kind === 'verdict' && verdictOf(event, seat.events.slice(index + 1)) === 'changes' ? [event] : []))
  const result: Finding[] = []
  if (changes.length >= 2) {
    const notes = changes.map(event => `«${firstLine(text(event.data?.notes)) || 'notes not recorded'}»`)
    result.push({
      category: 'review-loop',
      seat: seat.name,
      confidence: 'high',
      evidence: `${changes.length} changes verdicts: ${listed(notes, 4)}`,
      fix: { where: 'brief', text: seat.hasAcceptance ? 'the acceptance criteria were too vague to settle what done is: make each one testable and name the check' : 'the seat had no acceptance criteria: spawn with --acceptance' },
    })
  }
  if (changes.length >= 1 && !seat.hasAcceptance) {
    result.push({
      category: 'no-acceptance',
      seat: seat.name,
      confidence: 'high',
      evidence: `spawned without acceptance criteria and needed ${plural(changes.length, 'changes verdict')}`,
      fix: { where: 'brief', text: 'spawn with --acceptance, one testable statement per criterion' },
    })
  }
  return result
}

const failedChecksAt = (seat: SeatRecords): { events: DroveEvent[]; viaPr: boolean } => {
  const failing: DroveEvent[] = []
  let viaPr = false
  let done = false
  for (const event of seat.events) {
    const type = kindOf(event)
    if (type === 'report' && event.data?.kind === 'done') done = true
    if (!done) continue
    const refusedByChecks = type === 'merge.refused' && event.data?.code === 'checks-failed'
    if (type === 'checks.ran' && event.data?.passed === false) failing.push(event)
    else if (type === 'autocheck.failed') failing.push(event)
    else if (refusedByChecks) {
      failing.push(event)
      if (text(event.data?.url)) viaPr = true
    }
  }
  return { events: failing, viaPr }
}

// A PR whose checks failed while the seat's own check run passed: the pass is read from the last check run before the
// refusal, else from the ledger's last records of the seat (all of them at one sha, all exiting 0).
const localPassBefore = (seat: SeatRecords, refused: DroveEvent, ledger: readonly LedgerRecord[]): string | undefined => {
  const stamp = Date.parse(refused.at)
  const last = seat.events.filter(event => kindOf(event) === 'checks.ran' && Date.parse(event.at) <= stamp).at(-1)
  if (last) return last.data?.passed === true ? text(last.data?.sha) || 'unknown' : undefined
  const mine = ledger.filter(record => record.seat === seat.name && Date.parse(record.at) <= stamp)
  const sha = mine.at(-1)?.sha
  return sha && mine.filter(record => record.sha === sha).every(record => record.exit === 0) ? sha : undefined
}

const checksAndCi = (seat: SeatRecords, ledger: readonly LedgerRecord[]): Finding[] => {
  const prRefusals = seat.events.filter(event => kindOf(event) === 'merge.refused' && event.data?.code === 'checks-failed' && text(event.data?.url))
  const ciOnly = prRefusals.filter(event => localPassBefore(seat, event, ledger) !== undefined)
  const result: Finding[] = []
  if (ciOnly.length > 0) {
    const refused = ciOnly[0] as DroveEvent
    const sha = localPassBefore(seat, refused, ledger) as string
    const failing = Array.isArray(refused.data?.failing) ? (refused.data?.failing as unknown[]).map(String) : []
    const exact = [text(refused.data?.sha), text(refused.data?.checkedSha)].includes(sha) && sha !== 'unknown'
    result.push({
      category: 'ci-only-failure',
      seat: seat.name,
      confidence: exact ? 'high' : 'medium',
      evidence: `${text(refused.data?.url)} failed${failing.length ? ` (${listed(failing)})` : ''} while the local checks passed${sha === 'unknown' ? '' : ` at ${sha.slice(0, 7)}`}`,
      fix: { where: 'repo', text: 'a test depends on the environment: make it run the same on a checkout with no main branch and no local state' },
    })
  }
  const { events, viaPr } = failedChecksAt(seat)
  const rest = events.filter(event => !ciOnly.includes(event))
  if (rest.length > 0) {
    const last = rest[rest.length - 1] as DroveEvent
    const named = text(last.data?.failed) || text(last.data?.check) || (Array.isArray(last.data?.failing) ? (last.data?.failing as unknown[]).map(String).join(', ') : '')
    const onlyPr = viaPr && rest.every(event => kindOf(event) === 'merge.refused')
    result.push({
      category: 'checks-failed-at-done',
      seat: seat.name,
      confidence: onlyPr ? 'medium' : 'high',
      evidence: `${plural(rest.length, 'failing check run')} after a done report${named ? ` (${named})` : ''}`,
      fix: { where: 'config', text: "set autoChecks so the seat's checks run before it can report done, or add the check command to the role text's MUST list" },
    })
  }
  return result
}

const mergeConflicts = async (seat: SeatRecords, context: Context): Promise<Finding[]> => {
  const refusals = seat.events.filter(event => kindOf(event) === 'merge.refused' && (event.data?.code === 'merge-conflict' || event.data?.code === 'pr-conflicts'))
  if (refusals.length === 0) return []
  const own = context.roster.find(item => item.name === seat.name)
  const branch = own?.branch ?? text(refusals[0]?.data?.branch)
  const mine = branch ? await touched(context.deps, context.repo, context.base, branch) : undefined
  const overlaps: { seat: string; files: string[] }[] = []
  if (mine && mine.length > 0) {
    for (const other of context.roster) {
      if (other.name === seat.name) continue
      const theirs = await touched(context.deps, context.repo, context.base, other.branch)
      const shared = theirs ? mine.filter(file => theirs.includes(file)) : []
      if (shared.length > 0) overlaps.push({ seat: other.name, files: shared })
    }
  }
  const code = text(refusals[0]?.data?.code)
  if (overlaps.length === 0) {
    return [{
      category: 'merge-conflict',
      seat: seat.name,
      confidence: 'medium',
      evidence: `${plural(refusals.length, 'merge refusal')} (${code}); no other seat's branch touched the same files, or its branch is gone`,
      fix: { where: 'planning', text: 'have the seat merge the base into its branch before it reports done, and give each seat its own files' },
    }]
  }
  const files = uniq(overlaps.flatMap(item => item.files))
  const others = overlaps.map(item => item.seat)
  return [{
    category: 'merge-conflict',
    seat: seat.name,
    confidence: 'high',
    evidence: `${plural(refusals.length, 'merge refusal')} (${code}); ${[seat.name, ...others].join(' and ')} both touched ${listed(files)}`,
    fix: { where: 'planning', text: `seats overlapped on ${listed(files, 2)}: split the files between seats, or run the seats one after the other` },
    with: others,
  }]
}

const delivery = (seat: SeatRecords): Finding[] => {
  const stalls = seat.events.filter(event => {
    const type = kindOf(event)
    const reason = `${text(event.data?.reason)} ${text(event.data?.detail)}`
    if (type === 'control.failed' || type === 'seat.start_failed') return true
    if (type === 'attention') return event.data?.reason === 'pending-delivery' || (event.data?.reason === 'stalled' && reason.includes('prompt_stalled'))
    if (type === 'seat.spawn') return event.data?.startTimeout === true || typeof event.data?.startError === 'string'
    return type === 'control.sent' && event.data?.kind === 'brief' && (event.data?.unconfirmed === true || event.data?.submitted === true)
  })
  if (stalls.length === 0) return []
  const sure = stalls.some(event => kindOf(event) === 'control.failed' || kindOf(event) === 'seat.start_failed' || text(event.data?.detail).includes('prompt_stalled'))
  const why = uniq(stalls.map(event => firstLine(text(event.data?.reason) || text(event.data?.detail) || text(event.data?.startError) || (kindOf(event) === 'control.sent' ? (event.data?.submitted === true ? 'brief stalled unsubmitted, Drove pressed Enter' : 'brief sent but not confirmed') : kindOf(event)), 80)))
  return [{
    category: 'brief-not-delivered',
    seat: seat.name,
    confidence: sure ? 'high' : 'medium',
    evidence: `${plural(stalls.length, 'stalled or failed delivery')}: ${listed(why, 2)}`,
    fix: { where: 'Drove', text: 'check the pane before sending the text again; a brief that stays unsubmitted is a delivery bug to report, not a brief to rewrite' },
  }]
}

const attentionFindings = (seat: SeatRecords): Finding[] => {
  const of = (reason: string) => seat.events.filter(event => kindOf(event) === 'attention' && event.data?.reason === reason)
  const result: Finding[] = []
  const budget = [...of('budget'), ...of('run-budget')]
  if (budget.length > 0) {
    result.push({
      category: 'budget-hit',
      seat: seat.name,
      confidence: 'high',
      evidence: `${plural(budget.length, 'budget notice')}${text(budget[0]?.data?.detail) ? `: ${firstLine(text(budget[0]?.data?.detail), 90)}` : ''}`,
      fix: { where: 'config', text: 'raise the limit (maxTurns, maxTokens, maxMinutes, maxCost or the run cost) or split the task into smaller seats' },
    })
  }
  const usage = of('usage-limit')
  if (usage.length > 0) {
    result.push({
      category: 'usage-limit',
      seat: seat.name,
      confidence: 'high',
      evidence: `${plural(usage.length, 'usage-limit notice')}${text(usage[0]?.data?.detail) ? `: ${firstLine(text(usage[0]?.data?.detail), 90)}` : ''}`,
      fix: { where: 'config', text: "wait for the account's limit to reset, or migrate the seat to the other agent" },
    })
  }
  const thrash = of('guard-thrash')
  if (thrash.length > 0) {
    const rules = uniq(thrash.map(event => text(event.data?.rule)).filter(Boolean))
    result.push({
      category: 'guard-thrash',
      seat: seat.name,
      confidence: 'high',
      evidence: `${plural(thrash.length, 'guard-thrash notice')}${rules.length ? ` (rule ${rules.join(', ')})` : ''}`,
      fix: { where: 'brief', text: 'say what the seat may and may not do (files, commands, the read-only rule), so it does not retry a refused call' },
    })
  }
  // DROVE-127: a `steer.nudged` event, with the rule that fired: R1 a repeated failure, R2 a done report without a check.
  for (const [rule, label, fix] of STEER_RULES) {
    const nudges = seat.events.filter(event => kindOf(event) === 'steer.nudged' && event.data?.rule === rule)
    if (nudges.length === 0) continue
    const detail = firstLine(text(nudges[0]?.data?.detail), 90)
    result.push({
      category: 'steering',
      seat: seat.name,
      confidence: 'high',
      evidence: `${plural(nudges.length, 'steering nudge')}, ${rule} ${label}${detail ? `: ${detail}` : ''}`,
      fix,
    })
  }
  return result
}

// ---------- the diagnosis ----------

export const diagnoseRun = async (deps: Deps, runId: string): Promise<Diagnosis | undefined> => {
  const run = await loadRun(deps.home, runId)
  if (!run) return undefined
  const dir = runDir(deps.home, run.id)
  const roster = (await loadRoster(deps.home, run.id)).seats
  const events = (await readJsonl<DroveEvent>(join(dir, 'events.jsonl'))).filter(event => typeof event?.at === 'string' && typeof event.type === 'string')
  const ledger = await readLedger(deps.home, run.id)
  const names = uniq([...roster.map(seat => seat.name), ...events.map(event => event.seat ?? RUN_SEAT)])
  const seats: SeatRecords[] = []
  for (const name of names) {
    const own = events.filter(event => (event.seat ?? RUN_SEAT) === name)
    const reports = await readJsonl<Report>(join(dir, 'seats', name, 'outbox.jsonl'))
    const brief = await readFile(join(dir, 'seats', name, 'brief.md'), 'utf8').catch(() => '')
    seats.push({ name, events: own, reports, hasAcceptance: hasAcceptance(roster.find(seat => seat.name === name), brief, reports) })
  }
  const context: Context = { deps, repo: run.repo, base: run.base.replace(/^origin\//, ''), seats, roster, events, ledger }

  const findings: Finding[] = []
  for (const seat of seats) {
    const isWorker = seat.name !== RUN_SEAT
    if (isWorker) findings.push(...scopeTooNarrow(seat), ...reviewLoop(seat), ...checksAndCi(seat, ledger), ...(await mergeConflicts(seat, context)))
    findings.push(...delivery(seat), ...attentionFindings(seat))
  }
  findings.sort((a, b) => a.seat.localeCompare(b.seat) || ORDER.indexOf(a.category) - ORDER.indexOf(b.category))
  return { run: run.id, findings, summary: summaryOf(run.id, findings) }
}

const summaryOf = (run: string, findings: readonly Finding[]): string => {
  if (findings.length === 0) return `drove diagnose: no findings in run ${run}`
  const counts = new Map<string, number>()
  for (const finding of findings) counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1)
  const seats = uniq(findings.map(finding => finding.seat))
  return `drove diagnose: ${plural(findings.length, 'finding')} on ${plural(seats.length, 'seat')} in run ${run}: ${[...counts].map(([category, count]) => `${count} ${category}`).join(', ')}`
}

export const findingLine = (finding: Finding): string =>
  [finding.category, finding.seat, finding.confidence, finding.evidence, `${finding.fix.text} (where: ${finding.fix.where})`].join(' · ')

export const renderDiagnosis = (diagnosis: Diagnosis): string =>
  diagnosis.findings.length === 0 ? 'no findings' : [...diagnosis.findings.map(findingLine), '', diagnosis.summary].join('\n')

// One line for `drove report`, only when a run has findings.
export const reportPointer = (diagnosis: Diagnosis): string | undefined =>
  diagnosis.findings.length === 0 ? undefined : `${plural(diagnosis.findings.length, 'finding')} on why this run needed rework: drove diagnose ${diagnosis.run}`
