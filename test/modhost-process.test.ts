import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { BridgeLine } from '../src/modhost.ts'
import { plannerDir } from '../src/paths.ts'
import { readJson } from '../src/store.ts'
import { fileReport, setup } from './p4-helpers.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

type Bridge = { child: ChildProcessWithoutNullStreams; lines: BridgeLine[]; exited: Promise<number | null>; waitFor: (match: (line: BridgeLine) => boolean, ms?: number) => Promise<BridgeLine> }

// PATH holds only node, so the watcher's herdr polling finds no herdr and stays out of the way.
const startBridge = (home: string, run: string, sessionId: string): Bridge => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'mod', 'bridge', '--run', run, '--session', sessionId], {
    env: { PATH: dirname(process.execPath), HOME: home, DROVE_HOME: home },
  })
  const lines: BridgeLine[] = []
  const waiters: { match: (line: BridgeLine) => boolean; resolve: (line: BridgeLine) => void }[] = []
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts.filter(Boolean)) {
      const line = JSON.parse(part) as BridgeLine
      lines.push(line)
      for (const waiter of waiters.filter(({ match }) => match(line))) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(line)
      }
    }
  })
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  const waitFor = (match: (line: BridgeLine) => boolean, ms = 10_000) =>
    new Promise<BridgeLine>((resolve, reject) => {
      const seen = lines.find(match)
      if (seen) return resolve(seen)
      const timer = setTimeout(() => reject(new Error(`no matching bridge line within ${ms} ms; saw ${lines.map(({ t }) => t).join(',')}`)), ms)
      waiters.push({ match, resolve: line => (clearTimeout(timer), resolve(line)) })
    })
  return { child, lines, exited, waitFor }
}

test('a real bridge streams the roster, wakes on a worker report, and a second bridge of the same session takes over', { timeout: 30_000 }, async () => {
  const ctx = await setup({ planner: { kind: 'claude', viaMod: true, sessionId: 's-1', paneId: 'w1:p1' } })
  const first = startBridge(ctx.home, ctx.run.id, 's-1')
  try {
    await first.waitFor(line => line.t === 'ready')
    const roster = await first.waitFor(line => line.t === 'roster')
    assert.equal(roster.t === 'roster' && roster.roster.seats[0]?.name, 'w-api')

    await fileReport(ctx, 'w-api', 'done', 'all green')
    const wake = await first.waitFor(line => line.t === 'wake')
    assert.match(wake.t === 'wake' ? wake.text : '', /\[worker w-api · done · expects review\]\nall green/)
    await first.waitFor(line => line.t === 'events' && !line.isInitial && line.events.some(event => event.type === 'report'))

    const second = startBridge(ctx.home, ctx.run.id, 's-1')
    try {
      await second.waitFor(line => line.t === 'ready')
      assert.notEqual(await first.exited, undefined)
      assert.equal((await readJson<{ pid: number }>(join(plannerDir(ctx.home, ctx.run.id), 'bridge.json')))?.pid, second.child.pid)

      const other = startBridge(ctx.home, ctx.run.id, 's-2')
      assert.deepEqual(await other.waitFor(line => line.t === 'busy' || line.t === 'fatal'), { t: 'fatal', code: 'not-attached', text: `run ${ctx.run.id} is not attached to session s-2; run drove mod attach first` })
      assert.equal(await other.exited, 2)

      second.child.kill('SIGTERM')
      assert.equal(await second.exited, 0)
      assert.equal((await readJson<{ pid: number }>(join(plannerDir(ctx.home, ctx.run.id), 'bridge.json')))?.pid, 0)
    } finally {
      second.child.kill('SIGKILL')
    }
  } finally {
    first.child.kill('SIGKILL')
  }
})
