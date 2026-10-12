import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deferred, waitFor } from './timing-helpers.ts'
import * as store from '../src/store.ts'

const temp = (): Promise<string> => mkdtemp(join(tmpdir(), 'drove-store-'))
const CHILD = new URL('./p1-child.ts', import.meta.url).pathname
const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

const run = (args: string[]): Promise<number | null> =>
  new Promise(resolve => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, ...args], { stdio: 'ignore' })
    child.on('close', resolve)
  })

test('readJson returns undefined for a missing file', async () => {
  assert.equal(await store.readJson(join(await temp(), 'none.json')), undefined)
})

test('writeJsonAtomic round-trips, creates parents and uses mode 600', async () => {
  const path = join(await temp(), 'a', 'b', 'x.json')
  await store.writeJsonAtomic(path, { n: 1 })
  assert.deepEqual(await store.readJson(path), { n: 1 })
  assert.equal(await mode(path), 0o600)
  await store.writeJsonAtomic(path, { n: 2 })
  assert.deepEqual(await store.readJson(path), { n: 2 })
  assert.deepEqual((await readdir(join(path, '..'))).filter(name => name.endsWith('.tmp')), [])
})

test('a kill mid-write leaves the old file intact', async () => {
  const path = join(await temp(), 'roster.json')
  await store.writeJsonAtomic(path, { marker: 'old' })
  const writing = deferred()
  const watcher = watch(join(path, '..'), (_event, name) => {
    if (name?.endsWith('.tmp')) writing.resolve()
  })
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHILD, 'write-forever', path], { stdio: 'ignore' })
  await writing.promise
  watcher.close()
  child.kill('SIGKILL')
  await new Promise(resolve => child.once('close', resolve))
  const value = await store.readJson<{ marker: string }>(path)
  assert.ok(value?.marker === 'old' || value?.marker === 'new', 'file parses as a whole old or new value')
})

test('withLock serialises and removes the lock', async () => {
  const lock = join(await temp(), 'x.lock')
  const order: string[] = []
  const entered = deferred()
  const release = deferred()
  const slow = store.withLock(lock, async () => {
    order.push('a-start')
    entered.resolve()
    await release.promise
    order.push('a-end')
  })
  await entered.promise
  const fast = store.withLock(lock, async () => {
    order.push('b')
  })
  release.resolve()
  await Promise.all([slow, fast])
  assert.deepEqual(order, ['a-start', 'a-end', 'b'])
  await assert.rejects(stat(lock))
})

test('withLock releases the lock when the body throws', async () => {
  const lock = join(await temp(), 'x.lock')
  await assert.rejects(store.withLock(lock, async () => Promise.reject(new Error('boom'))), /boom/)
  assert.equal(await store.withLock(lock, async () => 'ok'), 'ok')
})

test('a held fresh lock blocks', async () => {
  const lock = join(await temp(), 'x.lock')
  await mkdir(lock)
  let entered = false
  const attempt = store.withLock(lock, async () => {
    entered = true
  }, 10_000, 0)
  await assert.rejects(attempt, store.LockBusy)
  assert.equal(entered, false)
  await rmdir(lock)
  await store.withLock(lock, async () => { entered = true })
  assert.equal(entered, true)
})

test('a stale lock is stolen', async () => {
  const lock = join(await temp(), 'x.lock')
  await mkdir(lock)
  const old = new Date(Date.now() - 60_000)
  await utimes(lock, old, old)
  assert.equal(await store.withLock(lock, async () => 'stolen', 10_000), 'stolen')
})

test('a lock held for 3x staleMs is kept alive by its heartbeat', async () => {
  const lock = join(await temp(), 'x.lock')
  const staleMs = 200
  let inside = 0
  let overlap = false
  const entered = deferred()
  const release = deferred()
  const first = store.withLock(lock, async () => {
    inside += 1
    entered.resolve()
    await release.promise
    inside -= 1
  }, staleMs)
  await entered.promise
  const initialMtime = (await stat(lock)).mtimeMs
  await waitFor(async () => (await stat(lock)).mtimeMs >= initialMtime + 3 * staleMs, 'three stale periods of heartbeats')
  const contenders = [1, 2].map(() => store.withLock(lock, async () => {
    inside += 1
    overlap = overlap || inside > 1
    inside -= 1
  }, staleMs))
  release.resolve()
  await Promise.all([first, ...contenders])
  assert.equal(overlap, false)
})

test('a stale-looking lock whose holder pid is alive is not stolen', async () => {
  const lock = join(await temp(), 'x.lock')
  await mkdir(lock)
  await writeFile(join(lock, 'pid'), String(process.pid))
  const old = new Date(Date.now() - 60_000)
  await utimes(lock, old, old)
  let entered = false
  const attempt = store.withLock(lock, async () => {
    entered = true
  }, 100, 0)
  await assert.rejects(attempt, store.LockBusy)
  assert.equal(entered, false)
  await rm(lock, { recursive: true })
  await store.withLock(lock, async () => { entered = true })
  assert.equal(entered, true)
})

test('a stale lock whose holder pid is dead is stolen', async () => {
  const lock = join(await temp(), 'x.lock')
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise(resolve => child.once('close', resolve))
  await mkdir(lock)
  await writeFile(join(lock, 'pid'), String(child.pid))
  const old = new Date(Date.now() - 60_000)
  await utimes(lock, old, old)
  assert.equal(await store.withLock(lock, async () => 'stolen', 10_000), 'stolen')
})

test('appendJsonl writes one line each and reads back from a cursor', async () => {
  const path = join(await temp(), 'log.jsonl')
  await store.appendJsonl(path, { n: 1 })
  await store.appendJsonl(path, { n: 2 })
  const first = await store.readJsonlFrom<{ n: number }>(path, { offset: 0 })
  assert.deepEqual(first.items, [{ n: 1 }, { n: 2 }])
  await store.appendJsonl(path, { n: 3 })
  const second = await store.readJsonlFrom<{ n: number }>(path, first.cursor)
  assert.deepEqual(second.items, [{ n: 3 }])
  const none = await store.readJsonlFrom(path, second.cursor)
  assert.deepEqual(none, { items: [], cursor: second.cursor })
  assert.equal(await mode(path), 0o600)
})

test('readJsonlFrom leaves a partial last line for the next read', async () => {
  const path = join(await temp(), 'log.jsonl')
  await writeFile(path, '{"n":1}\n{"n":')
  const first = await store.readJsonlFrom<{ n: number }>(path, { offset: 0 })
  assert.deepEqual(first.items, [{ n: 1 }])
  assert.equal(first.cursor.offset, 8)
  await writeFile(path, '{"n":1}\n{"n":2}\n')
  const second = await store.readJsonlFrom<{ n: number }>(path, first.cursor)
  assert.deepEqual(second.items, [{ n: 2 }])
})

test('readJsonlFrom skips malformed lines and tolerates a missing file', async () => {
  const dir = await temp()
  assert.deepEqual((await store.readJsonlFrom(join(dir, 'none.jsonl'), { offset: 0 })).items, [])
  const path = join(dir, 'log.jsonl')
  await writeFile(path, 'garbage\n{"n":1}\n')
  assert.deepEqual((await store.readJsonlFrom(path, { offset: 0 })).items, [{ n: 1 }])
})

test('appendJsonl refuses lines over 8 KiB', async () => {
  const path = join(await temp(), 'log.jsonl')
  await assert.rejects(store.appendJsonl(path, { pad: 'x'.repeat(9000) }), /cap is 8192/)
  await store.appendJsonl(path, { pad: 'x'.repeat(8000) })
})

test('20 concurrent child-process appends leave no torn lines', async () => {
  const path = join(await temp(), 'log.jsonl')
  const codes = await Promise.all(Array.from({ length: 20 }, (_, index) => run(['append', path, String(index)])))
  assert.deepEqual(codes, Array(20).fill(0))
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
  assert.equal(lines.length, 20 * 25)
  const parsed = lines.map(line => JSON.parse(line) as { worker: string; index: number })
  for (let worker = 0; worker < 20; worker += 1) {
    assert.deepEqual(parsed.filter(item => item.worker === String(worker)).map(item => item.index), Array.from({ length: 25 }, (_, index) => index))
  }
})

test('tokens are 64 hex, unique, and stored with mode 600', async () => {
  const token = store.mintToken()
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.notEqual(token, store.mintToken())
  const path = join(await temp(), 'seats', 'w', 'token')
  await store.writeToken(path, token)
  assert.equal(await store.readToken(path), token)
  assert.equal(await mode(path), 0o600)
  assert.equal(await store.readToken(`${path}.none`), undefined)
})

test('ensureHome creates the root with mode 700', async () => {
  const home = join(await temp(), '.drove')
  await store.ensureHome(home)
  assert.equal(await mode(home), 0o700)
})
