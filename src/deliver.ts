import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentPromptArgv, agentSendKeysArgv, getAgent, readPane, readScreen, retryWhileBusy, run as runHerdr } from './herdr.ts'
import { formatControl, renderReports } from './protocol.ts'
import { PLANNER_SEAT, plannerDir, runDir, seatDir } from './paths.ts'
import { findSeat, loadRoster, updateRoster } from './roster.ts'
import { appendJsonl, readJsonlFrom, readToken, withLock } from './store.ts'
import type { Attention, Control, Delivery, DeliveryAdapter, Deps, DroveEvent, HookRecord, Report, RunMeta, Seat, Transport } from './types.ts'

export const RETRY_MS = 3_000
export const BUSY_RETRY_MS = 45_000
export const PLANNER_QUIET_MS = 5_000
export const MAX_ATTEMPTS = 5
export const confirmTiming = { waitMs: 4_000, pollMs: 250 }
export const workingWait = { maxMs: 45_000, pollMs: 1_000 }

const RANK: Partial<Record<Transport, number>> = { mod: 0, 'codex-queue': 1, 'herdr-prompt': 2 }
const BLOCKING_STATES: ReadonlySet<Seat['state']> = new Set(['blocked', 'needs-input'])
const DEAD_STATES: ReadonlySet<Seat['state']> = new Set(['closed', 'gone', 'down'])

const registered = new Map<Transport, DeliveryAdapter>()
const attempts = new Map<string, number>()
const plannerIdleSince = new Map<string, number>()

export const codexQueueArgv = (thread: string, text: string): string[] => ['codex', 'queue', '--thread', thread, '--message', text]

// `submitted`: herdr typed the text and stalled, and Drove pressed Enter itself (DROVE-124).
export type UnconfirmedDelivery = { ok: true; via: Transport; unconfirmed: true; submitted?: true }
export type SubmittedDelivery = { ok: true; via: Transport; submitted: true }

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const targetOf = (seat: Seat): string => seat.paneId ?? ''
const clip = (text: string, max = 300): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

export const recordEvent = async (deps: Deps, run: string, event: Omit<DroveEvent, 'at'>): Promise<void> => {
  await appendJsonl(join(runDir(deps.home, run), 'events.jsonl'), { at: deps.clock.now().toISOString(), ...event })
}

const describeFailure = (seat: Seat, code: string, output: string): string => {
  const detail = clip(output, 160)
  const suffix = detail ? ` (${detail})` : ''
  if (code === 'timeout') return `herdr did not answer in time while typing into ${seat.name}${suffix}`
  if (code === 'exit_124') return `herdr did not answer in time while typing into ${seat.name}; check the pane before sending again${suffix}`
  if (code === 'agent_not_found' || code === 'pane_not_found') return `${seat.name}'s pane is gone or unknown to herdr (${code})`
  if (code === 'agent_pane_busy') return `${seat.name}'s pane is busy and herdr would not take the text${suffix}`
  if (code === 'agent_blocked') return `${seat.name} is waiting at a dialog, so herdr cannot type into it`
  if (/^exit_\d+$/.test(code)) return `herdr refused to type into ${seat.name} (agent prompt exited ${code.slice(5)} with ${detail ? `"${detail}"` : 'no message'})`
  return `herdr could not type into ${seat.name}: ${code}${suffix}`
}

const waitForIdle = async (deps: Deps, target: string): Promise<'idle' | 'working' | 'gone'> => {
  for (let waited = 0; ; waited += workingWait.pollMs) {
    const live = await getAgent(deps.exec, target)
    if (!live.ok) return live.code === 'agent_not_found' || live.code === 'pane_not_found' ? 'gone' : 'working'
    if (live.value.status === 'idle' || live.value.status === 'done') return 'idle'
    if (waited >= workingWait.maxMs) return 'working'
    await sleep(workingWait.pollMs)
  }
}

const INPUT_LINES = 20
const INPUT_NEEDLE_CHARS = 160
const PROMPT_LINE = /^[\s│|]*[❯›>]\s?(.*)$/u
const PASTE_PLACEHOLDER = /^\[Pasted (?:text|content)\b/i

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim()

// The input line is the last prompt line on the screen; the ones above it are the transcript echoing turns already taken.
// It holds the text herdr typed when it shows a paste placeholder, or starts with the start of that text.
export const unsubmittedInput = (screen: string, text: string): boolean => {
  const line = screen.split('\n').slice(-INPUT_LINES).findLast(candidate => PROMPT_LINE.test(candidate))
  const input = squash((PROMPT_LINE.exec(line ?? '')?.[1] ?? '').replace(/[│|]\s*$/, ''))
  if (!input) return false
  const needle = squash(text.split('\n')[0] ?? '').slice(0, INPUT_NEEDLE_CHARS)
  return PASTE_PLACEHOLDER.test(input) || (needle.length >= 8 && input.startsWith(needle))
}

const STALLED_REASON = 'agent_prompt_stalled: herdr typed the text but saw no activity; it may still have landed, so check the pane before sending it again'

// herdr's `agent prompt` pastes the text and presses Enter; a long paste can swallow that Enter and leave `[Pasted text #1 +70 lines]`
// in the input of an idle agent. That is the one stall Drove can repair: press Enter once, then wait for the agent to show activity.
const submitStalled = async (deps: Deps, seat: Seat, target: string, text: string): Promise<Delivery | UnconfirmedDelivery | SubmittedDelivery | undefined> => {
  const byAgent = await readScreen(deps.exec, target, INPUT_LINES)
  const screen = byAgent.ok || !seat.paneId ? byAgent : await readPane(deps.exec, seat.paneId, INPUT_LINES)
  if (!screen.ok || !unsubmittedInput(screen.value, text)) return undefined
  const pressed = await runHerdr(deps.exec, agentSendKeysArgv(target, ['Enter']), 10_000)
  if (!pressed.ok) return { ok: false, queued: false, reason: `${STALLED_REASON}; the text sits unsubmitted in ${seat.name}'s input and herdr would not press Enter (${pressed.code})` }
  for (let waited = 0; ; waited += confirmTiming.pollMs) {
    const live = await getAgent(deps.exec, target)
    if (live.ok && (live.value.status === 'working' || live.value.status === 'blocked')) return { ok: true, via: 'herdr-prompt', submitted: true }
    if (waited >= confirmTiming.waitMs) return { ok: true, via: 'herdr-prompt', unconfirmed: true, submitted: true }
    await sleep(confirmTiming.pollMs)
  }
}

export const herdrPromptAdapter = (deps: Deps): DeliveryAdapter => ({
  transport: 'herdr-prompt',
  canDeliver: seat => Boolean(seat.paneId),
  deliver: async (seat, text): Promise<Delivery | UnconfirmedDelivery | SubmittedDelivery> => {
    const target = targetOf(seat)
    let ran = await retryWhileBusy(deps.exec, agentPromptArgv(target, text), BUSY_RETRY_MS)
    if (ran.ok) return { ok: true, via: 'herdr-prompt' }
    if (ran.code === 'timeout') return { ok: true, via: 'herdr-prompt', unconfirmed: true }
    if (ran.code === 'agent_blocked') return { ok: false, queued: true, reason: 'agent_blocked: the pane is waiting at a dialog' }
    if (ran.code === 'agent_prompt_stalled') {
      const live = await getAgent(deps.exec, target)
      if (live.ok && (live.value.status === 'working' || live.value.status === 'blocked')) return { ok: true, via: 'herdr-prompt' }
      if (live.ok && (live.value.status === 'idle' || live.value.status === 'done')) {
        const submitted = await submitStalled(deps, seat, target, text)
        if (submitted) return submitted
      }
      return { ok: false, queued: false, reason: STALLED_REASON }
    }
    // herdr can refuse a prompt while the agent is mid-turn, sometimes with no message at all (`exit_1:`).
    // Ask what the agent is doing instead of passing the bare exit code on.
    const live = await getAgent(deps.exec, target)
    if (!live.ok && (live.code === 'agent_not_found' || live.code === 'pane_not_found')) return { ok: false, queued: true, reason: describeFailure(seat, live.code, '') }
    if (live.ok && live.value.status === 'working') {
      const settled = await waitForIdle(deps, target)
      if (settled === 'gone') return { ok: false, queued: true, reason: describeFailure(seat, 'agent_not_found', '') }
      if (settled === 'working') return { ok: false, queued: true, reason: `${seat.name} is working; herdr would not take the text. It will be sent when the seat is idle` }
      ran = await retryWhileBusy(deps.exec, agentPromptArgv(target, text), BUSY_RETRY_MS)
      if (ran.ok) return { ok: true, via: 'herdr-prompt' }
      if (ran.code === 'timeout') return { ok: true, via: 'herdr-prompt', unconfirmed: true }
      if (ran.code === 'agent_blocked') return { ok: false, queued: true, reason: 'agent_blocked: the pane is waiting at a dialog' }
    }
    return { ok: false, queued: ran.code === 'agent_not_found' || ran.code === 'agent_pane_busy', reason: describeFailure(seat, ran.code, ran.output) }
  },
})

export const codexQueueAdapter = (deps: Deps): DeliveryAdapter => ({
  transport: 'codex-queue',
  canDeliver: seat => seat.kind === 'codex' && Boolean(seat.sessionId),
  deliver: async (seat, text) => {
    if (!seat.sessionId) return { ok: false, queued: false, reason: 'no codex thread id yet' }
    // The thread lives under the seat's own CODEX_HOME when Drove owns one (DROVE-34), not under ~/.codex.
    const ran = await deps.exec(codexQueueArgv(seat.sessionId, text), { timeoutMs: 15_000, ...(seat.codexHome ? { env: { CODEX_HOME: seat.codexHome } } : {}) })
    if (ran.code === 0) return { ok: true, via: 'codex-queue' }
    return { ok: false, queued: false, reason: `codex queue failed: ${clip(ran.stderr || ran.stdout)}` }
  },
})

export const registerAdapter = (adapter: DeliveryAdapter): void => {
  registered.set(adapter.transport, adapter)
}

export const unregisterAdapters = (): void => {
  registered.clear()
}

export const adaptersFor = (deps: Deps): DeliveryAdapter[] => [
  ...registered.values(),
  ...[codexQueueAdapter(deps), herdrPromptAdapter(deps)].filter(adapter => !registered.has(adapter.transport)),
]

export const chooseAdapter = (seat: Seat, adapters: readonly DeliveryAdapter[]): DeliveryAdapter | undefined =>
  [...adapters].sort((a, b) => (RANK[a.transport] ?? 9) - (RANK[b.transport] ?? 9)).find(adapter => adapter.canDeliver(seat))

export const isDeliverable = async (deps: Deps, seat: Seat): Promise<{ ok: true } | { ok: false; reason: string }> => {
  if (DEAD_STATES.has(seat.state)) return { ok: false, reason: `${seat.name} is ${seat.state}` }
  if (seat.state === 'needs-input') return { ok: false, reason: `${seat.name} is waiting for an approval` }
  if (!seat.paneId) return { ok: false, reason: `${seat.name} has no pane yet` }
  const live = await getAgent(deps.exec, targetOf(seat))
  if (!live.ok) return { ok: false, reason: live.code === 'unparseable' ? `${seat.name}: herdr gave no state` : describeFailure(seat, live.code, '') }
  if (live.value.status === 'blocked') return { ok: false, reason: `${seat.name} is blocked at a dialog` }
  return { ok: true }
}

const sentFile = (deps: Deps, run: string, seat: string): string => join(seatDir(deps.home, run, seat), 'sent.jsonl')
const pendingFile = (deps: Deps, run: string, seat: string): string => join(seatDir(deps.home, run, seat), 'pending.jsonl')
const pendingLock = (deps: Deps, run: string, seat: string): string => join(seatDir(deps.home, run, seat), 'pending.lock')

type Sent = { id: string; via: Transport; at: string }

const readAll = async <T>(path: string): Promise<T[]> => (await readJsonlFrom<T>(path, { offset: 0 })).items

const findSent = async (deps: Deps, run: string, seat: string, id: string): Promise<Sent | undefined> =>
  (await readAll<Sent>(sentFile(deps, run, seat))).find(entry => entry.id === id)

const rewritePending = async (path: string, controls: readonly Control[]): Promise<void> => {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, controls.map(control => `${JSON.stringify(control)}\n`).join(''), { mode: 0o600 })
  await rename(tmp, path)
}

const setAttention = async (deps: Deps, run: string, seat: string, reason: Attention['reason'], detail?: string): Promise<void> => {
  const at = deps.clock.now().toISOString()
  await updateRoster(deps.home, run, roster => ({
    ...roster,
    seats: roster.seats.map(entry =>
      entry.name === seat
        ? { ...entry, attention: [...entry.attention.filter(item => item.reason !== reason), ...(detail ? [{ seat, reason, detail, at }] : [])] }
        : entry,
    ),
  }))
}

const isReplyToOpenAsk = (seat: Seat, control: Control): boolean =>
  (control.kind === 'message' || control.kind === 'answer') && (seat.lastReport?.kind === 'question' || seat.lastReport?.kind === 'blocked')

// A verdict or an answer settles what the planner owed the seat; so does a message sent after the seat's question or block.
const clearsOwed = (control: Control): boolean => control.kind === 'answer' || control.kind === 'verdict'

// Only the report the planner answered is cleared: a newer one that arrived meanwhile still owes its answer.
const settleSent = (entry: Seat, sent: Seat, control: Control, isReply: boolean, sentAt: string): Seat => {
  const isStamped = control.expects !== 'none' || isReply
  const isSettled = (isReply || clearsOwed(control)) && entry.lastReport?.id === sent.lastReport?.id
  return { ...entry, ...(isStamped ? { lastSentAt: sentAt } : {}), ...(isSettled ? { owes: 'none' as const } : {}) }
}

const hooksFileOf = (deps: Deps, run: string, seat: Seat): string =>
  join(seat.name === PLANNER_SEAT ? plannerDir(deps.home, run) : seatDir(deps.home, run, seat.name), 'hooks.jsonl')

export const confirmedByHook = async (deps: Deps, run: string, seat: Seat, since: number): Promise<boolean> => {
  for (let waited = 0; ; waited += confirmTiming.pollMs) {
    const { items } = await readJsonlFrom<HookRecord>(hooksFileOf(deps, run, seat), { offset: 0 })
    if (items.some(hook => hook.event === 'user-prompt-submit' && Date.parse(hook.at) >= since)) return true
    if (waited >= confirmTiming.waitMs) return false
    await sleep(confirmTiming.pollMs)
  }
}

const attempt = async (deps: Deps, run: string, seat: Seat, control: Control): Promise<Delivery> => {
  const token = await readToken(join(seatDir(deps.home, run, seat.name), 'token'))
  if (!token) return { ok: false, queued: false, reason: `no token for ${seat.name}` }
  const adapter = chooseAdapter(seat, adaptersFor(deps))
  if (!adapter) return { ok: false, queued: false, reason: `no transport can reach ${seat.name} yet (no pane or thread)` }
  const typedAt = deps.clock.now().getTime()
  const typed = await adapter.deliver(seat, formatControl(control, token))
  const isSubmitted = typed.ok && 'submitted' in typed && Boolean(typed.submitted)
  const isHookConfirmed = typed.ok && 'unconfirmed' in typed && typed.unconfirmed && (await confirmedByHook(deps, run, seat, typedAt))
  const delivery: Delivery | UnconfirmedDelivery | SubmittedDelivery = typed.ok && isHookConfirmed ? { ok: true, via: typed.via, ...(isSubmitted ? { submitted: true as const } : {}) } : typed
  if (delivery.ok) {
    const sentAt = deps.clock.now().toISOString()
    await appendJsonl(sentFile(deps, run, seat.name), { id: control.id, via: delivery.via, at: sentAt } satisfies Sent)
    const isReply = isReplyToOpenAsk(seat, control)
    if (control.expects !== 'none' || isReply || clearsOwed(control)) await updateRoster(deps.home, run, roster => ({ ...roster, seats: roster.seats.map(entry => (entry.name === seat.name ? settleSent(entry, seat, control, isReply, sentAt) : entry)) }))
    const isUnconfirmed = 'unconfirmed' in delivery && delivery.unconfirmed
    await recordEvent(deps, run, { type: 'control.sent', seat: seat.name, id: control.id, data: { kind: control.kind, via: delivery.via, ...(control.verdict ? { verdict: control.verdict } : {}), ...(isUnconfirmed ? { unconfirmed: true } : {}), ...(isSubmitted ? { submitted: true } : {}) } })
    attempts.delete(control.id)
  }
  return delivery
}

const queue = async (deps: Deps, run: string, seat: string, control: Control, reason: string): Promise<Delivery> => {
  await withLock(pendingLock(deps, run, seat), async () => {
    const waiting = await readAll<Control>(pendingFile(deps, run, seat))
    if (!waiting.some(entry => entry.id === control.id)) await appendJsonl(pendingFile(deps, run, seat), control)
  })
  await recordEvent(deps, run, { type: 'control.queued', seat, id: control.id, data: { kind: control.kind, reason: clip(reason) } })
  await setAttention(deps, run, seat, 'pending-delivery', `${control.kind} ${control.id} is waiting: ${clip(reason, 120)}`)
  return { ok: false, queued: true, reason }
}

const fail = async (deps: Deps, run: string, seat: string, control: Control, reason: string): Promise<Delivery> => {
  await recordEvent(deps, run, { type: 'control.failed', seat, id: control.id, data: { kind: control.kind, reason: clip(reason) } })
  if (reason.startsWith('agent_prompt_stalled')) await setAttention(deps, run, seat, 'stalled', clip(reason, 160))
  return { ok: false, queued: false, reason }
}

export const deliverControl = async (deps: Deps, run: RunMeta, control: Control): Promise<Delivery> => {
  const seatName = control.to
  const roster = await loadRoster(deps.home, run.id)
  const seat = findSeat(roster, seatName)
  if (!seat || DEAD_STATES.has(seat.state)) return { ok: false, queued: false, reason: `no open seat named ${seatName}` }
  const already = await findSent(deps, run.id, seatName, control.id)
  if (already) return { ok: true, via: already.via }
  const deliverable = await isDeliverable(deps, seat)
  if (!deliverable.ok) return queue(deps, run.id, seatName, control, deliverable.reason)
  const delivery = await attempt(deps, run.id, seat, control)
  if (delivery.ok) return delivery
  return delivery.queued ? queue(deps, run.id, seatName, control, delivery.reason) : fail(deps, run.id, seatName, control, delivery.reason)
}

export const flushPending = async (deps: Deps, run: RunMeta, seatName: string): Promise<Delivery[]> =>
  withLock(pendingLock(deps, run.id, seatName), async () => {
    const waiting = await readAll<Control>(pendingFile(deps, run.id, seatName))
    if (waiting.length === 0) return []
    const seat = findSeat(await loadRoster(deps.home, run.id), seatName)
    if (!seat || DEAD_STATES.has(seat.state)) return [{ ok: false, queued: true, reason: `${seatName} is not open` }]
    const deliverable = await isDeliverable(deps, seat)
    if (!deliverable.ok) return [{ ok: false, queued: true, reason: deliverable.reason }]
    const results: Delivery[] = []
    const remaining: Control[] = []
    let isHalted = false
    for (const control of waiting) {
      if (isHalted) {
        remaining.push(control)
        continue
      }
      const already = await findSent(deps, run.id, seatName, control.id)
      if (already) continue
      const delivery = await attempt(deps, run.id, seat, control)
      results.push(delivery)
      if (delivery.ok) continue
      const count = (attempts.get(control.id) ?? 0) + 1
      attempts.set(control.id, count)
      if (delivery.queued || count < MAX_ATTEMPTS) {
        remaining.push(control)
        isHalted = true
      } else {
        await fail(deps, run.id, seatName, control, delivery.reason)
        attempts.delete(control.id)
      }
    }
    await rewritePending(pendingFile(deps, run.id, seatName), remaining)
    if (remaining.length === 0) await setAttention(deps, run.id, seatName, 'pending-delivery')
    return results
  })

const plannerSeat = (run: RunMeta): Seat => ({
  name: PLANNER_SEAT,
  kind: run.planner.kind,
  model: run.planner.model,
  effort: run.planner.effort,
  ...(run.planner.paneId ? { paneId: run.planner.paneId } : {}),
  ...(run.planner.sessionId ? { sessionId: run.planner.sessionId } : {}),
  worktree: run.repo,
  branch: '',
  state: 'idle',
  stateAt: run.createdAt,
  spawnedAt: run.createdAt,
  owes: 'none',
  attention: [],
})

export const plannerSessionId = async (deps: Deps, run: RunMeta): Promise<string | undefined> => {
  const records = await readAll<HookRecord>(join(plannerDir(deps.home, run.id), 'hooks.jsonl'))
  return records.findLast(record => record.event === 'session-start' && record.sessionId)?.sessionId
}

export const wakePlanner = async (deps: Deps, run: RunMeta, reports: readonly Report[], humanName = 'the human'): Promise<Delivery> => {
  const text = renderReports(reports, humanName)
  let planner = plannerSeat(run)
  const live = planner.paneId ? await getAgent(deps.exec, planner.paneId) : undefined
  if (live?.ok && live.value.status === 'blocked') return { ok: false, queued: false, reason: 'the planner pane is blocked at a dialog' }
  const sessionId = planner.sessionId ?? (await plannerSessionId(deps, run)) ?? (live?.ok ? live.value.sessionId : undefined)
  if (sessionId) planner = { ...planner, sessionId }
  const mod = registered.get('mod')
  if (mod?.canDeliver(planner)) return mod.deliver(planner, text)
  if (planner.kind === 'codex' && planner.sessionId) return codexQueueAdapter(deps).deliver(planner, text)
  if (planner.kind === 'codex') return { ok: false, queued: false, reason: 'the codex planner has no thread id yet' }
  if (!planner.paneId || !live?.ok) return { ok: false, queued: false, reason: 'the planner pane is not reachable' }
  const nowMs = deps.clock.now().getTime()
  if (live.value.status !== 'idle' && live.value.status !== 'done') {
    plannerIdleSince.delete(run.id)
    return { ok: false, queued: false, reason: `the planner is ${live.value.status}` }
  }
  const since = plannerIdleSince.get(run.id) ?? nowMs
  plannerIdleSince.set(run.id, since)
  if (nowMs - since < PLANNER_QUIET_MS) return { ok: false, queued: false, reason: 'the planner has not been idle for 5 s yet' }
  const delivery = await herdrPromptAdapter(deps).deliver(planner, text)
  if (delivery.ok) plannerIdleSince.delete(run.id)
  return delivery
}
