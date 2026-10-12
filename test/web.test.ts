import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clockOf } from '../mod/hooks/board.ts'
import { boardSource, feedFrom, modelOf, TONE_COLOR } from '../src/board.ts'
import { runDir, seatDir } from '../src/paths.ts'
import { saveRun } from '../src/roster.ts'
import { appendJsonl, writeJsonAtomic } from '../src/store.ts'
import type { Deps, DroveEvent, Roster, RunMeta, Seat } from '../src/types.ts'
import { CLOCK_SOURCE, KIND_ICONS, KIND_TONES, LAYOUT_SOURCE, LEAD_NAMES, NEEDS_YOU_KINDS, pageOf, PANEL_SOURCE, REPORT_KINDS } from '../src/web/page.ts'
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

const payloadOfRun = (data: Awaited<ReturnType<ReturnType<typeof boardSource>>>): web.WebPayload => web.payloadOf(data, NOW, 0)

const PANE = 'compiling src/web.ts\n<b>not markup</b>'
const execCalls: string[][] = []

// Answers every herdr call with the same pane text, in the shape `herdr agent read` prints.
const fakeExec = async (argv: readonly string[]) => {
  execCalls.push([...argv])
  return { code: 0, stdout: JSON.stringify({ result: { text: PANE } }), stderr: '' }
}

const makeHome = async (): Promise<Deps> => {
  const home = await mkdtemp(join(tmpdir(), 'drove-web-'))
  await saveRun(home, RUN)
  await writeJsonAtomic(join(runDir(home, RUN.id), 'roster.json'), ROSTER)
  for (const event of EVENTS) await appendJsonl(join(runDir(home, RUN.id), 'events.jsonl'), event)
  mkdirSync(seatDir(home, RUN.id, 'w-web'), { recursive: true })
  await writeFile(join(seatDir(home, RUN.id, 'w-web'), 'mod.json'), JSON.stringify({ activity: 'editing src/web.ts', ctx: 40, at: '2026-10-09T10:41:00.000Z' }))
  return { home, exec: fakeExec, clock: { now: () => new Date(NOW) } } as unknown as Deps
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string }

// node's fetch would not let a test set Host, so this speaks http directly.
const call = (port: number, path: string, { method = 'GET', host = `127.0.0.1:${port}`, origin }: { method?: string; host?: string; origin?: string } = {}): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = origin === undefined ? { host } : { host, origin }
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
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
    assert.deepEqual(payload.seats.map(item => item.name), ['w-core', 'w-web'])
    assert.deepEqual(payload.seats[1], {
      name: 'w-web', kind: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', state: 'working', stateAt: '2026-10-09T10:30:00.000Z',
      branch: 'drove/w-web', worktree: '/tmp/wt/w-web', cairn: 'DROVE-79', owes: 'none',
      modelLabel: 'Sonnet 5.5', activity: 'editing src/web.ts', tone: 'working', needsYou: false,
    })
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
    for (const path of ['/', '/api/board', '/events', '/nope', '/api/seat/w-web/tail']) {
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

test('a foreign Origin is refused on every route, token or not; no Origin and the page\'s own origins pass', async () => {
  await withServer(async server => {
    const own = [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`, `HTTP://LOCALHOST:${server.port}`]
    const foreign = ['http://evil.example', 'null', `http://127.0.0.1:${server.port + 1}`, `https://127.0.0.1:${server.port}`, `http://127.0.0.1.evil.example:${server.port}`, 'http://localhost']
    for (const origin of foreign) {
      for (const path of ['/', '/api/board', '/events', '/api/seat/w-web/tail', '/nope']) {
        for (const query of ['', `?t=${server.token}`]) {
          const reply = await call(server.port, `${path}${query}`, { origin })
          assert.equal(reply.status, 403, `${origin} ${path}${query}`)
          assert.doesNotMatch(reply.body, /drove-2026|compiling/)
        }
      }
      assert.equal((await call(server.port, `/api/board?t=${server.token}`, { method: 'POST', origin })).status, 403, origin)
    }
    for (const origin of own) assert.equal((await call(server.port, `/api/board?t=${server.token}`, { origin })).status, 200, origin)
    assert.equal((await call(server.port, `/api/board?t=${server.token}`)).status, 200)
  })
})

test('the tail route serves the last lines of an open seat\'s pane as plain text', async () => {
  await withServer(async server => {
    execCalls.length = 0
    const reply = await call(server.port, `/api/seat/w-web/tail?t=${server.token}`)
    assert.equal(reply.status, 200)
    assert.match(String(reply.headers['content-type']), /^text\/plain/)
    assert.match(String(reply.headers['cache-control']), /no-store/)
    assert.equal(reply.body, `${PANE}\n`)
    const read = execCalls.find(argv => argv.includes('read'))
    assert.ok(read, JSON.stringify(execCalls))
    assert.ok(read.includes('w-web-a3f1'), read.join(' '))
    assert.ok(read.includes('40'), read.join(' '))
    const head = await call(server.port, `/api/seat/w-web/tail?t=${server.token}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body, '')
    const local = await call(server.port, `/api/seat/w-web/tail?t=${server.token}`, { host: `localhost:${server.port}`, origin: `http://localhost:${server.port}` })
    assert.equal(local.status, 200)
  })
})

test('the tail route refuses a missing or wrong token, a bad Host and a foreign Origin without reading the pane', async () => {
  await withServer(async server => {
    execCalls.length = 0
    const path = '/api/seat/w-web/tail'
    assert.equal((await call(server.port, path)).status, 403)
    assert.equal((await call(server.port, `${path}?t=${server.token}x`)).status, 403)
    assert.equal((await call(server.port, `${path}?t=${server.token}`, { host: 'evil.example' })).status, 403)
    assert.equal((await call(server.port, `${path}?t=${server.token}`, { origin: 'http://evil.example' })).status, 403)
    assert.deepEqual(execCalls, [])
  })
})

test('the tail route is 404 for an unknown seat, a closed seat and a path that is not a seat tail', async () => {
  const deps = await makeHome()
  const closed = { ...ROSTER, seats: [...ROSTER.seats, seat({ name: 'w-old', state: 'closed' })] }
  await writeJsonAtomic(join(runDir(deps.home, RUN.id), 'roster.json'), closed)
  const server = await web.startWeb(deps, RUN.id, { offsetMinutes: 0 })
  try {
    execCalls.length = 0
    for (const path of ['/api/seat/w-nope/tail', '/api/seat/w-old/tail', '/api/seat/%E0%A4%A/tail', '/api/seat/w-web', '/api/seat//tail', '/api/seat/w-web/tail/x']) {
      const reply = await call(server.port, `${path}?t=${server.token}`)
      assert.equal(reply.status, 404, path)
    }
    assert.deepEqual(execCalls, [])
  } finally {
    await server.close()
  }
})

test('the tail route answers only GET and HEAD: POST is 405', async () => {
  await withServer(async server => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const reply = await call(server.port, `/api/seat/w-web/tail?t=${server.token}`, { method })
      assert.equal(reply.status, 405, method)
      assert.equal(reply.headers.allow, 'GET, HEAD')
    }
  })
})

test('a pane that cannot be read is a 502 with the reason, not a crash', async () => {
  const deps = await makeHome()
  const failing = { ...deps, exec: async () => ({ code: 1, stdout: '', stderr: 'pane_not_found' }) } as unknown as Deps
  const server = await web.startWeb(failing, RUN.id, { offsetMinutes: 0 })
  try {
    const reply = await call(server.port, `/api/seat/w-web/tail?t=${server.token}`)
    assert.equal(reply.status, 502)
    assert.match(reply.body, /could not read w-web/)
  } finally {
    await server.close()
  }
})

test('the page has the seat panel, the feed chips and a light theme, and only ever sets text', async () => {
  const page = pageOf()
  assert.match(page, /prefers-color-scheme: light/)
  assert.match(page, /\/api\/seat\//)
  assert.match(page, /clearInterval\(tailTimer\)/)
  assert.match(page, /needs you/)
  assert.doesNotMatch(page, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/)
  assert.doesNotMatch(page, /method:\s*['"](?!GET)/i)
  assert.doesNotMatch(page, /<button[^>]*>[^<]*(?:capture|cd )/i)
})

test('the payload carries the feed as structured entries, without the hidden ones', async () => {
  const deps = await makeHome()
  const more: DroveEvent[] = [
    { at: '2026-10-09T10:36:00.000Z', type: 'report', seat: 'w-web', id: 'r2', data: { kind: 'question', expects: 'answer', summary: 'which port?' } },
    { at: '2026-10-09T10:38:00.000Z', type: 'report', seat: 'w-web', id: 'r4', data: { kind: 'progress', expects: 'none', summary: 'half way' } },
  ]
  for (const event of more) await appendJsonl(join(runDir(deps.home, RUN.id), 'events.jsonl'), event)
  const data = await boardSource(deps, RUN.id)()
  const payload = payloadOfRun(data)
  assert.ok(data.feed.some(entry => entry.isHidden === true && entry.kind === 'progress'))
  assert.deepEqual(payload.feed.map(entry => entry.kind), ['brief', 'done', 'question'])
  assert.deepEqual(payload.feed.map(entry => entry.id), ['c1', 'r1', 'r2'])
  assert.deepEqual(payload.feed[1], { id: 'r1', at: Date.parse('2026-10-09T10:35:00.000Z'), from: 'w-core', to: '⌘', kind: 'done', summary: 'expects review · core finished, 48 tests green' })
  assert.deepEqual(payload.feed[0], { id: 'c1', at: Date.parse('2026-10-09T10:01:00.000Z'), from: '⌘', to: 'w-core', kind: 'brief', summary: 'brief' })
  assert.ok(payload.feed.every(entry => !('isHidden' in entry)))
  assert.deepEqual(JSON.parse(JSON.stringify(payload.feed)), payload.feed)
})

test('a full text rides on its entry; an entry with none has no full field', async () => {
  const data = await boardSource(await makeHome(), RUN.id)()
  const withFull = web.webFeedOf([...data.feed, { id: 'v1', at: 1, from: '⌘', to: 'w-web', kind: 'verdict', summary: 'approved: ok', full: 'approved: ok\nship it' }])
  assert.equal(withFull.at(-1)?.full, 'approved: ok\nship it')
  assert.ok(withFull.slice(0, -1).every(entry => !('full' in entry)))
})

test('the lead and each seat carry what the graph draws: model label, activity, state tone and whether it needs you', async () => {
  const deps = await makeHome()
  const asking = seat({ name: 'w-ask', cairn: 'DROVE-90', attention: [{ seat: 'w-ask', reason: 'dialog', detail: 'trust this folder?', at: '2026-10-09T10:40:00.000Z' }] })
  await writeJsonAtomic(join(runDir(deps.home, RUN.id), 'roster.json'), { ...ROSTER, seats: [...ROSTER.seats, asking] })
  const payload = payloadOfRun(await boardSource(deps, RUN.id)())
  assert.deepEqual(payload.lead, { kind: 'claude', model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', effort: 'high', activity: 'waiting · owes 1 review', tone: 'muted', isBusy: false })
  const by = Object.fromEntries(payload.seats.map(item => [item.name, item]))
  assert.deepEqual([by['w-core']?.tone, by['w-core']?.needsYou, by['w-core']?.activity], ['good', false, 'waiting for the planner · core finished, 48 tests green'])
  assert.deepEqual([by['w-web']?.tone, by['w-web']?.needsYou, by['w-web']?.activity], ['working', false, 'editing src/web.ts'])
  assert.deepEqual([by['w-ask']?.tone, by['w-ask']?.needsYou, by['w-ask']?.cairn], ['alert', true, 'DROVE-90'])
  assert.doesNotMatch(payload.seats.map(item => item.activity).join('\n'), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
})

test('DROVE-122: a seat\'s last check run rides on its payload as one line, stale once HEAD has moved, and the board row carries the marker', async () => {
  const deps = await makeHome()
  const run = { sha: 'abcdef0123456789', clean: true, at: '2026-10-09T10:40:00.000Z' }
  const seats = [
    seat({ name: 'w-ok', checks: { ...run, result: 'passed' } }),
    seat({ name: 'w-bad', checks: { ...run, result: 'failed', failed: 'npm test' } }),
    seat({ name: 'w-old', checks: { ...run, result: 'passed', stale: true } }),
    seat({ name: 'w-none' }),
  ]
  await writeJsonAtomic(join(runDir(deps.home, RUN.id), 'roster.json'), { ...ROSTER, seats })
  const payload = payloadOfRun(await boardSource(deps, RUN.id)())
  const by = Object.fromEntries(payload.seats.map(item => [item.name, item]))
  assert.equal(by['w-ok']?.checks, 'passed at abcdef0')
  assert.equal(by['w-bad']?.checks, 'failed: npm test at abcdef0')
  assert.equal(by['w-old']?.checks, 'stale: passed at abcdef0, HEAD has moved')
  assert.equal('checks' in (by['w-none'] ?? {}), false)
  const marks = payload.model.workers.map(row => row.cells.find(cell => cell.text.startsWith('chk'))?.text)
  assert.deepEqual(marks.filter(Boolean).sort(), ['chk~', 'chk✓', 'chk✗'])
  assert.match(pageOf(), /seat\.checks/)
})

test('the timeline time is HH:MM whole, in the viewer\'s offset, and matches the terminal board\'s', () => {
  const clockText = (0, eval)(CLOCK_SOURCE) as (at: number, offsetMinutes: number) => string
  assert.equal(clockText(Date.parse('2026-10-09T10:42:00.000Z'), 0), '10:42')
  assert.equal(clockText(Date.parse('2026-10-10T00:35:09.000Z'), 0), '00:35')
  assert.equal(clockText(Date.parse('2026-10-10T00:35:09.000Z'), -120), '02:35')
  assert.equal(clockText(Date.parse('2026-10-10T00:05:00.000Z'), 300), '19:05')
  for (const at of [0, 1_760_000_000_000, NOW, NOW + 7 * 60_000 + 59_000]) {
    for (const offset of [0, -120, 300, -330]) {
      assert.match(clockText(at, offset), /^\d\d:\d\d$/)
      assert.equal(clockText(at, offset), clockOf(at, offset))
    }
  }
  assert.ok(pageOf().includes(`const clockText = ${CLOCK_SOURCE}`))
})

type Box = { x: number; y: number; w: number; h: number }
type Spot = { height: number; lead: Box; seats: Box[]; routes: number[][][] }
const layoutOf = (0, eval)(LAYOUT_SOURCE) as (count: number, width: number) => Spot
const apart = (a: Box, b: Box): boolean => Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2

test('the graph layout keeps every box inside the card and apart, from no seat to 8, at any width', () => {
  for (const width of [360, 430, 500, 640, 720, 800, 960, 1200]) {
    for (let count = 0; count <= 8; count += 1) {
      const spot = layoutOf(count, width)
      const where = `${count} seats at ${width}px`
      assert.equal(spot.seats.length, count, where)
      assert.equal(spot.routes.length, count, where)
      const boxes = [spot.lead, ...spot.seats]
      boxes.forEach((box, at) => {
        assert.ok(box.x - box.w / 2 >= -0.5 && box.x + box.w / 2 <= width + 0.5, `${where}: box ${at} leaves the card sideways`)
        assert.ok(box.y - box.h / 2 >= -0.5 && box.y + box.h / 2 <= spot.height + 0.5, `${where}: box ${at} leaves the card vertically`)
        for (const other of boxes.slice(at + 1)) assert.ok(apart(box, other), `${where}: boxes overlap`)
      })
      assert.ok(spot.height <= 700, where)
    }
  }
})

test('one seat sits beside the lead at 90 px or more, in a card no taller than its nodes need; two sit on opposite sides', () => {
  for (const width of [560, 640, 720, 800, 1000]) {
    const spot = layoutOf(1, width)
    const seat = spot.seats[0] as Box
    assert.ok(seat.x - spot.lead.x - (spot.lead.w + seat.w) / 2 >= 90, `edge too short at ${width}px`)
    assert.equal(seat.y, spot.lead.y)
    assert.equal(spot.lead.y, spot.height / 2)
    assert.ok(spot.height <= 200, `${spot.height}px tall at ${width}px`)
    assert.ok(Math.abs((spot.lead.x - spot.lead.w / 2) - (width - (seat.x + seat.w / 2))) < 1, 'the pair is centred')
  }
  const wide = layoutOf(1, 800)
  assert.ok((wide.seats[0] as Box).x - wide.lead.x - (wide.lead.w + (wide.seats[0] as Box).w) / 2 >= 180)
  for (const width of [720, 1000]) {
    const spot = layoutOf(2, width)
    const [left, right] = spot.seats as [Box, Box]
    assert.ok(Math.min(left.x, right.x) < spot.lead.x && Math.max(left.x, right.x) > spot.lead.x, `${width}px`)
    assert.equal(left.y, right.y)
    assert.equal(spot.lead.y, spot.height / 2)
  }
})

test('a narrow card puts the lead on top and the seats below it, with a longer edge for one or two', () => {
  const one = layoutOf(1, 360)
  assert.ok((one.seats[0] as Box).y > one.lead.y + one.lead.h)
  assert.ok((one.seats[0] as Box).y - (one.seats[0] as Box).h / 2 - (one.lead.y + one.lead.h / 2) >= 90)
  const many = layoutOf(6, 360)
  assert.ok(many.seats.every(seat => seat.y > many.lead.y))
})

test('the feed chips read the structured kind, and the page uses the same lists', async () => {
  const deps = await makeHome()
  const more: DroveEvent[] = [
    { at: '2026-10-09T10:36:00.000Z', type: 'report', seat: 'w-web', id: 'r2', data: { kind: 'question', expects: 'answer', summary: 'which port?' } },
    { at: '2026-10-09T10:37:00.000Z', type: 'report', seat: 'w-web', id: 'r3', data: { kind: 'blocked', expects: 'answer', summary: 'no token' } },
    { at: '2026-10-09T10:39:00.000Z', type: 'control.sent', seat: 'w-web', id: 'c2', data: { kind: 'verdict', verdict: 'approved' } },
  ]
  for (const event of more) await appendJsonl(join(runDir(deps.home, RUN.id), 'events.jsonl'), event)
  const payload = payloadOfRun(await boardSource(deps, RUN.id)())
  const kinds = payload.feed.map(entry => entry.kind)
  assert.deepEqual(kinds, ['brief', 'done', 'question', 'blocked', 'verdict'])
  assert.deepEqual(kinds.filter(kind => NEEDS_YOU_KINDS.includes(kind)), ['question', 'blocked'])
  assert.deepEqual(kinds.filter(kind => REPORT_KINDS.includes(kind)), ['done', 'question', 'blocked'])
  const page = pageOf()
  assert.ok(page.includes(`const NEEDS_YOU = ${JSON.stringify(NEEDS_YOU_KINDS)}`))
  assert.ok(page.includes(`const REPORTS = ${JSON.stringify(REPORT_KINDS)}`))
  assert.ok(page.includes(`const KIND_TONE = ${JSON.stringify(KIND_TONES)}`))
  assert.ok(page.includes(`const KIND_ICON = ${JSON.stringify(KIND_ICONS)}`))
  assert.ok(page.includes(`const LEAD_NAMES = ${JSON.stringify(LEAD_NAMES)}`))
  assert.doesNotMatch(page, /KIND_CELL|cells\[/)
})

test('message colours: reports green, questions and blocked amber, verdicts violet, briefs blue', () => {
  for (const kind of ['done', 'answered']) assert.equal(KIND_TONES[kind], 'good')
  for (const kind of ['question', 'asking', 'blocked']) assert.equal(KIND_TONES[kind], 'warn')
  assert.equal(KIND_TONES.verdict, 'lead')
  assert.equal(KIND_TONES.brief, 'working')
  for (const tone of Object.values(KIND_TONES)) assert.ok(tone in TONE_COLOR, tone)
  assert.ok(LEAD_NAMES.includes('⌘'))
})

test('the page has the graph view, the Graph | Board switch it remembers, and the one-line timeline', () => {
  const page = pageOf()
  assert.match(page, /class="graph"|el\('div', 'graph'\)/)
  assert.match(page, /\['graph', 'Graph'\], \['board', 'Board'\]/)
  assert.match(page, /localStorage\.getItem\(VIEW_KEY\)/)
  assert.match(page, /localStorage\.setItem\(VIEW_KEY/)
  assert.match(page, /const VIEW_KEY = 'drove\.board\.view'/)
  assert.match(page, /prefers-reduced-motion: reduce/)
  assert.match(page, /createElementNS\(SVG_NS/)
  assert.match(page, /aria-expanded/)
  assert.match(page, /text-overflow: ellipsis/)
  assert.match(page, /@keyframes pulse/)
  assert.match(page, /\.bar \{ display: grid/)
  assert.match(page, /\.bar \.goal \{[^}]*text-overflow: ellipsis/)
  assert.doesNotMatch(page, /\.conn \{[^}]*position: (?:fixed|absolute)/)
  assert.match(page, /\.detail pre \{[^}]*max-height: 292px/)
  assert.match(page, /const settle = /)
  assert.match(page, /target\.pre\.scrollTop = target\.stick \? target\.pre\.scrollHeight : target\.top/)
  assert.match(page, /event\.key === 'Enter' \|\| event\.key === ' '/)
  assert.doesNotMatch(page, /<script[^>]+src=|@import|url\(/)
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
    assert.equal(first?.feed.length, feedFrom(EVENTS).length)
    assert.equal(second?.feed.length, feedFrom(EVENTS).length)
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

test('DROVE-108: only a person\'s attention is "needs you": the planner\'s items, and the notices they leave in the feed, are not', async () => {
  const deps = await makeHome()
  const planners = ['idle-without-report', 'stalled', 'budget', 'pending-delivery'] as const
  const withItem = (name: string, reason: Seat['attention'][number]['reason']) => seat({ name, attention: [{ seat: name, reason, detail: 'd', at: '2026-10-09T10:40:00.000Z' }] })
  const seats = [...planners.map(reason => withItem(`w-${reason}`, reason)), withItem('w-dialog', 'dialog'), withItem('w-limit', 'usage-limit')]
  await writeJsonAtomic(join(runDir(deps.home, RUN.id), 'roster.json'), { ...ROSTER, seats: [...ROSTER.seats, ...seats] })
  for (const reason of [...planners, 'dialog']) await appendJsonl(join(runDir(deps.home, RUN.id), 'events.jsonl'), { at: '2026-10-09T10:41:00.000Z', type: 'attention', seat: `w-${reason}`, data: { reason, detail: 'd' } })
  const payload = payloadOfRun(await boardSource(deps, RUN.id)())
  const needs = payload.seats.filter(item => item.needsYou).map(item => item.name)
  assert.deepEqual(needs, ['w-dialog', 'w-limit'])
  const attention = payload.feed.filter(entry => entry.kind === 'attention' || entry.kind === 'notice')
  assert.deepEqual(attention.map(entry => [entry.kind, entry.to]), [...planners.map(() => ['notice', '⌘']), ['attention', 'Human']])
  assert.ok(!NEEDS_YOU_KINDS.includes('notice'))
  assert.ok(KIND_TONES.notice && KIND_ICONS.notice)
})

type Tail = { text: string; readAt: number; stale: boolean; reason: string }
type PanelKit = {
  threadOf: (feed: web.WebFeedEntry[], name: string, size?: number) => web.WebFeedEntry[]
  specOf: (seat: Partial<web.WebSeat>) => string
  shortId: (id: string | undefined) => string
  tailAfter: (prev: Tail, read: { ok: boolean; status: number; text: string }, now: number) => Tail
}
const panelKit = (0, eval)(PANEL_SOURCE) as PanelKit

test('DROVE-115: each seat carries its latest report for the panel, its time in epoch ms; a seat with none has no field', async () => {
  const payload = payloadOfRun(await boardSource(await makeHome(), RUN.id)())
  const by = Object.fromEntries(payload.seats.map(item => [item.name, item]))
  assert.deepEqual(by['w-core']?.lastReport, { kind: 'done', expects: 'review', summary: 'core finished, 48 tests green', at: Date.parse('2026-10-09T10:35:00.000Z') })
  assert.ok(by['w-web'] && !('lastReport' in by['w-web']))
})

test('DROVE-115: the seat thread is the entries to or from that seat only, newest first, six at most', () => {
  const entry = (id: string, from: string, to: string): web.WebFeedEntry => ({ id, at: Number(id.slice(1)), from, to, kind: 'message', summary: id })
  const feed = [entry('e1', '⌘', 'w-a'), entry('e2', 'w-a', '⌘'), entry('e3', '⌘', 'w-ab'), entry('e4', 'w-b', '⌘'), entry('e5', 'w-a', 'Human')]
  assert.deepEqual(panelKit.threadOf(feed, 'w-a').map(item => item.id), ['e5', 'e2', 'e1'])
  assert.deepEqual(panelKit.threadOf(feed, 'w-zz'), [])
  const long = Array.from({ length: 9 }, (_, at) => entry(`e${at + 1}`, '⌘', 'w-a'))
  assert.deepEqual(panelKit.threadOf(long, 'w-a').map(item => item.id), ['e9', 'e8', 'e7', 'e6', 'e5', 'e4'])
  assert.deepEqual(panelKit.threadOf(long, 'w-a', 2).map(item => item.id), ['e9', 'e8'])
})

test('DROVE-115: the panel spec line is kind · model · effort and its model is never blank', () => {
  assert.equal(panelKit.specOf({ kind: 'claude', model: 'claude-sonnet-5-5', modelLabel: 'Sonnet 5.5', effort: 'medium' }), 'claude · claude-sonnet-5-5 · medium')
  assert.equal(panelKit.specOf({ kind: 'codex', model: '', modelLabel: 'default', effort: 'high' }), 'codex · default · high')
  assert.equal(panelKit.specOf({ kind: 'codex', model: '', modelLabel: '', effort: 'high' }), 'codex · default · high')
  assert.equal(panelKit.shortId('3f2a9c1e-7b4d-4c1a-9e2f-0a1b2c3d4e5f'), '3f2a9c1e…')
  assert.equal(panelKit.shortId('abc'), 'abc')
  assert.equal(panelKit.shortId(undefined), '')
})

test('DROVE-115: a failed pane read keeps the last good text and marks it stale; before any good read it shows the reason', () => {
  const first: Tail = { text: 'reading the pane…', readAt: 0, stale: false, reason: '' }
  const good = panelKit.tailAfter(first, { ok: true, status: 200, text: 'compiling\n\n  \n' }, 1000)
  assert.deepEqual(good, { text: 'compiling', readAt: 1000, stale: false, reason: '' })
  const failed = panelKit.tailAfter(good, { ok: false, status: 502, text: 'could not read w-a: agent_not_idle\n' }, 5000)
  assert.deepEqual(failed, { text: 'compiling', readAt: 1000, stale: true, reason: 'could not read w-a: agent_not_idle' })
  assert.deepEqual(panelKit.tailAfter(failed, { ok: false, status: 0, text: '' }, 9000), { text: 'compiling', readAt: 1000, stale: true, reason: 'could not read the pane' })
  assert.deepEqual(panelKit.tailAfter(failed, { ok: true, status: 200, text: 'next' }, 9000), { text: 'next', readAt: 9000, stale: false, reason: '' })
  assert.deepEqual(panelKit.tailAfter(first, { ok: false, status: 502, text: 'pane_not_found' }, 1000), { text: 'pane_not_found', readAt: 0, stale: false, reason: 'pane_not_found' })
  assert.equal(panelKit.tailAfter(good, { ok: true, status: 200, text: ' \n' }, 2000).text, '(the pane is empty)')
  assert.equal(panelKit.tailAfter(good, { ok: false, status: 404, text: 'no such seat' }, 2000).text, 'this seat is closed')
})

test('DROVE-115: the page panel has a header with a close button, copyable fields, the thread and a pane fold it remembers', () => {
  const page = pageOf()
  assert.match(page, /const panelKit = \(\(\) => \{/)
  assert.match(page, /el\('button', 'x', '×'\)/)
  assert.match(page, /event\.key === 'Escape' && openSeat\) dismiss\(\)/)
  assert.match(page, /navigator\.clipboard\.writeText/)
  assert.match(page, /const owes = seat\.owes && seat\.owes !== 'none' \? seat\.owes : ''/)
  assert.match(page, /'waiting for the planner: ' \+ owes/)
  assert.match(page, /el\('details', 'pane'\)/)
  assert.match(page, /const PANE_KEY = 'drove\.board\.pane'/)
  assert.match(page, /try \{\n\s+return localStorage\.getItem\(PANE_KEY\)/)
  assert.match(page, /try \{\n\s+localStorage\.setItem\(PANE_KEY/)
  assert.match(page, /'stale · last read '/)
  assert.doesNotMatch(page, /drove capture|\['cd'|'cd'\)/)
  assert.doesNotMatch(page, /__PANEL__/)
})
