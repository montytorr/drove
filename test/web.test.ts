import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { boardSource, feedFrom, modelOf, TONE_COLOR } from '../src/board.ts'
import { runDir, seatDir } from '../src/paths.ts'
import { saveRun } from '../src/roster.ts'
import { appendJsonl, writeJsonAtomic } from '../src/store.ts'
import type { Deps, DroveEvent, Roster, RunMeta, Seat } from '../src/types.ts'
import { pageOf } from '../src/web/page.ts'
import * as web from '../src/web.ts'
import { assertExports } from './helpers.ts'

const NOW = Date.parse('2026-10-09T10:42:00.000Z')

const RUN: RunMeta = {
  v: 1,
  id: 'drove-20261009-1000-a3f1',
  repo: '/Users/test/src/drove',
  base: 'main',
  hasRemote: false,
  createdAt: '2026-10-09T10:00:00.000Z',
  status: 'up',
  goal: 'Serve the board on localhost',
  budget: 5,
  planner: { kind: 'claude', model: 'claude-opus-5-5', effort: 'high', viaMod: false },
}

const seat = (overrides: Partial<Seat> & Pick<Seat, 'name'>): Seat => ({
  kind: 'claude',
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  worktree: `/tmp/wt/${overrides.name}`,
  branch: `drove/${overrides.name}`,
  state: 'working',
  stateAt: '2026-10-09T10:30:00.000Z',
  spawnedAt: '2026-10-09T10:00:00.000Z',
  owes: 'none',
  attention: [],
  ...overrides,
})

const ROSTER: Roster = {
  v: 1,
  run: RUN.id,
  updatedAt: '2026-10-09T10:41:00.000Z',
  seats: [
    seat({ name: 'w-core', cairn: 'DROVE-3', state: 'done', owes: 'review', lastReport: { id: 'r1', kind: 'done', expects: 'review', summary: 'core finished, 48 tests green', at: '2026-10-09T10:35:00.000Z' } }),
    seat({ name: 'w-web', cairn: 'DROVE-79', state: 'working', spawnedAt: '2026-10-09T10:03:00.000Z' }),
  ],
}

const EVENTS: DroveEvent[] = [
  { at: '2026-10-09T10:01:00.000Z', type: 'control.sent', seat: 'w-core', id: 'c1', data: { kind: 'brief' } },
  { at: '2026-10-09T10:35:00.000Z', type: 'report', seat: 'w-core', id: 'r1', data: { kind: 'done', expects: 'review', summary: 'core finished, 48 tests green' } },
]

const makeHome = async (): Promise<Deps> => {
  const home = await mkdtemp(join(tmpdir(), 'drove-web-'))
  await saveRun(home, RUN)
  await writeJsonAtomic(join(runDir(home, RUN.id), 'roster.json'), ROSTER)
  for (const event of EVENTS) await appendJsonl(join(runDir(home, RUN.id), 'events.jsonl'), event)
  mkdirSync(seatDir(home, RUN.id, 'w-web'), { recursive: true })
  await writeFile(join(seatDir(home, RUN.id, 'w-web'), 'mod.json'), JSON.stringify({ activity: 'editing src/web.ts', ctx: 40, at: '2026-10-09T10:41:00.000Z' }))
  return { home, clock: { now: () => new Date(NOW) } } as unknown as Deps
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

// node's fetch would not let a test set Host, so this speaks http directly.
const call = (port: number, path: string, { method = 'GET', host = `127.0.0.1:${port}` } = {}): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host } }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })

const withServer = async (run: (server: web.WebServer, deps: Deps) => Promise<void>, options: web.WebOptions = {}) => {
  const deps = await makeHome()
  const server = await web.startWeb(deps, RUN.id, { offsetMinutes: 0, ...options })
  try {
    await run(server, deps)
  } finally {
    await server.close()
  }
}

test('web exports its interface', () => {
  assertExports(web, ['startWeb', 'runWeb', 'payloadOf'])
})

test('the server listens on 127.0.0.1 only, on a free port, and prints a URL with a random token', async () => {
  await withServer(async server => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/)
    assert.ok(server.port > 0)
    assert.equal(server.url, `http://127.0.0.1:${server.port}/?t=${server.token}`)
  })
  const tokens = new Set<string>()
  for (let at = 0; at < 3; at += 1) await withServer(async server => void tokens.add(server.token))
  assert.equal(tokens.size, 3)
})

test('the page is one self-contained HTML document with the board colours and no external fetch', async () => {
  await withServer(async server => {
    const page = await call(server.port, `/?t=${server.token}`)
    assert.equal(page.status, 200)
    assert.match(String(page.headers['content-type']), /^text\/html/)
    assert.equal(page.headers['access-control-allow-origin'], undefined)
    assert.match(page.headers['cache-control']?.toString() ?? '', /no-store/)
    assert.match(page.body, /<style>/)
    assert.match(page.body, /EventSource\('\/events'/)
    assert.match(page.body, /disconnected/)
    assert.doesNotMatch(page.body, /<(?:script|link)[^>]+(?:src|href)=/)
    assert.doesNotMatch(page.body, /\.innerHTML/)
    for (const color of Object.values(TONE_COLOR)) assert.ok(page.body.includes(color), color)
    assert.equal(page.body, pageOf())
  })
})

test('/api/board is the model modelOf builds for the run, as JSON', async () => {
  await withServer(async (server, deps) => {
    const reply = await call(server.port, `/api/board?t=${server.token}`)
    assert.equal(reply.status, 200)
    assert.match(String(reply.headers['content-type']), /^application\/json/)
    const data = await boardSource(deps, RUN.id)()
    const expected = modelOf({ ...data, now: NOW, frame: 0, columns: web.WEB_COLUMNS, rows: web.WEB_ROWS, offsetMinutes: 0 })
    const payload = JSON.parse(reply.body) as web.WebPayload
    assert.equal(payload.run, RUN.id)
    assert.equal(payload.status, 'up')
    assert.deepEqual(payload.model, JSON.parse(JSON.stringify(expected)))
    assert.equal(payload.model.feed.length, feedFrom(EVENTS).length)
    assert.deepEqual(
      payload.model.workers.map(row => row.cells.find(cell => cell.text.startsWith('w-'))?.text),
      ['w-core', 'w-web'],
    )
  })
})

test('a Host that is not 127.0.0.1:<port> or localhost:<port> is refused, token or not', async () => {
  await withServer(async server => {
    for (const host of ['evil.example', `evil.example:${server.port}`, '127.0.0.1', `127.0.0.1:${server.port + 1}`, `localhost.evil.example:${server.port}`, `[::1]:${server.port}`]) {
      const reply = await call(server.port, `/api/board?t=${server.token}`, { host })
      assert.equal(reply.status, 403, host)
      assert.doesNotMatch(reply.body, /drove/)
    }
    assert.equal((await call(server.port, `/api/board?t=${server.token}`, { host: `localhost:${server.port}` })).status, 200)
    assert.equal((await call(server.port, `/api/board?t=${server.token}`, { host: `LOCALHOST:${server.port}` })).status, 200)
  })
})

test('a missing, empty or wrong token is refused on every route', async () => {
  await withServer(async server => {
    const wrong = server.token.replace(/./, char => (char === 'a' ? 'b' : 'a'))
    for (const path of ['/', '/api/board', '/events', '/nope']) {
      for (const query of ['', '?t=', `?t=${wrong}`, `?t=${server.token}x`, `?token=${server.token}`]) {
        const reply = await call(server.port, `${path}${query}`)
        assert.equal(reply.status, 403, `${path}${query}`)
        assert.doesNotMatch(reply.body, /orchestra|drove-2026/)
      }
    }
  })
})

test('only GET and HEAD are answered: anything else is 405, even with the token', async () => {
  await withServer(async server => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      for (const path of [`/?t=${server.token}`, `/api/board?t=${server.token}`, '/api/board']) {
        const reply = await call(server.port, path, { method })
        assert.equal(reply.status, 405, `${method} ${path}`)
        assert.equal(reply.headers.allow, 'GET, HEAD')
      }
    }
    const head = await call(server.port, `/api/board?t=${server.token}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body, '')
  })
})

test('no response carries a CORS header', async () => {
  await withServer(async server => {
    for (const path of ['/', '/api/board', '/nope']) {
      const reply = await call(server.port, `${path}?t=${server.token}`)
      assert.ok(!Object.keys(reply.headers).some(name => name.startsWith('access-control-')), path)
    }
    const refused = await call(server.port, '/api/board', { host: 'evil.example' })
    assert.ok(!Object.keys(refused.headers).some(name => name.startsWith('access-control-')))
  })
})

test('an unknown path with the token is 404', async () => {
  await withServer(async server => {
    assert.equal((await call(server.port, `/state?t=${server.token}`)).status, 404)
  })
})

const readEvents = (port: number, token: string, want: number): Promise<web.WebPayload[]> =>
  new Promise((resolve, reject) => {
    const seen: web.WebPayload[] = []
    const req = request({ host: '127.0.0.1', port, path: `/events?t=${token}`, headers: { host: `127.0.0.1:${port}` } }, res => {
      assert.match(String(res.headers['content-type']), /^text\/event-stream/)
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const data = buffer.slice(0, end).split('\n').find(line => line.startsWith('data: '))
          buffer = buffer.slice(end + 2)
          if (data) seen.push(JSON.parse(data.slice(6)) as web.WebPayload)
        }
        if (seen.length >= want) {
          req.destroy()
          resolve(seen)
        }
      })
    })
    req.on('error', error => (seen.length >= want ? undefined : reject(error)))
    req.end()
  })

test('/events sends the model at once and again when the run changes', async () => {
  await withServer(async (server, deps) => {
    const pending = readEvents(server.port, server.token, 2)
    await new Promise(resolve => setTimeout(resolve, 60))
    await appendJsonl(join(runDir(deps.home, RUN.id), 'events.jsonl'), {
      at: '2026-10-09T10:41:30.000Z',
      type: 'report',
      seat: 'w-web',
      id: 'r9',
      data: { kind: 'progress', expects: 'none', summary: 'the server is up' },
    } satisfies DroveEvent)
    const [first, second] = await pending
    assert.equal(first?.model.feed.length, feedFrom(EVENTS).length)
    assert.equal(second?.model.feed.length, feedFrom(EVENTS).length + 1)
    assert.ok(second?.model.feed.some(row => row.cells.some(cell => cell.text.includes('the server is up'))))
  }, { pollMs: 20 })
})

test('close ends open event streams and frees the port', async () => {
  const deps = await makeHome()
  const server = await web.startWeb(deps, RUN.id, { offsetMinutes: 0 })
  const stream = readEvents(server.port, server.token, 1)
  await stream
  const open = new Promise<void>(resolve => {
    const req = request({ host: '127.0.0.1', port: server.port, path: `/events?t=${server.token}`, headers: { host: `127.0.0.1:${server.port}` } }, res => {
      res.on('data', () => undefined)
      res.on('end', resolve)
      res.on('error', () => resolve())
    })
    req.on('error', () => resolve())
    req.end()
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  await server.close()
  await open
  await assert.rejects(call(server.port, `/api/board?t=${server.token}`))
  await server.close()
})

test('an unknown run fails to start, a taken port fails to listen', async () => {
  const deps = await makeHome()
  await assert.rejects(web.startWeb(deps, 'drove-19990101-0000-0000'), /unknown run/)
  const first = await web.startWeb(deps, RUN.id)
  try {
    await assert.rejects(web.startWeb(deps, RUN.id, { port: first.port }), /EADDRINUSE/)
  } finally {
    await first.close()
  }
})

test('runWeb prints the URL and stops cleanly when its signal aborts', async () => {
  const deps = await makeHome()
  const written: string[] = []
  const controller = new AbortController()
  const done = web.runWeb(deps, RUN.id, { write: text => void written.push(text), signal: controller.signal })
  await new Promise(resolve => setTimeout(resolve, 100))
  const url = /http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}/.exec(written.join(''))?.[0]
  assert.ok(url, written.join(''))
  const reply = await call(Number(new URL(url).port), `/api/board?t=${new URL(url).searchParams.get('t')}`)
  assert.equal(reply.status, 200)
  controller.abort()
  await done
  await assert.rejects(call(Number(new URL(url).port), '/api/board'))
})
