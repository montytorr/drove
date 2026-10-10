import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentPromptArgv, getAgent, retryWhileBusy } from './herdr.ts'
import { formatControl, renderReports } from './protocol.ts'
import { PLANNER_SEAT, plannerDir, runDir, seatDir } from './paths.ts'
import { findSeat, loadRoster, updateRoster } from './roster.ts'
import { appendJsonl, readJsonlFrom, readToken, withLock } from './store.ts'
import type { Attention, Control, Delivery, DeliveryAdapter, Deps, DroveEvent, HookRecord, Report, RunMeta, Seat, Transport } from './types.ts'

export const RETRY_MS = 3_000
export const BUSY_RETRY_MS = 45_000
export const PLANNER_QUIET_MS = 5_000
export const MAX_ATTEMPTS = 5

const RANK: Partial<Record<Transport, number>> = { mod: 0, 'codex-queue': 1, 'herdr-prompt': 2 }
const BLOCKING_STATES: ReadonlySet<Seat['state']> = new Set(['blocked', 'needs-input'])
const DEAD_STATES: ReadonlySet<Seat['state']> = new Set(['closed', 'gone', 'down'])

const registered = new Map<Transport, DeliveryAdapter>()
const attempts = new Map<string, number>()
const plannerIdleSince = new Map<string, number>()

export const codexQueueArgv = (thread: string, text: string): string[] => ['codex', 'queue', '--thread', thread, '--message', text]

export type UnconfirmedDelivery = { ok: true; via: Transport; unconfirmed: true }

const targetOf = (seat: Seat): string => seat.paneId ?? ''
const clip = (text: string, max = 300): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

export const recordEvent = async (deps: Deps, run: string, event: Omit<DroveEvent, 'at'>): Promise<void> => {
  await appendJsonl(join(runDir(deps.home, run), 'events.jsonl'), { at: deps.clock.now().toISOString(), ...event })
}

export const herdrPromptAdapter = (deps: Deps): DeliveryAdapter => ({
  transport: 'herdr-prompt',
  canDeliver: seat => Boolean(seat.paneId),
  deliver: async (seat, text): Promise<Delivery | UnconfirmedDelivery> => {
    const target = targetOf(seat)
    const ran = await retryWhileBusy(deps.exec, agentPromptArgv(target, text), BUSY_RETRY_MS)
    if (ran.ok) return { ok: true, via: 'herdr-prompt' }
    if (ran.code === 'timeout') return { ok: true, via: 'herdr-prompt', unconfirmed: true }
    if (ran.code === 'agent_blocked') return { ok: false, queued: true, reason: 'agent_blocked: the pane is waiting at a dialog' }
    if (ran.code === 'agent_not_found' || ran.code === 'agent_pane_busy') return { ok: false, queued: true, reason: `${ran.code}: ${clip(ran.output)}` }
    if (ran.code === 'agent_prompt_stalled') {
      const live = await getAgent(deps.exec, target)
      if (live.ok && (live.value.status === 'working' || live.value.status === 'blocked')) return { ok: true, via: 'herdr-prompt' }
      return { ok: false, queued: false, reason: 'agent_prompt_stalled: herdr typed the text but saw no activity; it may still have landed, so check the pane before sending it again' }
    }
    return { ok: false, queued: false, reason: `${ran.code}: ${clip(ran.output)}` }
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
  if (!live.ok) return { ok: false, reason: live.code === 'unparseable' ? `${seat.name}: herdr gave no state` : `${seat.name}: ${live.code}` }
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

const attempt = async (deps: Deps, run: string, seat: Seat, control: Control): Promise<Delivery> => {
  const token = await readToken(join(seatDir(deps.home, run, seat.name), 'token'))
  if (!token) return { ok: false, queued: false, reason: `no token for ${seat.name}` }
  const adapter = chooseAdapter(seat, adaptersFor(deps))
  if (!adapter) return { ok: false, queued: false, reason: `no transport can reach ${seat.name} yet (no pane or thread)` }
  const delivery = await adapter.deliver(seat, formatControl(control, token))
  if (delivery.ok) {
    const sentAt = deps.clock.now().toISOString()
    await appendJsonl(sentFile(deps, run, seat.name), { id: control.id, via: delivery.via, at: sentAt } satisfies Sent)
    await updateRoster(deps.home, run, roster => ({ ...roster, seats: roster.seats.map(entry => (entry.name === seat.name ? { ...entry, lastSentAt: sentAt } : entry)) }))
    const isUnconfirmed = 'unconfirmed' in delivery && delivery.unconfirmed
    await recordEvent(deps, run, { type: 'control.sent', seat: seat.name, id: control.id, data: { kind: control.kind, via: delivery.via, ...(isUnconfirmed ? { unconfirmed: true } : {}) } })
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
