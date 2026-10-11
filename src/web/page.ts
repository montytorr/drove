import { TONE_COLOR } from '../board.ts'

// The whole page: inline CSS and JS, no build step. Text goes in with textContent only, so a summary can never become markup.
// Cells take their colour from --tone-* variables: the dark hues come from TONE_COLOR, the light ones are darkened below so they stay readable.

// How the page tells a feed row's kind: the cell at this index of a feed row holds it. A test pins this against the real model.
export const FEED_KIND_CELL = 5
export const NEEDS_YOU_KINDS: readonly string[] = ['question', 'asking', 'blocked', 'gone', 'failed', 'attention', 'promote']
export const REPORT_KINDS: readonly string[] = ['done', 'question', 'blocked', 'promote', 'progress']

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>drove board</title>
<style>
  :root { color-scheme: dark light; --bg: #11111b; --panel: #181825; --line: #313244; --text: #cdd6f4; --muted: #7f849c; --dim: #585b70; --good: #a6e3a1; --alert: #f38ba8; --hover: #1e1e2e;
    __TONE_VARS__ }
  @media (prefers-color-scheme: light) {
    :root { --bg: #eff1f5; --panel: #e6e9ef; --line: #ccd0da; --text: #4c4f69; --muted: #6c6f85; --dim: #7c7f93; --good: #2f7d1f; --alert: #c4143a; --hover: #e6e9ef;
      --tone-lead: #8839ef; --tone-working: #1e66f5; --tone-good: #2f7d1f; --tone-warn: #8a5a00; --tone-alert: #c4143a; --tone-muted: #6c6f85; --tone-dim: #7c7f93; --tone-text: #4c4f69; --tone-you: #b45309; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); }
  body { font: 14px/1.5 ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; padding: 16px clamp(12px, 4vw, 32px) 48px; -webkit-text-size-adjust: 100%; }
  main { max-width: 1400px; margin: 0 auto; }
  .bar { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
  .bar .left, .bar .right { display: flex; flex-wrap: wrap; gap: 0 1ch; min-width: 0; }
  .bar .left { flex: 1 1 28ch; }
  .conn { position: fixed; top: 8px; right: 8px; padding: 1px 8px; border-radius: 999px; font-size: 11px; background: var(--panel); border: 1px solid var(--line); color: var(--good); }
  .conn.off { color: var(--alert); border-color: var(--alert); }
  .conn::before { content: "●"; margin-right: 6px; }
  section { margin-top: 14px; }
  .row { display: flex; flex-wrap: wrap; gap: 0 1ch; padding: 1px 0; }
  .cell { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
  .cell.flex { flex: 1 1 24ch; }
  .cell.fixed { flex: 0 0 auto; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
  .b { font-weight: 700; }
  .note { color: var(--muted); padding: 4px 0; }
  .rule { display: flex; align-items: center; gap: 1ch; margin-top: 18px; color: var(--dim); }
  .rule::before, .rule::after { content: ""; flex: 1 1 2ch; border-top: 1px solid var(--line); }
  .rule .t { color: var(--dim); } .rule .r { color: var(--muted); overflow-wrap: anywhere; }
  .feed .row { border-top: 1px solid transparent; }
  .seat { cursor: pointer; border-radius: 3px; }
  .seat:hover, .seat:focus-visible { background: var(--hover); outline: none; }
  .seat.open { background: var(--hover); }
  .detail { margin: 2px 0 8px; padding: 8px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; }
  .detail dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0 2ch; margin: 0 0 8px; }
  .detail dt { color: var(--muted); }
  .detail dd { margin: 0; overflow-wrap: anywhere; }
  .detail .cmd { color: var(--muted); overflow-wrap: anywhere; user-select: all; }
  .detail pre { margin: 8px 0 0; padding: 8px; max-height: 40vh; overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 3px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .chip { font: inherit; font-size: 12px; padding: 1px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--muted); cursor: pointer; }
  .chip[aria-pressed="true"] { color: var(--text); border-color: var(--muted); }
  @media (max-width: 640px) {
    body { font-size: 13px; }
    .feed .row { padding: 4px 0; border-top-color: var(--line); }
    .feed .row .cell.flex { flex-basis: 100%; padding-left: 2ch; }
  }
</style>
</head>
<body>
<div id="conn" class="conn off">connecting</div>
<main id="board"><div class="note">connecting…</div></main>
<script>
(() => {
  const TONES = __TONES__
  const NEEDS_YOU = __NEEDS_YOU__
  const REPORTS = __REPORTS__
  const KIND_CELL = __KIND_CELL__
  const FILTERS = [['needs', 'needs you', NEEDS_YOU], ['reports', 'reports', REPORTS], ['all', 'all', null]]
  const TAIL_MS = 4000
  const token = new URLSearchParams(location.search).get('t') || ''
  const q = '?t=' + encodeURIComponent(token)
  const root = document.getElementById('board')
  const conn = document.getElementById('conn')

  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  const cellOf = (cell) => {
    const node = el('span', 'cell ' + (cell.width === undefined ? 'flex' : 'fixed') + (cell.isBold ? ' b' : ''), cell.text)
    node.style.color = TONES[cell.tone] || TONES.text
    if (cell.width !== undefined) node.style.width = cell.width + 'ch'
    return node
  }

  const rowOf = (row) => {
    const node = el('div', 'row')
    for (const cell of row.cells) node.append(cellOf(cell))
    return node
  }

  let data
  let openSeat = ''
  let tailText = 'reading the pane…'
  let tailTimer
  let tailBusy = false
  let filter = 'all'
  let tailEl

  const fetchTail = async () => {
    if (!openSeat || tailBusy) return
    const name = openSeat
    tailBusy = true
    try {
      const res = await fetch('/api/seat/' + encodeURIComponent(name) + '/tail' + q, { cache: 'no-store' })
      const text = await res.text()
      if (name !== openSeat) return
      tailText = res.ok ? (text.trim() ? text : '(the pane is empty)') : res.status === 404 ? 'this seat is closed' : 'could not read the pane: ' + text.trim()
    } catch (error) {
      if (name !== openSeat) return
      tailText = 'could not read the pane'
    } finally {
      tailBusy = false
    }
    if (tailEl) tailEl.textContent = tailText
  }

  const closePanel = () => {
    openSeat = ''
    clearInterval(tailTimer)
    tailTimer = undefined
    tailEl = undefined
  }

  const toggleSeat = (name) => {
    if (openSeat === name) {
      closePanel()
    } else {
      closePanel()
      openSeat = name
      tailText = 'reading the pane…'
      tailTimer = setInterval(fetchTail, TAIL_MS)
      fetchTail()
    }
    if (data) render(data)
  }

  const ageOf = (iso) => {
    const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
    if (!Number.isFinite(secs)) return '?'
    if (secs < 90) return secs + 's'
    if (secs < 5400) return Math.round(secs / 60) + 'm'
    if (secs < 172800) return Math.round(secs / 3600) + 'h'
    return Math.round(secs / 86400) + 'd'
  }

  const panelOf = (seat) => {
    const panel = el('div', 'detail')
    const list = el('dl')
    const fields = [
      ['kind', seat.kind], ['model', seat.model], ['effort', seat.effort],
      ['state', seat.state + ' for ' + ageOf(seat.stateAt)], ['branch', seat.branch], ['worktree', seat.worktree],
      ['cairn', seat.cairn || '-'], ['session', seat.sessionId || '-'], ['owes', seat.owes],
    ]
    for (const [label, value] of fields) list.append(el('dt', '', label), el('dd', '', value))
    list.append(el('dt', '', 'capture'), el('dd', 'cmd', 'drove capture ' + seat.name))
    list.append(el('dt', '', 'cd'), el('dd', 'cmd', seat.worktree))
    tailEl = el('pre', '', tailText)
    panel.append(list, tailEl)
    return panel
  }

  const seatNameOf = (row, names) => {
    for (const cell of row.cells) if (names.has(cell.text.trim())) return cell.text.trim()
    return ''
  }

  const seatRowOf = (row, seat) => {
    const node = rowOf(row)
    const isOpen = openSeat === seat.name
    node.className = 'row seat' + (isOpen ? ' open' : '')
    node.tabIndex = 0
    node.setAttribute('role', 'button')
    node.setAttribute('aria-expanded', String(isOpen))
    node.addEventListener('click', () => toggleSeat(seat.name))
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggleSeat(seat.name)
      }
    })
    return node
  }

  const kindOf = (row) => (row.cells[KIND_CELL] ? row.cells[KIND_CELL].text.trim() : '')

  const chipsOf = () => {
    const chips = el('div', 'chips')
    for (const [id, label] of FILTERS) {
      const chip = el('button', 'chip', label)
      chip.type = 'button'
      chip.setAttribute('aria-pressed', String(filter === id))
      chip.addEventListener('click', () => {
        filter = id
        if (data) render(data)
      })
      chips.append(chip)
    }
    return chips
  }

  const render = (next) => {
    data = next
    const { model, run } = data
    const seatList = data.seats || []
    const byName = new Map(seatList.map((seat) => [seat.name, seat]))
    if (openSeat && !byName.has(openSeat)) closePanel()
    const frag = document.createDocumentFragment()
    const bar = el('div', 'bar')
    const left = el('div', 'left')
    for (const cell of model.title) left.append(cellOf(cell))
    const right = el('div', 'right')
    for (const cell of model.progress) right.append(cellOf(cell))
    bar.append(left, right)
    const seats = el('section')
    seats.append(rowOf(model.lead))
    const names = new Set(byName.keys())
    for (const row of model.workers) {
      const seat = byName.get(seatNameOf(row, names))
      if (!seat) {
        seats.append(rowOf(row))
        continue
      }
      seats.append(seatRowOf(row, seat))
      if (openSeat === seat.name) seats.append(panelOf(seat))
    }
    if (model.empty) seats.append(el('div', 'note', model.empty))
    const rule = el('div', 'rule')
    rule.append(el('span', 't', model.feedTitle), el('span', 'r', run))
    const wanted = FILTERS.find(([id]) => id === filter)[2]
    const rows = wanted ? model.feed.filter((row) => wanted.includes(kindOf(row))) : model.feed
    const feed = el('section', 'feed')
    if (model.feed.length === 0) feed.append(el('div', 'note', 'Briefs, reports and verdicts appear here.'))
    else if (rows.length === 0) feed.append(el('div', 'note', 'Nothing in the feed matches this filter.'))
    for (const row of rows) feed.append(rowOf(row))
    frag.append(bar, seats, rule, chipsOf(), feed)
    root.replaceChildren(frag)
    const goal = model.title[1] ? model.title[1].text : ''
    document.title = 'drove' + (goal ? ' · ' + goal : '')
  }

  const setConn = (live) => {
    conn.textContent = live ? 'live' : 'disconnected'
    conn.className = 'conn' + (live ? '' : ' off')
  }

  let source
  let retry
  const connect = () => {
    clearTimeout(retry)
    if (source) source.close()
    source = new EventSource('/events' + q)
    source.onmessage = (event) => {
      setConn(true)
      render(JSON.parse(event.data))
    }
    source.onerror = () => {
      setConn(false)
      if (source.readyState === EventSource.CLOSED) retry = setTimeout(connect, 2000)
    }
  }
  connect()
})()
</script>
</body>
</html>
`

const TONE_VARS = Object.entries(TONE_COLOR)
  .map(([tone, color]) => `--tone-${tone}: ${color};`)
  .join(' ')
const TONE_REFS = Object.fromEntries(Object.keys(TONE_COLOR).map(tone => [tone, `var(--tone-${tone})`]))

export const pageOf = (): string =>
  PAGE.replace('__TONE_VARS__', TONE_VARS)
    .replace('__TONES__', JSON.stringify(TONE_REFS))
    .replace('__NEEDS_YOU__', JSON.stringify(NEEDS_YOU_KINDS))
    .replace('__REPORTS__', JSON.stringify(REPORT_KINDS))
    .replace('__KIND_CELL__', String(FEED_KIND_CELL))
