import assert from 'node:assert/strict'
import { appendFile, mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { seatDir } from '../src/paths.ts'
import { loadRoster } from '../src/roster.ts'
import type { Seat } from '../src/types.ts'
import { createWatcher } from '../src/watch.ts'
import { FakeHerdr, makeDeps, makeSeat, seedRun, tmp } from './p3-helpers.ts'

// DROVE-109: a seat asks for a permission, the permission is approved in the pane, the agent goes on and writes its
// transcript, and no Stop follows. herdr reports idle throughout. No hook fires on the approval, so the transcript is
// the only sign the seat went on.

const START = Date.parse('2026-10-11T20:00:00.000Z')
const ASKED = START + 10_000
const iso = (ms: number) => new Date(ms).toISOString()

const replay = async (transcriptWrites: number[]) => {
  const fake = new FakeHerdr()
  const deps = await makeDeps(fake, 'permission-replay')
  deps.clock.advance(START - deps.clock.now().getTime())
  const seat = makeSeat('w-perm', { state: 'working', stateAt: iso(START), spawnedAt: iso(START), lastWorkingAt: iso(START), paneId: 'w1:p-w-perm' })
  const run = await seedRun(deps, '/repo', [seat], { planner: { kind: 'codex', sessionId: 'thread-1', model: 'gpt-5', effort: 'high', viaMod: false } })
  const dir = seatDir(deps.home, run.id, 'w-perm')
  await mkdir(dir, { recursive: true })
  const transcript = join(await tmp('transcript'), 'w-perm.jsonl')
  await writeFile(transcript, '')
  fake.agents.set('w-perm', { name: 'w-perm', paneId: 'w1:p-w-perm', tabId: 'w1:t1', status: 'idle' })
  const hook = (event: string, at: number, detail?: string) =>
    appendFile(join(dir, 'hooks.jsonl'), `${JSON.stringify({ at: iso(at), agent: 'claude', event, sessionId: 's-1', transcript, ...(detail ? { detail } : {}) })}\n`)

  const watcher = createWatcher(deps, run, { loop: false })
  const stateAt = async (when: number): Promise<Seat['state']> => {
    const now = deps.clock.now().getTime()
    if (when > now) deps.clock.advance(when - now)
    await watcher.tick()
    return (await loadRoster(deps.home, run.id)).seats[0]!.state
  }
  await hook('session-start', START)
  await hook('user-prompt-submit', START + 1_000)
  await hook('notification', ASKED, 'permission_prompt')
  for (const written of transcriptWrites) await utimes(transcript, new Date(written), new Date(written))
  return { stateAt }
}

test('a permission notification, then transcript writes, then no stop: the seat is working', async () => {
  const { stateAt } = await replay([ASKED + 25_000, ASKED + 40_000])
  assert.equal(await stateAt(ASKED + 60_000), 'working')
  assert.equal(await stateAt(ASKED + 90_000), 'working')
})

test('a permission notification with the transcript quiet since: the seat is waiting for input', async () => {
  const { stateAt } = await replay([ASKED - 5_000])
  assert.equal(await stateAt(ASKED + 20_000), 'needs-input')
  assert.equal(await stateAt(ASKED + 90_000), 'needs-input')
})
