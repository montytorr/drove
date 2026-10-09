import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type Cursor = { offset: number }

export const LINE_MAX_BYTES = 8192
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

export const withLock = async <T>(lockDir: string, body: () => Promise<T>, staleMs = 10_000): Promise<T> => {
  await ensureDir(dirname(lockDir))
  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error
      await stealIfStale(lockDir, staleMs)
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

export const readJsonlFrom = async <T>(path: string, cursor: Cursor): Promise<{ items: T[]; cursor: Cursor }> => {
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
    for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        items.push(JSON.parse(line) as T)
      } catch {
        continue
      }
    }
    return { items, cursor: { offset: cursor.offset + end } }
  } finally {
    await handle.close()
  }
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
