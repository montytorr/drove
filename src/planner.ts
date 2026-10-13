import { join } from 'node:path'
import { getAgent } from './herdr.ts'
import { runDir } from './paths.ts'
import { loadRun } from './roster.ts'
import { appendJsonl, withLock, writeJsonAtomic } from './store.ts'
import type { Deps, RunMeta } from './types.ts'

// Persist once per planner launch, including across watcher restarts. A stale
// launch must never mark a replacement planner gone.
export const markPlannerUnavailable = async (deps: Deps, run: RunMeta, detail: string): Promise<void> => {
  await withLock(join(runDir(deps.home, run.id), 'roster.lock'), async () => {
    const current = await loadRun(deps.home, run.id)
    const sameLaunch = run.planner.launchId ? current?.planner.launchId === run.planner.launchId : current?.planner.paneId === run.planner.paneId && current?.planner.sessionId === run.planner.sessionId
    if (!current || current.status !== 'up' || current.planner.unavailable || !sameLaunch) return
    const at = deps.clock.now().toISOString()
    await writeJsonAtomic(join(runDir(deps.home, run.id), 'run.json'), { ...current, planner: { ...current.planner, ...(run.planner.sessionId && !current.planner.sessionId ? { sessionId: run.planner.sessionId } : {}), unavailable: { at, detail } } })
    await appendJsonl(join(runDir(deps.home, run.id), 'events.jsonl'), { at, type: 'attention', seat: 'planner', data: { reason: 'gone', detail } })
  })
}

export const plannerPaneMatches = async (deps: Deps, run: RunMeta, sessionId = run.planner.sessionId): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const current = await loadRun(deps.home, run.id)
  if (current?.planner.launchId !== run.planner.launchId || current?.planner.paneId !== run.planner.paneId) return { ok: false, reason: 'the planner launch has changed; reload the run' }
  const unavailable = current?.planner.unavailable ?? run.planner.unavailable
  if (unavailable) return { ok: false, reason: unavailable.detail }
  const pane = run.planner.paneId
  if (!pane || !sessionId) return { ok: false, reason: 'the planner pane or session is not known yet' }
  const live = await getAgent(deps.exec, pane)
  if (!live.ok) return { ok: false, reason: `the planner pane is not reachable: ${live.code}` }
  if (live.value.sessionId === sessionId) return { ok: true }
  const detail = `planner pane ${pane} now hosts another agent (agent_session ${live.value.sessionId ?? 'unset'}, expected ${sessionId}); run \`drove up --run ${run.id}\` to relaunch the planner`
  await markPlannerUnavailable(deps, run, detail)
  return { ok: false, reason: detail }
}
