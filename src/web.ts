import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SPINNER, STATUS_TONE } from '../mod/hooks/board.ts'
import type { BoardModel, BoardRow, Tone } from '../mod/hooks/board.ts'
import { shortModel } from '../mod/hooks/protocol.ts'
import { isAsking, isForHuman } from '../mod/hooks/roster.ts'
import { boardSource, isAnimated, modelOf, POLL_MS } from './board.ts'
import type { BoardData, FrameInput } from './board.ts'
import { capture } from './commands.ts'
import { loadRoster, openSeats } from './roster.ts'
import type { AgentKind, Deps, Effort, Seat } from './types.ts'
import { pageOf } from './web/page.ts'

// A read-only copy of the live board for a browser: the same boardSource and modelOf the terminal board uses,
// served as JSON and pushed over Server-Sent Events. Only 127.0.0.1, only GET and HEAD, and every request needs the per-start token.
// A request that names a foreign Origin is refused. The pane tail of an open seat is read with the same call as `drove capture`.

export const WEB_HOST = '127.0.0.1'
// Wide and tall enough that buildBoard clips and drops nothing; the page wraps long cells itself.
export const WEB_COLUMNS = 400
export const WEB_ROWS = 1000
const KEEPALIVE_MS = 15_000
const TAIL_LINES = 40
const TAIL_PATH = /^\/api\/seat\/([^/]+)\/tail$/

// What the seat panel and the graph show, from the roster the board already loads. `activity` is the board row's one line of what the seat is doing
// (the spinner glyph cut off), `tone` is the colour of its state (alert while it needs you), and `needsYou` is set when it asks, is blocked or has an attention item that is a person's (the planner's own items do not count).
export type WebSeat = Pick<Seat, 'name' | 'kind' | 'model' | 'effort' | 'state' | 'stateAt' | 'branch' | 'worktree' | 'cairn' | 'sessionId' | 'owes'> & {
  modelLabel: string
  activity: string
  tone: Tone
  needsYou: boolean
}

export type WebLead = { kind: AgentKind; model: string; modelLabel: string; effort: Effort; activity: string; tone: Tone; isBusy: boolean }

// A timeline entry for the page: the board's feed without the hidden entries, so the page needs no cell parsing.
export type WebFeedEntry = { id: string; at: number; from: string; to: string; kind: string; summary: string; full?: string }

export type WebPayload = { run: string; status: string; model: BoardModel; lead: WebLead; seats: WebSeat[]; feed: WebFeedEntry[] }

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

// The cell of a board row that holds what its seat is doing: the only one without a fixed width.
const doingOf = (row: BoardRow | undefined): { text: string; tone: Tone } => {
  const cell = row?.cells.find(({ width }) => width === undefined)
  const text = (cell?.text ?? '').replace(new RegExp(`^[${SPINNER.join('')}] `), '')
  return { text, tone: cell?.tone ?? 'muted' }
}

export const webFeedOf = (feed: BoardData['feed']): WebFeedEntry[] =>
  feed
    .filter(({ isHidden }) => isHidden !== true)
    .map(({ id, at, from, to, kind, summary, full }) => ({ id: id ?? `${at}:${from}:${to}:${kind}`, at, from, to, kind, summary, ...(full === undefined ? {} : { full }) }))

export const payloadOf = (data: BoardData, now: number, offsetMinutes: number): WebPayload => {
  const input: FrameInput = { ...data, now, frame: 0, columns: WEB_COLUMNS, rows: WEB_ROWS, offsetMinutes }
  const frame = isAnimated(input) ? Math.floor(now / POLL_MS) % 1000 : 0
  const model = modelOf({ ...input, frame })
  const rows = new Map(model.workers.map(row => [row.key, row]))
  const seats = openSeats(data.roster).map((seat): WebSeat => {
    const { name, kind, model: seatModel, effort, state, stateAt, branch, worktree, cairn, sessionId, owes } = seat
    const needsYou = isAsking(seat, data.status[name]) || state === 'blocked' || seat.attention.some(isForHuman)
    return {
      name, kind, model: seatModel, effort, state, stateAt, branch, worktree, cairn, sessionId, owes,
      modelLabel: shortModel(seatModel),
      activity: doingOf(rows.get(`w:${name}`)).text,
      tone: needsYou ? 'alert' : STATUS_TONE[state],
      needsYou,
    }
  })
  const doing = doingOf(model.lead)
  const { kind, model: leadModel, effort } = data.run.planner
  const lead: WebLead = { kind, model: leadModel, modelLabel: shortModel(leadModel), effort, activity: doing.text, tone: doing.tone, isBusy: doing.tone === 'text' }
  return { run: data.run.id, status: data.run.status, model, lead, seats, feed: webFeedOf(data.feed) }
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

  const allowedOrigin = (origin: string | undefined): boolean => origin === undefined || [`http://${WEB_HOST}:${port}`, `http://localhost:${port}`].includes(origin.toLowerCase())

  const reply = (res: ServerResponse, code: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, ...SECURITY_HEADERS, ...extra })
    res.end(body)
  }

  const tail = async (res: ServerResponse, rawName: string, isHead: boolean) => {
    let name = ''
    try {
      name = decodeURIComponent(rawName)
    } catch {
      return reply(res, 404, 'text/plain', 'no such seat\n')
    }
    try {
      const seat = openSeats(await loadRoster(deps.home, run)).find(item => item.name === name)
      if (!seat) return reply(res, 404, 'text/plain', 'no such seat\n')
      const screen = await capture(deps, { run, repo: '' }, seat.name, TAIL_LINES)
      if (!screen.ok) return reply(res, 502, 'text/plain', `${screen.text}\n`)
      return reply(res, 200, 'text/plain', isHead ? '' : `${screen.text}\n`)
    } catch {
      return reply(res, 502, 'text/plain', 'could not read the pane\n')
    }
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (!allowedHost(req.headers.host)) return reply(res, 403, 'text/plain', 'forbidden host\n')
    if (!allowedOrigin(req.headers.origin)) return reply(res, 403, 'text/plain', 'forbidden origin\n')
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
    const tailed = TAIL_PATH.exec(url.pathname)
    if (tailed?.[1] !== undefined) return void tail(res, tailed[1], req.method === 'HEAD')
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
