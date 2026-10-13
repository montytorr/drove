import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type Cursor = { offset: number }

export const LINE_MAX_BYTES = 8192
// What a worker's report may take of a line: Drove adds its own lines to a report (steering, autocheck) and wraps it in the ledger.
export const REPORT_MAX_BYTES = LINE_MAX_BYTES - 2048
const LOCK_POLL_MS = 20
const HEARTBEAT_MS = 2000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

export const ensureDir = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 })
}

export const ensureHome = async (home: string): Promise<void> => {
  await ensureDir(home)
  await chmod(home, 0o700)
}

export const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined
    throw error
  }
}

const writeAtomic = async (path: string, text: string, mode: number): Promise<void> => {
  await ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const handle = await open(tmp, 'w', mode)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(tmp, { force: true })
    throw error
  }
  await handle.close()
  try {
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

export const writeJsonAtomic = async (path: string, value: unknown, mode = 0o600): Promise<void> => {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return codeOf(error) === 'EPERM'
  }
}

const holderIsAlive = async (lockDir: string): Promise<boolean> => {
  const pid = Number.parseInt(await readFile(join(lockDir, 'pid'), 'utf8').catch(() => ''), 10)
  return Number.isInteger(pid) && pid > 0 && isAlive(pid)
}

const stealIfStale = async (lockDir: string, staleMs: number): Promise<void> => {
  const info = await stat(lockDir).catch(() => undefined)
  if (!info || Date.now() - info.mtimeMs <= staleMs) return
  if (await holderIsAlive(lockDir)) return
  const recheck = await stat(lockDir).catch(() => undefined)
  if (!recheck || recheck.mtimeMs !== info.mtimeMs) return
  const aside = `${lockDir}.stale.${process.pid}.${randomBytes(4).toString('hex')}`
  await rename(lockDir, aside).then(() => rm(aside, { recursive: true, force: true }), () => undefined)
}

export class LockBusy extends Error {
  constructor(lockDir: string) {
    super(`${lockDir} is held by someone else`)
  }
}

// `giveUpMs` turns the wait into a try: a lock still held after that long throws LockBusy instead of waiting out a steal.
export const withLock = async <T>(lockDir: string, body: () => Promise<T>, staleMs = 10_000, giveUpMs?: number): Promise<T> => {
  await ensureDir(dirname(lockDir))
  const started = Date.now()
  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
      await stealIfStale(lockDir, staleMs)
      if (giveUpMs !== undefined && Date.now() - started >= giveUpMs) throw new LockBusy(lockDir)
      await sleep(LOCK_POLL_MS)
    }
  }
  await writeFile(join(lockDir, 'pid'), String(process.pid)).catch(() => undefined)
  const heartbeat = setInterval(() => {
    const now = new Date()
    utimes(lockDir, now, now).catch(() => undefined)
  }, Math.min(HEARTBEAT_MS, Math.max(10, staleMs / 4)))
  try {
    return await body()
  } finally {
    clearInterval(heartbeat)
    await rm(lockDir, { recursive: true, force: true })
  }
}

// The bytes `value` takes as a jsonl line, its newline included.
export const jsonlBytes = (value: unknown): number => Buffer.byteLength(`${JSON.stringify(value)}\n`)

// The longest start of `text` that is at most `maxBytes` of UTF-8, never cut inside a character.
export const clipUtf8 = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = Math.max(0, Math.floor(maxBytes))
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

export const appendJsonl = async (path: string, value: unknown): Promise<void> => {
  const line = Buffer.from(`${JSON.stringify(value)}\n`)
  if (line.length > LINE_MAX_BYTES) throw new Error(`jsonl line is ${line.length} bytes, the cap is ${LINE_MAX_BYTES}`)
  await ensureDir(dirname(path))
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.write(line, 0, line.length)
  } finally {
    await handle.close()
  }
}

// `ends[i]` is the offset just past the line of `items[i]`, for a reader that moves its cursor one item at a time.
export const readJsonlFrom = async <T>(path: string, cursor: Cursor): Promise<{ items: T[]; cursor: Cursor; ends?: number[] }> => {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return { items: [], cursor }
    throw error
  }
  try {
    const { size } = await handle.stat()
    if (size <= cursor.offset) return { items: [], cursor }
    const buffer = Buffer.alloc(size - cursor.offset)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset)
    const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1
    if (end === 0) return { items: [], cursor }
    const items: T[] = []
    const ends: number[] = []
    let start = 0
    while (start < end) {
      const stop = buffer.indexOf(0x0a, start) + 1
      const line = buffer.subarray(start, stop).toString('utf8')
      start = stop
      if (!line.trim()) continue
      try {
        items.push(JSON.parse(line) as T)
        ends.push(cursor.offset + stop)
      } catch {
        continue
      }
    }
    return { items, cursor: { offset: cursor.offset + end }, ends }
  } finally {
    await handle.close()
  }
}

// The last `bytes` of a jsonl file, for a reader that needs only what is recent (the line the cut lands in is dropped).
export const readJsonlTail = async <T>(path: string, bytes: number): Promise<T[]> => {
  const size = await stat(path).then(info => info.size, () => 0)
  return (await readJsonlFrom<T>(path, { offset: Math.max(0, size - bytes) })).items
}

export const mintToken = (): string => randomBytes(32).toString('hex')

export const writeToken = async (path: string, token: string): Promise<void> => {
  await writeAtomic(path, token, 0o600)
}

export const readToken = async (path: string): Promise<string | undefined> => {
  try {
    return (await readFile(path, 'utf8')).trim() || undefined
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined
    throw error
  }
}
