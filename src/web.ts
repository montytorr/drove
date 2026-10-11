import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BoardModel } from '../mod/hooks/board.ts'
import { boardSource, isAnimated, modelOf, POLL_MS } from './board.ts'
import type { BoardData, FrameInput } from './board.ts'
import type { Deps } from './types.ts'
import { pageOf } from './web/page.ts'

// A read-only copy of the live board for a browser: the same boardSource and modelOf the terminal board uses,
// served as JSON and pushed over Server-Sent Events. Only 127.0.0.1, only GET and HEAD, and every request needs the per-start token.

export const WEB_HOST = '127.0.0.1'
// Wide and tall enough that buildBoard clips and drops nothing; the page wraps long cells itself.
export const WEB_COLUMNS = 400
export const WEB_ROWS = 1000
const KEEPALIVE_MS = 15_000

export type WebPayload = { run: string; status: string; model: BoardModel }

export type WebServer = {
  url: string
  port: number
  token: string
  close: () => Promise<void>
}

export type WebOptions = { port?: number; pollMs?: number; offsetMinutes?: number }

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
}

const sameToken = (given: string | null, token: string): boolean => {
  const a = Buffer.from(given ?? '')
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const payloadOf = (data: BoardData, now: number, offsetMinutes: number): WebPayload => {
  const input: FrameInput = { ...data, now, frame: 0, columns: WEB_COLUMNS, rows: WEB_ROWS, offsetMinutes }
  const frame = isAnimated(input) ? Math.floor(now / POLL_MS) % 1000 : 0
  return { run: data.run.id, status: data.run.status, model: modelOf({ ...input, frame }) }
}

export const startWeb = async (deps: Deps, run: string, options: WebOptions = {}): Promise<WebServer> => {
  const load = boardSource(deps, run)
  const offsetOf = (now: number) => options.offsetMinutes ?? new Date(now).getTimezoneOffset()
  const token = randomBytes(16).toString('hex')
  const clients = new Set<ServerResponse>()
  const build = (data: BoardData): string => {
    const now = deps.clock.now().getTime()
    return JSON.stringify(payloadOf(data, now, offsetOf(now)))
  }

  let current = build(await load())
  let port = 0

  const refresh = async () => {
    try {
      const next = build(await load())
      if (next === current) return
      current = next
      for (const client of clients) client.write(`data: ${next}\n\n`)
    } catch {
      // The run's files are being rewritten; keep showing the last good model.
    }
  }

  const allowedHost = (host: string | undefined): boolean => host !== undefined && [`${WEB_HOST}:${port}`, `localhost:${port}`].includes(host.toLowerCase())

  const reply = (res: ServerResponse, code: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, ...SECURITY_HEADERS, ...extra })
    res.end(body)
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (!allowedHost(req.headers.host)) return reply(res, 403, 'text/plain', 'forbidden host\n')
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'text/plain', 'read only\n', { allow: 'GET, HEAD' })
    const url = new URL(req.url ?? '/', `http://${WEB_HOST}:${port}`)
    if (!sameToken(url.searchParams.get('t'), token)) return reply(res, 403, 'text/plain', 'missing or wrong token\n')
    if (url.pathname === '/') return reply(res, 200, 'text/html', pageOf())
    if (url.pathname === '/api/board') return reply(res, 200, 'application/json', current)
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', ...SECURITY_HEADERS })
      if (req.method === 'HEAD') return res.end()
      res.write(`retry: 1000\ndata: ${current}\n\n`)
      clients.add(res)
      res.on('close', () => clients.delete(res))
      return
    }
    return reply(res, 404, 'text/plain', 'not found\n')
  }

  const server: Server = createServer(handle)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, WEB_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port

  const poll = setInterval(() => void refresh(), options.pollMs ?? POLL_MS)
  const keepalive = setInterval(() => {
    for (const client of clients) client.write(': keepalive\n\n')
  }, KEEPALIVE_MS)

  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= new Promise<void>(resolve => {
      clearInterval(poll)
      clearInterval(keepalive)
      server.close(() => resolve())
      for (const client of clients) client.end()
      server.closeAllConnections()
    })
    return closing
  }

  return { url: `http://${WEB_HOST}:${port}/?t=${token}`, port, token, close }
}

// Serve until Ctrl-C (or the signal aborts), then close and return.
export const runWeb = async (deps: Deps, run: string, options: WebOptions & { signal?: AbortSignal; write: (text: string) => void }): Promise<void> => {
  const server = await startWeb(deps, run, options)
  options.write(`drove board for ${run}\n${server.url}\nread-only, 127.0.0.1 only; Ctrl-C to stop\n`)
  const controller = new AbortController()
  const stop = () => controller.abort()
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal])
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await server.close()
  }
}
